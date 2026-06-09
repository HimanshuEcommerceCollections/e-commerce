package com.nexuscommerce.payment.webhook;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.Instant;

/**
 * Record of a payment-provider webhook event we have already handled, keyed by
 * the provider's own event id. Webhooks are delivered at-least-once, so this row
 * is the idempotency guard: an event whose id is already present is skipped.
 *
 * <p>Deliberately not a {@code BaseEntity} — the primary key is the provider's
 * string event id (e.g. Stripe {@code evt_…}), not a generated UUID.
 */
@Entity
@Table(name = "processed_webhook_events")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
public class ProcessedWebhookEvent {

    @Id
    @Column(name = "event_id", length = 255)
    private String eventId;

    @Column(name = "event_type", length = 100)
    private String eventType;

    @Column(name = "processed_at", nullable = false)
    private Instant processedAt;
}
