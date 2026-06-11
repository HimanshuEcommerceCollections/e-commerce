package com.nexuscommerce.payment;

import java.math.BigDecimal;
import java.util.Optional;

/**
 * Abstraction over a payment provider. The order flow depends only on this
 * interface, never on a concrete provider — {@link ManualPaymentGateway} and
 * {@link StripePaymentGateway} are selected by {@code app.payment.provider}.
 */
public interface PaymentGateway {

    /**
     * Begin collecting payment for an order.
     *
     * @param request gateway-agnostic charge instruction
     * @return the initial payment state and any client-side secret/reference
     */
    PaymentInitiation initiate(PaymentRequest request);

    /**
     * Refund a previously captured payment in full.
     *
     * @param paymentReference the gateway reference stored at initiation
     *                         (Stripe PaymentIntent id / manual reference)
     * @param amount           amount to return, major units
     * @param currency         ISO-4217 currency of the original charge
     * @return the gateway's refund reference, for logs/reconciliation
     * @throws PaymentGatewayException if the provider rejects or cannot be reached —
     *         callers must not change order state when this is thrown
     */
    String refund(String paymentReference, BigDecimal amount, String currency);

    /**
     * Cancel an uncaptured payment so it can never be confirmed later (used when
     * an order is cancelled or expires before payment).
     *
     * @return {@code true} if the payment is cancelled (or already was);
     *         {@code false} if it can no longer be cancelled because it is
     *         processing or already succeeded — the caller should back off and
     *         let the success webhook win
     * @throws PaymentGatewayException for transport/provider errors
     */
    boolean cancelPayment(String paymentReference);

    /**
     * Re-fetch the client-side confirmation secret for a still-pending payment.
     * Used by idempotent checkout replay: the secret is deliberately never
     * persisted, so a replayed response re-reads it from the provider.
     *
     * @return the secret, or empty when the provider has none (manual gateway)
     */
    Optional<String> findClientSecret(String paymentReference);

    /**
     * Whether orders initiated through this gateway may be auto-cancelled by the
     * pending-payment expiry job. Stripe payments abandon silently and hold
     * reserved stock, so they expire; manual-gateway orders legitimately wait
     * for an admin and must not.
     */
    default boolean supportsAutomaticExpiry() {
        return false;
    }

    /**
     * Whether an operator may confirm payment by hand (the admin mark-paid
     * endpoint). True only for the manual gateway: a provider that reports
     * outcomes itself must never be overridden — the order would read PAID with
     * no money captured, and the provider's real success event would then be
     * ignored.
     */
    default boolean supportsManualConfirmation() {
        return true;
    }
}
