package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.payment.PaymentEventHandler;
import com.nexuscommerce.payment.WebhookVerificationException;
import com.stripe.exception.SignatureVerificationException;
import com.stripe.model.Event;
import com.stripe.model.PaymentIntent;
import com.stripe.net.Webhook;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

/**
 * Verifies and processes inbound Stripe webhook events. Active only when
 * {@code app.payment.provider=stripe}.
 *
 * <p>Every event is signature-verified against the configured webhook secret, then
 * deduplicated by Stripe's event id (webhooks are at-least-once) before being
 * dispatched to the {@link PaymentEventHandler}. Unhandled event types are
 * acknowledged and ignored.
 */
@Slf4j
@Service
@RequiredArgsConstructor
@ConditionalOnProperty(name = "app.payment.provider", havingValue = "stripe")
public class StripeWebhookService {

    private static final String EVENT_PAYMENT_SUCCEEDED = "payment_intent.succeeded";
    private static final String EVENT_PAYMENT_FAILED = "payment_intent.payment_failed";

    private final PaymentEventHandler paymentEventHandler;
    private final ProcessedWebhookEventRepository processedEvents;

    @Value("${app.payment.stripe.webhook-secret}")
    private String webhookSecret;

    /**
     * Verify the signature and process the event. The whole thing runs in one
     * transaction so the order transition and the idempotency marker commit
     * together — if the marker insert loses a race with a concurrent duplicate,
     * the transaction rolls back and the retry is safely skipped.
     *
     * @param payload   the raw request body, exactly as received (required for signature checking)
     * @param signature the {@code Stripe-Signature} header
     * @throws WebhookVerificationException if the signature is invalid or the payload cannot be parsed
     */
    @Transactional
    public void process(String payload, String signature) {
        Event event;
        try {
            event = Webhook.constructEvent(payload, signature, webhookSecret);
        } catch (SignatureVerificationException e) {
            throw new WebhookVerificationException("Invalid Stripe webhook signature");
        }

        if (processedEvents.existsById(event.getId())) {
            log.info("Skipping already-processed Stripe event {}", event.getId());
            return;
        }

        switch (event.getType()) {
            case EVENT_PAYMENT_SUCCEEDED ->
                    paymentEventHandler.confirmPaymentByIntent(extractIntent(event).getId());
            case EVENT_PAYMENT_FAILED ->
                    paymentEventHandler.failPaymentByIntent(extractIntent(event).getId());
            default -> log.debug("Ignoring unhandled Stripe event type {}", event.getType());
        }

        processedEvents.save(new ProcessedWebhookEvent(event.getId(), event.getType(), Instant.now()));
    }

    private PaymentIntent extractIntent(Event event) {
        return (PaymentIntent) event.getDataObjectDeserializer().getObject()
                .orElseThrow(() -> new WebhookVerificationException(
                        "Unable to deserialize PaymentIntent from event " + event.getId()));
    }
}
