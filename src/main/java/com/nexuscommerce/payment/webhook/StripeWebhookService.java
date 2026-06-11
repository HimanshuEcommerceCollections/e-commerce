package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.payment.PaymentEventHandler;
import com.nexuscommerce.payment.WebhookVerificationException;
import com.stripe.exception.EventDataObjectDeserializationException;
import com.stripe.exception.SignatureVerificationException;
import com.stripe.model.Charge;
import com.stripe.model.Event;
import com.stripe.model.PaymentIntent;
import com.stripe.model.StripeObject;
import com.stripe.net.ApiResource;
import com.stripe.net.Webhook;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.util.Optional;

/**
 * Verifies and processes inbound Stripe webhook events. Active only when
 * {@code app.payment.provider=stripe}.
 *
 * <p>Pipeline, deliberately split across transactions:
 * <ol>
 *   <li>Signature verification — failure is the only 400; everything after a
 *       valid signature is acknowledged with 200 so Stripe keeps the event
 *       stream healthy and we never lose an event we could have stored.</li>
 *   <li>The event is persisted (RECEIVED) in its own transaction via
 *       {@link WebhookEventStore} — this is the idempotency check, and it means
 *       a later processing failure still leaves a durable, replayable row.</li>
 *   <li>Dispatch to the {@link PaymentEventHandler} (the order module's own
 *       transactions). Errors mark the event FAILED — never a 4xx/5xx, which
 *       would either stop Stripe's retries (4xx) or retry a poison event
 *       forever (5xx). FAILED events are re-runnable via the admin replay
 *       endpoint.</li>
 * </ol>
 */
@Slf4j
@Service
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.payment.provider", havingValue = "stripe")
public class StripeWebhookService {

    private static final String EVENT_PAYMENT_SUCCEEDED = "payment_intent.succeeded";
    private static final String EVENT_PAYMENT_FAILED = "payment_intent.payment_failed";
    private static final String EVENT_PAYMENT_CANCELED = "payment_intent.canceled";
    private static final String EVENT_CHARGE_REFUNDED = "charge.refunded";

    private final PaymentEventHandler paymentEventHandler;
    private final WebhookEventStore eventStore;

    @Value("${app.payment.stripe.webhook-secret}")
    private String webhookSecret;

    /**
     * How long a RECEIVED event counts as in-flight. Past this, a provider
     * redelivery (or admin replay) may reclaim it — otherwise a crash between
     * persisting and processing would park the event as "in flight" forever and
     * every redelivery would be skipped.
     */
    @Value("${app.payment.stripe.webhook-inflight-lease-seconds:300}")
    private long inflightLeaseSeconds;

    /**
     * Fail fast on a missing/placeholder signing secret. The Stripe-Signature
     * header is an HMAC over the payload with this string as the key — with the
     * shipped placeholder (or a blank), anyone who knows it can forge a
     * payment_intent.succeeded and mark their order PAID with no money moved.
     */
    @PostConstruct
    void requireRealWebhookSecret() {
        if (webhookSecret == null || webhookSecret.isBlank() || webhookSecret.contains("REPLACE")) {
            throw new IllegalStateException(
                    "app.payment.provider=stripe requires STRIPE_WEBHOOK_SECRET to be set to the "
                            + "endpoint's real signing secret (whsec_…) — see server/.env for how to obtain it");
        }
    }

    /**
     * @param payload   the raw request body, exactly as received (required for signature checking)
     * @param signature the {@code Stripe-Signature} header
     * @throws WebhookVerificationException only for an invalid signature
     */
    public void process(String payload, String signature) {
        Event event;
        try {
            event = Webhook.constructEvent(payload, signature, webhookSecret);
        } catch (SignatureVerificationException e) {
            throw new WebhookVerificationException("Invalid Stripe webhook signature");
        }

        Optional<WebhookEventStatus> existing =
                eventStore.recordReceived(event.getId(), event.getType(), payload);

        if (existing.isPresent()) {
            switch (existing.get()) {
                case PROCESSED -> log.info("Skipping already-processed Stripe event {}", event.getId());
                // FAILED → always reclaimable; RECEIVED → only past the in-flight
                // lease (a crash mid-processing must not swallow redeliveries
                // forever). The claim is atomic, so a concurrent redelivery/replay
                // of the same event can never double-dispatch.
                case FAILED, RECEIVED -> {
                    if (eventStore.claimForRedispatch(event.getId(), inflightLease())) {
                        dispatchAndRecord(event);
                    } else {
                        log.info("Stripe event {} is already being processed — skipping duplicate",
                                event.getId());
                    }
                }
            }
            return;
        }

        dispatchAndRecord(event);
    }

    /**
     * Re-dispatch a stored FAILED event from its persisted payload (admin
     * operation, after the underlying cause has been fixed). The signature was
     * verified when the payload was stored.
     */
    public void replay(String eventId) {
        WebhookEvent stored = eventStore.find(eventId)
                .orElseThrow(() -> new WebhookEventNotFoundException(eventId));
        if (stored.getStatus() == WebhookEventStatus.PROCESSED) {
            throw new WebhookEventNotReplayableException(eventId, "it was already processed");
        }
        if (stored.getPayload() == null) {
            throw new WebhookEventNotReplayableException(eventId, "no payload was stored for it");
        }
        if (!eventStore.claimForRedispatch(eventId, inflightLease())) {
            throw new WebhookEventNotReplayableException(eventId,
                    "it is currently being processed — retry shortly");
        }
        Event event = ApiResource.GSON.fromJson(stored.getPayload(), Event.class);
        dispatchAndRecord(event);
    }

    private java.time.Instant inflightLease() {
        return java.time.Instant.now().minusSeconds(inflightLeaseSeconds);
    }

    private void dispatchAndRecord(Event event) {
        try {
            dispatch(event);
            eventStore.markProcessed(event.getId());
        } catch (Exception e) {
            log.error("Processing Stripe event {} ({}) failed — stored as FAILED for replay",
                    event.getId(), event.getType(), e);
            eventStore.markFailed(event.getId(), e.getMessage());
        }
    }

    private void dispatch(Event event) {
        switch (event.getType()) {
            case EVENT_PAYMENT_SUCCEEDED -> {
                PaymentIntent intent = deserialize(event, PaymentIntent.class);
                paymentEventHandler.confirmPaymentByIntent(
                        intent.getId(), intent.getAmount(), intent.getCurrency());
            }
            case EVENT_PAYMENT_FAILED ->
                    paymentEventHandler.recordPaymentFailureByIntent(
                            deserialize(event, PaymentIntent.class).getId());
            case EVENT_PAYMENT_CANCELED ->
                    paymentEventHandler.cancelPaymentByIntent(
                            deserialize(event, PaymentIntent.class).getId());
            case EVENT_CHARGE_REFUNDED -> {
                // charge.refunded carries a Charge, not a PaymentIntent; it also
                // fires for partial refunds, so the handler receives the
                // cumulative amount_refunded to compare against the order total.
                Charge charge = deserialize(event, Charge.class);
                paymentEventHandler.recordRefundByIntent(
                        charge.getPaymentIntent(), charge.getAmountRefunded(), charge.getCurrency());
            }
            default -> log.debug("Ignoring unhandled Stripe event type {}", event.getType());
        }
    }

    /**
     * Deserialize the event's data object. {@code getObject()} is empty whenever
     * the event's API version differs from the SDK's pinned version — exactly the
     * failure that used to 400 and permanently lose events — so fall back to the
     * SDK's lenient deserializer before giving up (a throw here marks the event
     * FAILED, keeping it replayable).
     */
    private <T extends StripeObject> T deserialize(Event event, Class<T> type) {
        StripeObject object;
        try {
            object = event.getDataObjectDeserializer().getObject().orElse(null);
        } catch (RuntimeException e) {
            // The strict deserializer can throw (not just return empty) on
            // malformed/partial events — fall through to the lenient path.
            object = null;
        }
        if (object == null) {
            try {
                object = event.getDataObjectDeserializer().deserializeUnsafe();
            } catch (EventDataObjectDeserializationException e) {
                throw new IllegalStateException(
                        "Unable to deserialize data object of event " + event.getId()
                                + " (API version mismatch?)", e);
            }
        }
        if (!type.isInstance(object)) {
            throw new IllegalStateException("Event " + event.getId() + " carried "
                    + object.getClass().getSimpleName() + ", expected " + type.getSimpleName());
        }
        return type.cast(object);
    }
}
