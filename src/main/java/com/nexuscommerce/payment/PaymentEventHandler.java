package com.nexuscommerce.payment;

/**
 * Callback the payment module invokes when a provider reports the outcome of a
 * previously-initiated payment (e.g. from a verified Stripe webhook). The order
 * module supplies the implementation, so the dependency still runs one way —
 * order depends on payment, never the reverse — mirroring {@link PaymentGateway}.
 *
 * <p>Implementations must be idempotent: webhooks are delivered at-least-once, so
 * the same outcome may be reported more than once for the same intent.
 */
public interface PaymentEventHandler {

    /**
     * A previously-initiated payment succeeded.
     *
     * @param paymentIntentId gateway PaymentIntent id
     * @param amountMinor     amount the provider actually captured, in minor units —
     *                        implementations must validate it against the order total
     *                        before marking anything paid
     * @param currency        ISO-4217 currency the provider captured in
     */
    void confirmPaymentByIntent(String paymentIntentId, long amountMinor, String currency);

    /**
     * A payment attempt failed or was declined. NOT terminal: the customer can
     * retry the same PaymentIntent, so implementations must only record the
     * attempt — never cancel the order or release reserved stock. Stock release
     * for abandoned orders is the expiry job's responsibility (which also cancels
     * the intent so it cannot succeed afterwards).
     */
    void recordPaymentFailureByIntent(String paymentIntentId);

    /**
     * The PaymentIntent was cancelled at the provider (by the expiry job, or
     * out-of-band from the dashboard). Terminal for that intent — the order can
     * never be paid through it. Must be a no-op if the order is already cancelled
     * (the expiry job's own cancel triggers this event).
     */
    void cancelPaymentByIntent(String paymentIntentId);

    /**
     * Money went back to the customer (our own refund-on-cancel confirming, or a
     * refund issued out-of-band from the provider dashboard). This is the
     * reconciliation source of truth for refunds: implementations make the order
     * reflect it idempotently.
     *
     * @param amountRefundedMinor cumulative amount refunded so far, minor units
     */
    void recordRefundByIntent(String paymentIntentId, long amountRefundedMinor, String currency);
}
