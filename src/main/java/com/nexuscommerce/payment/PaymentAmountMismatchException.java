package com.nexuscommerce.payment;

/**
 * A provider-reported successful payment does not match the order's total or
 * currency. Thrown by the {@link PaymentEventHandler} implementation during
 * webhook dispatch so the event is recorded FAILED (replayable after
 * investigation) instead of silently marking the order paid for the wrong
 * amount. Never surfaces over HTTP — the webhook pipeline catches it.
 */
public class PaymentAmountMismatchException extends RuntimeException {

    public PaymentAmountMismatchException(String orderNumber,
                                          long expectedMinor, long actualMinor,
                                          String expectedCurrency, String actualCurrency) {
        super("Payment amount mismatch for order %s: expected %d %s, provider reported %d %s"
                .formatted(orderNumber, expectedMinor, expectedCurrency, actualMinor, actualCurrency));
    }
}
