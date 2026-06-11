package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.testsupport.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Idempotency + durability semantics of the webhook event store. */
class WebhookEventStoreIT extends IntegrationTest {

    @Autowired private WebhookEventStore store;

    @Test
    void firstDeliveryInsertsAndLaterDeliveriesSeeTheStatus() {
        String eventId = "evt_" + UUID.randomUUID();

        Optional<WebhookEventStatus> first = store.recordReceived(eventId, "payment_intent.succeeded", "{}");
        assertThat(first).isEmpty(); // new — caller dispatches

        Optional<WebhookEventStatus> redelivery = store.recordReceived(eventId, "payment_intent.succeeded", "{}");
        assertThat(redelivery).contains(WebhookEventStatus.RECEIVED); // in flight — skip

        store.markProcessed(eventId);
        assertThat(store.recordReceived(eventId, "payment_intent.succeeded", "{}"))
                .contains(WebhookEventStatus.PROCESSED); // done — never re-dispatch
    }

    @Test
    void aFailedEventKeepsItsPayloadAndErrorForReplay() {
        String eventId = "evt_" + UUID.randomUUID();
        store.recordReceived(eventId, "charge.refunded", "{\"raw\":true}");

        store.markFailed(eventId, "boom");

        WebhookEvent stored = store.find(eventId).orElseThrow();
        assertThat(stored.getStatus()).isEqualTo(WebhookEventStatus.FAILED);
        assertThat(stored.getErrorMessage()).isEqualTo("boom");
        assertThat(stored.getPayload()).isEqualTo("{\"raw\":true}");
        assertThat(stored.getProcessedAt()).isNotNull();
    }
}
