package com.nexuscommerce.order;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.exception.OutOfStockException;
import com.nexuscommerce.order.service.CheckoutCoordinator;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.testsupport.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Two customers race for the last unit: the atomic conditional decrement must
 * let exactly one checkout through, and the loser's whole transaction (order +
 * decrement) must roll back.
 */
class StockRaceIT extends IntegrationTest {

    @Autowired private CheckoutCoordinator checkoutCoordinator;

    @Test
    void onlyOneOfTwoConcurrentCheckoutsGetsTheLastUnit() throws Exception {
        Product lastUnit = newActiveProduct(1, "99.00");

        record Buyer(UUID userId, CheckoutRequest request) {}
        Buyer[] buyers = new Buyer[2];
        for (int i = 0; i < 2; i++) {
            User user = newCustomer();
            addToCart(user.getId(), lastUnit.getId(), 1);
            buyers[i] = new Buyer(user.getId(), new CheckoutRequest(newAddress(user.getId()).getId()));
        }

        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger succeeded = new AtomicInteger();
        AtomicInteger outOfStock = new AtomicInteger();
        try {
            Future<?>[] futures = new Future<?>[2];
            for (int i = 0; i < 2; i++) {
                Buyer buyer = buyers[i];
                futures[i] = pool.submit(() -> {
                    start.await();
                    try {
                        checkoutCoordinator.checkout(buyer.userId(), buyer.request(), null);
                        succeeded.incrementAndGet();
                    } catch (OutOfStockException e) {
                        outOfStock.incrementAndGet();
                    }
                    return null;
                });
            }
            start.countDown();
            for (Future<?> future : futures) {
                future.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(succeeded.get()).isEqualTo(1);
        assertThat(outOfStock.get()).isEqualTo(1);
        assertThat(stockOf(lastUnit.getId())).isZero();
    }
}
