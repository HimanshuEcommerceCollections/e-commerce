package com.nexuscommerce.payment;

import java.math.BigDecimal;

/**
 * Gateway-agnostic instruction to collect a payment. Deliberately carries only
 * primitives (no Order entity) so the payment module stays decoupled from the
 * order module — the dependency runs one way: order -> payment.
 *
 * @param orderNumber human-readable order reference, for the gateway's records
 * @param amount      total amount to charge (major units, e.g. dollars)
 * @param currency    ISO-4217 currency code
 */
public record PaymentRequest(
        String orderNumber,
        BigDecimal amount,
        String currency
) {}
