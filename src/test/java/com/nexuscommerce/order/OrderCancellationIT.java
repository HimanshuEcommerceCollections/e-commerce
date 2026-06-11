package com.nexuscommerce.order;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.entity.CancellationActor;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.exception.InvalidOrderStateException;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.order.service.CheckoutCoordinator;
import com.nexuscommerce.order.service.OrderService;
import com.nexuscommerce.payment.PaymentGateway;
import com.nexuscommerce.payment.PaymentStatus;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.testsupport.IntegrationTest;
import com.nexuscommerce.testsupport.RecordingPaymentGateway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

import java.math.BigDecimal;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Customer cancellation against a scriptable gateway: paid orders refund before
 * cancelling, unpaid orders kill their PaymentIntent first.
 */
class OrderCancellationIT extends IntegrationTest {

    @TestConfiguration(proxyBeanMethods = false)
    static class GatewayConfig {
        @Bean
        @Primary
        RecordingPaymentGateway recordingPaymentGateway() {
            return new RecordingPaymentGateway();
        }
    }

    @Autowired private CheckoutCoordinator checkoutCoordinator;
    @Autowired private OrderService orderService;
    @Autowired private OrderRepository orderRepository;
    @Autowired private PaymentGateway gateway;

    private RecordingPaymentGateway recording() {
        return (RecordingPaymentGateway) gateway;
    }

    @AfterEach
    void resetGateway() {
        recording().cancellable = true;
    }

    private record Placed(UUID userId, UUID orderId, String intentId, UUID productId) {}

    private Placed placeOrder() {
        User user = newCustomer();
        Product product = newActiveProduct(10, "25.00");
        addToCart(user.getId(), product.getId(), 2);
        CheckoutResponse response = checkoutCoordinator.checkout(
                user.getId(), new CheckoutRequest(newAddress(user.getId()).getId()), null);
        Order order = orderRepository.findById(response.order().id()).orElseThrow();
        return new Placed(user.getId(), order.getId(), order.getPaymentIntentId(), product.getId());
    }

    @Test
    void cancellingAnUnpaidOrderKillsItsPaymentIntent() {
        Placed placed = placeOrder();

        orderService.cancel(placed.userId(), placed.orderId());

        Order order = orderRepository.findById(placed.orderId()).orElseThrow();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        assertThat(order.getCancelledBy()).isEqualTo(CancellationActor.CUSTOMER);
        assertThat(stockOf(placed.productId())).isEqualTo(10);
        assertThat(recording().cancelledReferences).contains(placed.intentId());
        assertThat(recording().refunds).isEmpty();
    }

    @Test
    void cancellingAPaidOrderRefundsTheFullAmountFirst() {
        Placed placed = placeOrder();
        orderService.markPaid(placed.orderId());

        orderService.cancel(placed.userId(), placed.orderId());

        Order order = orderRepository.findById(placed.orderId()).orElseThrow();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        assertThat(order.getPaymentStatus()).isEqualTo(PaymentStatus.REFUNDED);
        assertThat(stockOf(placed.productId())).isEqualTo(10);
        assertThat(recording().refunds).hasSize(1);
        RecordingPaymentGateway.RefundCall refund = recording().refunds.get(0);
        assertThat(refund.paymentReference()).isEqualTo(placed.intentId());
        assertThat(refund.amount()).isEqualByComparingTo(new BigDecimal("50.00"));
        assertThat(refund.currency()).isEqualTo("USD");
    }

    @Test
    void replayOfACancelledOrderReturnsItWithoutAClientSecret() {
        User user = newCustomer();
        Product product = newActiveProduct(5, "10.00");
        addToCart(user.getId(), product.getId(), 1);
        String key = "key-" + java.util.UUID.randomUUID();
        CheckoutRequest request = new CheckoutRequest(newAddress(user.getId()).getId());

        CheckoutResponse placed = checkoutCoordinator.checkout(user.getId(), request, key);
        // Pending replay re-fetches the confirmation secret from the gateway.
        assertThat(checkoutCoordinator.checkout(user.getId(), request, key).clientSecret())
                .isEqualTo("test-client-secret");

        orderService.cancel(user.getId(), placed.order().id());

        // Terminal replay: same order back, but no secret — the client must
        // start a fresh checkout under a new key.
        CheckoutResponse terminal = checkoutCoordinator.checkout(user.getId(), request, key);
        assertThat(terminal.order().orderNumber()).isEqualTo(placed.order().orderNumber());
        assertThat(terminal.order().status().name()).isEqualTo("CANCELLED");
        assertThat(terminal.clientSecret()).isNull();
    }

    @Test
    void cancellationIsRefusedWhilePaymentIsCompleting() {
        Placed placed = placeOrder();
        recording().cancellable = false;

        assertThatThrownBy(() -> orderService.cancel(placed.userId(), placed.orderId()))
                .isInstanceOf(InvalidOrderStateException.class);

        Order order = orderRepository.findById(placed.orderId()).orElseThrow();
        assertThat(order.getStatus()).isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(stockOf(placed.productId())).isEqualTo(8);
    }
}
