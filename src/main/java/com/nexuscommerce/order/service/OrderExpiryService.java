package com.nexuscommerce.order.service;

import com.nexuscommerce.order.entity.CancellationActor;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderItem;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.payment.PaymentGateway;
import com.nexuscommerce.product.repository.ProductRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Expires a single abandoned PENDING_PAYMENT order. Separate from the scanning
 * job so each order gets its own transaction — one failure never blocks the
 * rest of the batch.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderExpiryService {

    private final OrderRepository orderRepository;
    private final ProductRepository productRepository;
    private final PaymentGateway paymentGateway;

    /**
     * Cancel-and-restock one stale order, in this strict sequence:
     * <ol>
     *   <li>cancel the PaymentIntent at the gateway FIRST — if the provider says
     *       the payment is processing/succeeded, skip entirely and let the
     *       success webhook win (the customer paid at the last moment);</li>
     *   <li>atomically claim the order (status guard) — only the claim winner
     *       restocks, which keeps a concurrent webhook/second instance from
     *       double-restocking.</li>
     * </ol>
     *
     * @return true if this call expired the order
     */
    @Transactional
    public boolean expire(UUID orderId) {
        Order order = orderRepository.findByIdAndDeletedFalse(orderId).orElse(null);
        if (order == null || order.getStatus() != OrderStatus.PENDING_PAYMENT) {
            return false;
        }

        if (order.getPaymentIntentId() != null
                && !paymentGateway.cancelPayment(order.getPaymentIntentId())) {
            log.info("Skipping expiry of order {} — payment is completing at the provider",
                    order.getOrderNumber());
            return false;
        }

        // Snapshot lines before the claim; only the claim winner may restock.
        List<OrderItem> items = List.copyOf(order.getItems());
        int claimed = orderRepository.claimPendingCancellation(
                orderId, "Expired before payment", CancellationActor.SYSTEM_EXPIRY);
        if (claimed == 0) {
            return false;
        }

        items.forEach(item ->
                productRepository.incrementStock(item.getProductId(), item.getQuantity()));
        log.info("Expired abandoned order {} and released its stock", order.getOrderNumber());
        return true;
    }
}
