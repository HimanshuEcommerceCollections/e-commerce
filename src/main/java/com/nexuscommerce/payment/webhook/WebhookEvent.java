package com.nexuscommerce.payment.webhook;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.Instant;

/**
 * A payment-provider webhook event, stored durably with its raw
 * signature-verified payload. Keyed by the provider's own event id (e.g. Stripe
 * {@code evt_…}), which is the idempotency guard: webhooks are at-least-once and
 * an event already PROCESSED is never re-dispatched.
 *
 * <p>Unlike the old marker-only table, a FAILED event keeps its payload so the
 * admin replay endpoint can re-dispatch it after the underlying problem is fixed
 * — a processing bug no longer permanently loses a payment event.
 *
 * <p>Deliberately not a {@code BaseEntity} — the primary key is the provider's
 * string event id, not a generated UUID.
 */
@Entity
@Table(name = "webhook_events")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WebhookEvent {

    @Id
    @Column(name = "event_id", length = 255)
    private String eventId;

    @Column(name = "event_type", length = 100)
    private String eventType;

    /** Raw payload exactly as received (post signature verification). Null only for pre-V7 rows. */
    @Column(columnDefinition = "text")
    private String payload;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private WebhookEventStatus status;

    @Column(name = "error_message", length = 1000)
    private String errorMessage;

    @Column(name = "received_at", nullable = false)
    private Instant receivedAt;

    @Column(name = "processed_at")
    private Instant processedAt;
}
