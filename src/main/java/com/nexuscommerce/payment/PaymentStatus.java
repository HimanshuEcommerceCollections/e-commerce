package com.nexuscommerce.payment;

/**
 * Lifecycle of a payment, independent of the concrete gateway (manual today,
 * Stripe later). Persisted on the order via {@code @Enumerated(STRING)}.
 */
public enum PaymentStatus {
    /** Awaiting capture — e.g. manual confirmation, or a Stripe PaymentIntent not yet succeeded. */
    PENDING,
    /** Funds captured successfully. */
    SUCCEEDED,
    /** Capture failed or was declined. */
    FAILED,
    /** Previously succeeded, then refunded (in full or in part). */
    REFUNDED
}
