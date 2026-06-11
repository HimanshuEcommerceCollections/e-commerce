package com.nexuscommerce.payment.webhook;

/**
 * Lifecycle of a stored webhook event.
 *
 * <ul>
 *   <li>{@code RECEIVED} — persisted, processing in flight (or the process
 *       crashed mid-flight; the provider's redelivery will retry it).</li>
 *   <li>{@code PROCESSED} — handled successfully. Idempotency guard: never
 *       dispatched again, including via replay.</li>
 *   <li>{@code FAILED} — the handler threw. The payload is retained so the
 *       admin replay endpoint can re-dispatch after the cause is fixed.</li>
 * </ul>
 */
public enum WebhookEventStatus {
    RECEIVED,
    PROCESSED,
    FAILED
}
