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

    /** A previously-initiated payment succeeded, identified by its gateway PaymentIntent id. */
    void confirmPaymentByIntent(String paymentIntentId);

    /** A previously-initiated payment failed or was declined, identified by its gateway PaymentIntent id. */
    void failPaymentByIntent(String paymentIntentId);
}
