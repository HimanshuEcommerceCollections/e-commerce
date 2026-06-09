package com.nexuscommerce.order.dto;

/**
 * Result of placing an order. Wraps the created order together with the payment
 * provider's {@code clientSecret}, which the client uses to confirm the charge in
 * the browser/app.
 *
 * <p>{@code clientSecret} is returned <em>only</em> here, at checkout time — it is
 * never persisted on the order, so later {@code GET /api/orders/{id}} reads never
 * expose it. It is {@code null} under the manual gateway (nothing to confirm
 * in-app) and populated by Stripe.
 *
 * @param order        the placed order
 * @param clientSecret opaque secret for client-side payment confirmation ({@code null} for manual)
 */
public record CheckoutResponse(
        OrderResponse order,
        String clientSecret
) {
    public static CheckoutResponse of(OrderResponse order, String clientSecret) {
        return new CheckoutResponse(order, clientSecret);
    }
}
