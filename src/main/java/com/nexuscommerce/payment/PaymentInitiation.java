package com.nexuscommerce.payment;

/**
 * Result of asking a {@link PaymentGateway} to begin collecting payment for an order.
 *
 * @param status       initial payment status (e.g. {@code PENDING} for manual/Stripe-async flows)
 * @param reference    gateway-side reference for reconciliation (a generated id today,
 *                     a Stripe PaymentIntent id later) — may be {@code null}
 * @param clientSecret opaque secret the client uses to complete payment in the browser/app
 *                     (always {@code null} for the manual gateway; populated by Stripe later)
 */
public record PaymentInitiation(
        PaymentStatus status,
        String reference,
        String clientSecret
) {}
