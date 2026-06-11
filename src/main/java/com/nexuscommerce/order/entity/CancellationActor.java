package com.nexuscommerce.order.entity;

/**
 * Who cancelled an order. Recorded alongside {@code cancellationReason} so every
 * CANCELLED order is auditable.
 */
public enum CancellationActor {
    /** The customer, via POST /api/orders/{id}/cancel. */
    CUSTOMER,
    /** An operator (admin tooling — Phase 2). */
    ADMIN,
    /** The pending-payment expiry job: abandoned before payment, stock released. */
    SYSTEM_EXPIRY,
    /** Reported by the payment provider (intent cancelled / refunded out-of-band). */
    GATEWAY
}
