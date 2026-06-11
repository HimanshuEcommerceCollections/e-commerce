package com.nexuscommerce.order;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.entity.CancellationActor;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.order.service.CheckoutCoordinator;
import com.nexuscommerce.order.service.OrderService;
import com.nexuscommerce.payment.PaymentAmountMismatchException;
import com.nexuscommerce.payment.PaymentStatus;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.testsupport.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The order module's PaymentEventHandler contract — what verified gateway
 * events (Stripe webhooks) do to an order. Total in every test: 2 × $25.00 =
 * $50.00 = 5000 minor units.
 */
class PaymentEventsIT extends IntegrationTest {

    @Autowired private CheckoutCoordinator checkoutCoordinator;
    @Autowired private OrderService orderService;
    @Autowired private OrderRepository orderRepository;

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

    private Order reload(UUID orderId) {
        return orderRepository.findById(orderId).orElseThrow();
    }

    @Test
    void successWithMatchingAmountMarksPaid() {
        Placed placed = placeOrder();

        orderService.confirmPaymentByIntent(placed.intentId(), 5000, "usd");

        Order order = reload(placed.orderId());
        assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);
        assertThat(order.getPaymentStatus()).isEqualTo(PaymentStatus.SUCCEEDED);
    }

    @Test
    void successWithWrongAmountThrowsAndLeavesTheOrderUnpaid() {
        Placed placed = placeOrder();

        assertThatThrownBy(() -> orderService.confirmPaymentByIntent(placed.intentId(), 4999, "usd"))
                .isInstanceOf(PaymentAmountMismatchException.class);
        assertThatThrownBy(() -> orderService.confirmPaymentByIntent(placed.intentId(), 5000, "eur"))
                .isInstanceOf(PaymentAmountMismatchException.class);

        assertThat(reload(placed.orderId()).getStatus()).isEqualTo(OrderStatus.PENDING_PAYMENT);
    }

    @Test
    void failedAttemptIsRecordedButNotTerminal() {
        Placed placed = placeOrder();
        assertThat(stockOf(placed.productId())).isEqualTo(8);

        orderService.recordPaymentFailureByIntent(placed.intentId());

        Order order = reload(placed.orderId());
        // Still payable: no cancel, no restock — the customer can retry.
        assertThat(order.getStatus()).isEqualTo(OrderStatus.PENDING_PAYMENT);
        assertThat(order.getPaymentStatus()).isEqualTo(PaymentStatus.FAILED);
        assertThat(order.getLastPaymentFailureAt()).isNotNull();
        assertThat(stockOf(placed.productId())).isEqualTo(8);

        // The retried attempt succeeds.
        orderService.confirmPaymentByIntent(placed.intentId(), 5000, "usd");
        assertThat(reload(placed.orderId()).getStatus()).isEqualTo(OrderStatus.PAID);
    }

    @Test
    void cancelledIntentCancelsAndRestocksExactlyOnce() {
        Placed placed = placeOrder();
        assertThat(stockOf(placed.productId())).isEqualTo(8);

        orderService.cancelPaymentByIntent(placed.intentId());
        orderService.cancelPaymentByIntent(placed.intentId()); // redelivery — no-op

        Order order = reload(placed.orderId());
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        assertThat(order.getCancelledBy()).isEqualTo(CancellationActor.GATEWAY);
        assertThat(stockOf(placed.productId())).isEqualTo(10);
    }

    @Test
    void fullRefundReconcilesAPaidOrder() {
        Placed placed = placeOrder();
        orderService.confirmPaymentByIntent(placed.intentId(), 5000, "usd");

        orderService.recordRefundByIntent(placed.intentId(), 5000, "usd");

        Order order = reload(placed.orderId());
        assertThat(order.getPaymentStatus()).isEqualTo(PaymentStatus.REFUNDED);
        assertThat(order.getStatus()).isEqualTo(OrderStatus.CANCELLED);
        assertThat(order.getCancelledBy()).isEqualTo(CancellationActor.GATEWAY);
        assertThat(stockOf(placed.productId())).isEqualTo(10);
    }

    @Test
    void partialRefundIsLoggedButChangesNothing() {
        Placed placed = placeOrder();
        orderService.confirmPaymentByIntent(placed.intentId(), 5000, "usd");

        orderService.recordRefundByIntent(placed.intentId(), 1000, "usd");

        Order order = reload(placed.orderId());
        assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);
        assertThat(order.getPaymentStatus()).isEqualTo(PaymentStatus.SUCCEEDED);
        assertThat(stockOf(placed.productId())).isEqualTo(8);
    }

    @Test
    void eventsForUnknownIntentsAreIgnored() {
        orderService.confirmPaymentByIntent("pi_unknown", 1, "usd");
        orderService.recordPaymentFailureByIntent("pi_unknown");
        orderService.cancelPaymentByIntent("pi_unknown");
        orderService.recordRefundByIntent("pi_unknown", 1, "usd");
        // No exception: unknown intents are logged and acknowledged.
    }
}
