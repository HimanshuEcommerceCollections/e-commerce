package com.nexuscommerce.order.entity;

/**
 * Order lifecycle. Payment-agnostic so the same states apply whether payment is
 * collected manually (today) or via Stripe (later).
 *
 * <p>Typical happy path:
 * {@code PENDING_PAYMENT -> PAID -> CONFIRMED -> SHIPPED -> DELIVERED}.
 * Terminal/exception states: {@code CANCELLED}, {@code PAYMENT_FAILED}, {@code REFUNDED}.
 *
 * <p>Transitions are enforced in the service layer (not here). v1 implements
 * {@code PENDING_PAYMENT -> PAID} (manual confirm) and
 * {@code PENDING_PAYMENT|PAID -> CANCELLED} (with stock restock).
 */
public enum OrderStatus {
    PENDING_PAYMENT,
    PAID,
    CONFIRMED,
    SHIPPED,
    DELIVERED,
    CANCELLED,
    PAYMENT_FAILED,
    REFUNDED
}
