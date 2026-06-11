package com.nexuscommerce.order;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.exception.EmptyCartException;
import com.nexuscommerce.order.exception.IdempotencyKeyConflictException;
import com.nexuscommerce.order.exception.InvalidIdempotencyKeyException;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.order.service.CheckoutCoordinator;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.testsupport.IntegrationTest;
import com.nexuscommerce.user.address.entity.UserAddress;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CheckoutIdempotencyIT extends IntegrationTest {

    @Autowired private CheckoutCoordinator checkoutCoordinator;
    @Autowired private OrderRepository orderRepository;

    @Test
    void sameKeyReplaysTheExistingOrderInsteadOfCreatingASecondOne() {
        User user = newCustomer();
        UserAddress address = newAddress(user.getId());
        Product product = newActiveProduct(10, "25.00");
        addToCart(user.getId(), product.getId(), 2);
        CheckoutRequest request = new CheckoutRequest(address.getId());
        String key = "key-" + UUID.randomUUID();

        CheckoutResponse first = checkoutCoordinator.checkout(user.getId(), request, key);
        CheckoutResponse replay = checkoutCoordinator.checkout(user.getId(), request, key);

        assertThat(replay.order().orderNumber()).isEqualTo(first.order().orderNumber());
        assertThat(orderRepository.findByUserIdAndIdempotencyKeyAndDeletedFalse(user.getId(), key)).isPresent();
        // Stock decremented exactly once: the replay did not run checkout again.
        assertThat(stockOf(product.getId())).isEqualTo(8);
    }

    @Test
    void sameKeyWithDifferentRequestIsRejected() {
        User user = newCustomer();
        UserAddress address = newAddress(user.getId());
        UserAddress otherAddress = newAddress(user.getId(), false);
        Product product = newActiveProduct(5, "10.00");
        addToCart(user.getId(), product.getId(), 1);
        String key = "key-" + UUID.randomUUID();

        checkoutCoordinator.checkout(user.getId(), new CheckoutRequest(address.getId()), key);

        assertThatThrownBy(() -> checkoutCoordinator.checkout(
                user.getId(), new CheckoutRequest(otherAddress.getId()), key))
                .isInstanceOf(IdempotencyKeyConflictException.class);
    }

    @Test
    void malformedKeyIsRejectedBeforeAnyWork() {
        User user = newCustomer();
        UserAddress address = newAddress(user.getId());

        assertThatThrownBy(() -> checkoutCoordinator.checkout(
                user.getId(), new CheckoutRequest(address.getId()), "not valid!!"))
                .isInstanceOf(InvalidIdempotencyKeyException.class);
    }

    @Test
    void twoConcurrentCheckoutsWithTheSameKeyProduceOneOrder() throws Exception {
        User user = newCustomer();
        UserAddress address = newAddress(user.getId());
        Product product = newActiveProduct(10, "25.00");
        addToCart(user.getId(), product.getId(), 2);
        CheckoutRequest request = new CheckoutRequest(address.getId());
        String key = "key-" + UUID.randomUUID();

        var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        var start = new java.util.concurrent.CountDownLatch(1);
        try {
            java.util.concurrent.Callable<CheckoutResponse> attempt = () -> {
                start.await();
                return checkoutCoordinator.checkout(user.getId(), request, key);
            };
            var first = pool.submit(attempt);
            var second = pool.submit(attempt);
            start.countDown();

            CheckoutResponse a = first.get(30, java.util.concurrent.TimeUnit.SECONDS);
            CheckoutResponse b = second.get(30, java.util.concurrent.TimeUnit.SECONDS);

            // Both callers get a response, both for the SAME order.
            assertThat(a.order().orderNumber()).isEqualTo(b.order().orderNumber());
        } finally {
            pool.shutdownNow();
        }

        // One order row, one stock decrement — the loser's transaction rolled back.
        assertThat(orderRepository.findByUserIdAndIdempotencyKeyAndDeletedFalse(user.getId(), key)).isPresent();
        assertThat(stockOf(product.getId())).isEqualTo(8);
    }

    @Test
    void withoutAKeyARetryFindsTheCartAlreadyConsumed() {
        User user = newCustomer();
        UserAddress address = newAddress(user.getId());
        Product product = newActiveProduct(5, "10.00");
        addToCart(user.getId(), product.getId(), 1);
        CheckoutRequest request = new CheckoutRequest(address.getId());

        checkoutCoordinator.checkout(user.getId(), request, null);

        // Unkeyed behaviour is unchanged: the first checkout consumed the cart.
        assertThatThrownBy(() -> checkoutCoordinator.checkout(user.getId(), request, null))
                .isInstanceOf(EmptyCartException.class);
    }
}
