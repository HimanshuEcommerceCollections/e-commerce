package com.nexuscommerce.order.service;

import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.payment.PaymentGateway;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

/**
 * Releases stock held by abandoned checkouts. Checkout decrements stock BEFORE
 * payment, so a PENDING_PAYMENT order whose customer walked away holds reserved
 * units forever — this job cancels such orders (and their PaymentIntents) after
 * a configurable age.
 *
 * <p>Provider-aware: runs only when the active {@link PaymentGateway} supports
 * automatic expiry (Stripe). Manual-gateway orders legitimately rest in
 * PENDING_PAYMENT until an admin confirms them and are never expired.
 *
 * <p>Safe with multiple instances by construction — the per-order atomic claim
 * in {@link OrderExpiryService} means duplicate scans are harmless. Add a
 * scheduler lock (ShedLock) only if scan volume itself becomes a problem.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PendingOrderExpiryJob {

    private final OrderRepository orderRepository;
    private final OrderExpiryService expiryService;
    private final PaymentGateway paymentGateway;

    @Value("${app.order.pending-expiry-minutes:30}")
    private long expiryMinutes;

    @Scheduled(fixedDelayString = "${app.order.expiry-check-interval-ms:60000}")
    public void expireAbandonedOrders() {
        if (expiryMinutes <= 0 || !paymentGateway.supportsAutomaticExpiry()) {
            return;
        }

        Instant cutoff = Instant.now().minus(expiryMinutes, ChronoUnit.MINUTES);
        List<Order> stale = orderRepository
                .findTop50ByStatusAndDeletedFalseAndCreatedAtBefore(OrderStatus.PENDING_PAYMENT, cutoff);

        int expired = 0;
        for (Order order : stale) {
            try {
                if (expiryService.expire(order.getId())) {
                    expired++;
                }
            } catch (Exception e) {
                // One bad order (e.g. gateway hiccup) must not block the batch.
                log.error("Failed to expire order {}", order.getOrderNumber(), e);
            }
        }
        if (expired > 0) {
            log.info("Expired {} abandoned pending order(s)", expired);
        }
    }
}
