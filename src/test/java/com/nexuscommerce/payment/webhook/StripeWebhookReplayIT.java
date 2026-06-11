package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.payment.PaymentEventHandler;
import com.nexuscommerce.testsupport.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The "no webhook event can be silently lost" contract at the service level:
 * a handler failure leaves a FAILED row (and acks normally), the admin replay
 * re-dispatches it from the stored payload, and PROCESSED / payload-less rows
 * are not replayable.
 *
 * <p>The service is constructed directly (its bean is conditional on the
 * Stripe provider, which tests deliberately never activate); signature
 * verification is not in play — replay() works from the already-verified
 * stored payload.
 */
class StripeWebhookReplayIT extends IntegrationTest {

    @Autowired private WebhookEventStore eventStore;

    /** Minimal Stripe event payload — deserialized via the SDK's lenient path. */
    private static String succeededPayload(String eventId) {
        return """
                {"id":"%s","object":"event","type":"payment_intent.succeeded","api_version":"2025-01-01",
                 "data":{"object":{"id":"pi_test_1","object":"payment_intent","amount":5000,"currency":"usd"}}}
                """.formatted(eventId);
    }

    static class StubHandler implements PaymentEventHandler {
        boolean failNext = false;
        final List<String> confirmed = new ArrayList<>();

        @Override
        public void confirmPaymentByIntent(String paymentIntentId, long amountMinor, String currency) {
            if (failNext) {
                throw new IllegalStateException("simulated handler failure");
            }
            confirmed.add(paymentIntentId);
        }

        @Override public void recordPaymentFailureByIntent(String paymentIntentId) { }
        @Override public void cancelPaymentByIntent(String paymentIntentId) { }
        @Override public void recordRefundByIntent(String paymentIntentId, long amountRefundedMinor, String currency) { }
    }

    @Test
    void aFailedDispatchIsStoredForReplayAndReplaySucceedsOnceFixed() {
        StubHandler handler = new StubHandler();
        StripeWebhookService service = new StripeWebhookService(handler, eventStore);
        String eventId = "evt_" + UUID.randomUUID();
        eventStore.recordReceived(eventId, "payment_intent.succeeded", succeededPayload(eventId));

        // First dispatch fails — the event must end FAILED, not vanish.
        handler.failNext = true;
        service.replay(eventId);
        WebhookEvent afterFailure = eventStore.find(eventId).orElseThrow();
        assertThat(afterFailure.getStatus()).isEqualTo(WebhookEventStatus.FAILED);
        assertThat(afterFailure.getErrorMessage()).contains("simulated handler failure");
        assertThat(afterFailure.getPayload()).isNotNull();

        // Cause fixed — replay re-dispatches from storage and marks PROCESSED.
        handler.failNext = false;
        service.replay(eventId);
        assertThat(eventStore.find(eventId).orElseThrow().getStatus())
                .isEqualTo(WebhookEventStatus.PROCESSED);
        assertThat(handler.confirmed).containsExactly("pi_test_1");

        // Replaying a PROCESSED event would double-apply it — rejected.
        assertThatThrownBy(() -> service.replay(eventId))
                .isInstanceOf(WebhookEventNotReplayableException.class);
    }

    @Test
    void aPayloadlessMarkerRowIsNotReplayable() {
        StripeWebhookService service = new StripeWebhookService(new StubHandler(), eventStore);
        String eventId = "evt_" + UUID.randomUUID();
        // Pre-V7 carried-over marker: FAILED-shaped but without a payload.
        eventStore.recordReceived(eventId, "payment_intent.succeeded", null);
        eventStore.markFailed(eventId, "old marker");

        assertThatThrownBy(() -> service.replay(eventId))
                .isInstanceOf(WebhookEventNotReplayableException.class);
    }

    @Test
    void replayOfAnUnknownEventIs404() {
        StripeWebhookService service = new StripeWebhookService(new StubHandler(), eventStore);

        assertThatThrownBy(() -> service.replay("evt_does_not_exist"))
                .isInstanceOf(WebhookEventNotFoundException.class);
    }

    @Test
    void aFreshInFlightEventCannotBeConcurrentlyRedispatched() {
        String eventId = "evt_" + UUID.randomUUID();
        eventStore.recordReceived(eventId, "payment_intent.succeeded", succeededPayload(eventId));

        // RECEIVED and within its lease: the claim must refuse a second dispatcher.
        assertThat(eventStore.claimForRedispatch(eventId, Instant.now().minusSeconds(300))).isFalse();

        // Once the lease has expired (receivedAt < staleBefore), reclaim succeeds.
        assertThat(eventStore.claimForRedispatch(eventId, Instant.now().plusSeconds(1))).isTrue();
    }
}
