package com.nexuscommerce.order.repository;

import com.nexuscommerce.order.entity.CancellationActor;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface OrderRepository extends JpaRepository<Order, UUID> {

    /** Owner-scoped lookup — a customer may only read their own orders. */
    Optional<Order> findByIdAndUserIdAndDeletedFalse(UUID id, UUID userId);

    /** Unscoped lookup for admin/system operations (e.g. manual payment confirmation). */
    Optional<Order> findByIdAndDeletedFalse(UUID id);

    /** Unscoped lookup used by the Stripe webhook to reconcile an event to its order. */
    Optional<Order> findByPaymentIntentIdAndDeletedFalse(String paymentIntentId);

    Page<Order> findByUserIdAndDeletedFalseOrderByCreatedAtDesc(UUID userId, Pageable pageable);

    boolean existsByOrderNumber(String orderNumber);

    /** Idempotent-checkout replay lookup (uniq_orders_user_idempotency_key backs this). */
    Optional<Order> findByUserIdAndIdempotencyKeyAndDeletedFalse(UUID userId, String idempotencyKey);

    /** Stale-order scan for the pending-payment expiry job (idx_orders_status_created_at). */
    List<Order> findTop50ByStatusAndDeletedFalseAndCreatedAtBefore(OrderStatus status, Instant cutoff);

    // ── Atomic state transitions ────────────────────────────────────────────
    // Every transition that releases stock or confirms money is a guarded bulk
    // UPDATE whose WHERE clause is the race arbiter: exactly one of any set of
    // concurrent writers (customer cancel, webhook, expiry job, admin, second
    // instance) gets 1 back, and only that caller may apply the side effect —
    // restocking twice corrupts inventory, and a blind entity flush could
    // silently overwrite a concurrent transition (Order has no @Version).
    // clearAutomatically evicts stale entities so post-claim re-reads hit the DB.

    /** Claim PENDING_PAYMENT → CANCELLED. Winner (and only the winner) restocks. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("""
            UPDATE Order o
               SET o.status = com.nexuscommerce.order.entity.OrderStatus.CANCELLED,
                   o.cancellationReason = :reason,
                   o.cancelledBy = :actor
             WHERE o.id = :id
               AND o.status = com.nexuscommerce.order.entity.OrderStatus.PENDING_PAYMENT
               AND o.deleted = false
            """)
    int claimPendingCancellation(@Param("id") UUID id,
                                 @Param("reason") String reason,
                                 @Param("actor") CancellationActor actor);

    /**
     * Claim a paid, unshipped order's cancellation+refund transition
     * (PAID|CONFIRMED → CANCELLED, payment → REFUNDED). Winner restocks. Used by
     * both customer cancel-with-refund and the charge.refunded reconciliation,
     * so the two can never double-restock each other.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("""
            UPDATE Order o
               SET o.status = com.nexuscommerce.order.entity.OrderStatus.CANCELLED,
                   o.paymentStatus = com.nexuscommerce.payment.PaymentStatus.REFUNDED,
                   o.cancellationReason = :reason,
                   o.cancelledBy = :actor
             WHERE o.id = :id
               AND o.status IN (com.nexuscommerce.order.entity.OrderStatus.PAID,
                                com.nexuscommerce.order.entity.OrderStatus.CONFIRMED)
               AND o.paymentStatus <> com.nexuscommerce.payment.PaymentStatus.REFUNDED
               AND o.deleted = false
            """)
    int claimRefundCancellation(@Param("id") UUID id,
                                @Param("reason") String reason,
                                @Param("actor") CancellationActor actor);

    /**
     * Record a refund on an already-CANCELLED order (its stock was returned by
     * whichever path cancelled it) — no restock with this claim.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("""
            UPDATE Order o
               SET o.paymentStatus = com.nexuscommerce.payment.PaymentStatus.REFUNDED
             WHERE o.id = :id
               AND o.status = com.nexuscommerce.order.entity.OrderStatus.CANCELLED
               AND o.paymentStatus <> com.nexuscommerce.payment.PaymentStatus.REFUNDED
               AND o.deleted = false
            """)
    int markRefundedOnCancelled(@Param("id") UUID id);

    /** Claim PENDING_PAYMENT → PAID for the admin manual-confirmation path. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("""
            UPDATE Order o
               SET o.status = com.nexuscommerce.order.entity.OrderStatus.PAID,
                   o.paymentStatus = com.nexuscommerce.payment.PaymentStatus.SUCCEEDED
             WHERE o.id = :id
               AND o.status = com.nexuscommerce.order.entity.OrderStatus.PENDING_PAYMENT
               AND o.deleted = false
            """)
    int claimManualPaid(@Param("id") UUID id);
}
