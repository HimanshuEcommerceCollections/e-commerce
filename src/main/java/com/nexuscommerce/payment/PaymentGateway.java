package com.nexuscommerce.payment;

/**
 * Abstraction over a payment provider. The order flow depends only on this
 * interface, never on a concrete provider, so Stripe can be slotted in later by
 * adding a new implementation without touching checkout.
 *
 * <p>The current implementation is {@link ManualPaymentGateway} (orders rest in
 * PENDING_PAYMENT until confirmed out-of-band). A future {@code StripePaymentGateway}
 * will return a {@code clientSecret} and confirm asynchronously via webhook.
 */
public interface PaymentGateway {

    /**
     * Begin collecting payment for an order.
     *
     * @param request gateway-agnostic charge instruction
     * @return the initial payment state and any client-side secret/reference
     */
    PaymentInitiation initiate(PaymentRequest request);
}
