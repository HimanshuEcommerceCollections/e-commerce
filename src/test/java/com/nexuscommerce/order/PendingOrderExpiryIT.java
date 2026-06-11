package com.nexuscommerce.order;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.entity.CancellationActor;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.order.service.CheckoutCoordinator;
import com.nexuscommerce.order.service.OrderExpiryService;
import com.nexuscommerce.order.service.PendingOrderExpiryJob;
import com.nexuscommerce.payment.PaymentGateway;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.testsupport.IntegrationTest;
import com.nexuscommerce.testsupport.RecordingPaymentGateway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The abandoned-order expiry path: stale PENDING_PAYMENT orders are cancelled
 * (intent first, then an atomic claim) and their reserved stock released.
 */
class PendingOrderExpiryIT extends IntegrationTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class GatewayConfig {
        @Bean
        @Primary
        RecordingPaymentGateway recordingPaymentGateway() {
            return new RecordingPaymentGateway();
        }
    }

    @Autowired private CheckoutCoordinator checkoutCoordinator;
    @Autowired private OrderExpiryService expiryService;
    @Autowired private PendingOrderExpiryJob expiryJob;
    @Autowired private OrderRepository orderRepository;
    @Autowired private PaymentGateway gateway;
    @Autowired private JdbcTemplate jdbc;

    private RecordingPaymentGateway recording() {
        return (RecordingPaymentGateway) gateway;
    }

    @AfterEach
    void resetGateway() {
        recording().cancellable = true;
        recording().supportsExpiry = true;
    }

    private record Placed(UUID orderId, String intentId, UUID productId) {}

    private Placed placeOrder() {
        User user = newCustomer();
        Product product = newActiveProduct(10, "25.00");
        addToCart(user.getId(), product.getId(), 2);
        CheckoutResponse response = checkoutCoordinator.checkout(
                user.getId(), new CheckoutRequest(newAddress(user.getId()).getId()), null);
        Order order = orderRepository.findById(response.order().id()).orElseThrow();
        return new Placed(order.getId(), order.getPaymentIntentId(), product.getId());
    }

    private void backdate(UUID orderId) {
        jdbc.update("UPDATE orders SET created_at = now() - interval '2 hours' WHERE id = ?", orderId);
    }

    @Test
    void theJobExpiresStaleOrdersAndReleasesTheirStock() {
        Placed placed = placeOrder();
        assertThat(stockOf(placed.productId())).isEqualTo(8);
        backdate(placed.orderId());

        expiryJob.expireAbandonedOrders();

        Order order = orderRepository.findById(placed.orderId()).orElseThrow();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        assertThat(order.getCancelledBy()).isEqualTo(CancellationActor.SYSTEM_EXPIRY);
        assertThat(order.getCancellationReason()).isEqualTo("Expired before payment");
        assertThat(stockOf(placed.productId())).isEqualTo(10);
        assertThat(recording().cancelledReferences).contains(placed.intentId());

        // Idempotent: a second pass restocks nothing.
        expiryJob.expireAbandonedOrders();
        assertThat(stockOf(placed.productId())).isEqualTo(10);
    }

    @Test
    void freshOrdersAreNotTouched() {
        Placed placed = placeOrder();

        expiryJob.expireAbandonedOrders();

        assertThat(orderRepository.findById(placed.orderId()).orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(stockOf(placed.productId())).isEqualTo(8);
    }

    @Test
    void expirySkipsWhenThePaymentIsCompletingAtTheProvider() {
        Placed placed = placeOrder();
        backdate(placed.orderId());
        recording().cancellable = false;

        boolean expired = expiryService.expire(placed.orderId());

        assertThat(expired).isFalse();
        assertThat(orderRepository.findById(placed.orderId()).orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(stockOf(placed.productId())).isEqualTo(8);
    }

    @Test
    void theJobIsInertWhenTheGatewayDoesNotSupportExpiry() {
        Placed placed = placeOrder();
        backdate(placed.orderId());
        recording().supportsExpiry = false;

        expiryJob.expireAbandonedOrders();

        // Manual-gateway semantics: orders legitimately wait for an admin.
        assertThat(orderRepository.findById(placed.orderId()).orElseThrow().getStatus())
                .isEqualTo(OrderStatus.PENDING_PAYMENT);
    }
}
