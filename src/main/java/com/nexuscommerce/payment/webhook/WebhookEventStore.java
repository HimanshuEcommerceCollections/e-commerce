package com.nexuscommerce.payment.webhook;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;

/**
 * Persistence seam for webhook events, kept in its own bean so each operation
 * runs in its own NEW transaction, independent of the dispatch outcome:
 * the event row must exist (and survive) even when processing fails and rolls
 * back, otherwise a failed event leaves no trace to replay.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WebhookEventStore {

    private final WebhookEventRepository repository;

    /**
     * Persist the event as RECEIVED before any processing.
     *
     * @return the existing status if this event id was already recorded
     *         (idempotency: at-least-once delivery), or empty if this call
     *         inserted it and the caller should proceed to dispatch
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Optional<WebhookEventStatus> recordReceived(String eventId, String eventType, String payload) {
        Optional<WebhookEvent> existing = repository.findById(eventId);
        if (existing.isPresent()) {
            return Optional.of(existing.get().getStatus());
        }
        try {
            repository.saveAndFlush(WebhookEvent.builder()
                    .eventId(eventId)
                    .eventType(eventType)
                    .payload(payload)
                    .status(WebhookEventStatus.RECEIVED)
                    .receivedAt(Instant.now())
                    .build());
            return Optional.empty();
        } catch (DataIntegrityViolationException e) {
            // Lost the PK race with a concurrent delivery of the same event —
            // that delivery owns processing; treat as in-flight.
            log.info("Concurrent duplicate delivery of webhook event {}", eventId);
            return Optional.of(WebhookEventStatus.RECEIVED);
        }
    }

    /**
     * Try to take ownership of an already-stored event before re-dispatching it
     * (provider redelivery of a FAILED event, admin replay, or a RECEIVED event
     * whose processor crashed past its lease).
     *
     * @param staleBefore RECEIVED events with {@code receivedAt} before this are
     *                    considered crashed-in-flight and reclaimable
     * @return true if this caller won and must dispatch
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean claimForRedispatch(String eventId, Instant staleBefore) {
        return repository.claimForRedispatch(eventId, staleBefore, Instant.now()) == 1;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void markProcessed(String eventId) {
        repository.findById(eventId).ifPresent(event -> {
            event.setStatus(WebhookEventStatus.PROCESSED);
            event.setErrorMessage(null);
            event.setProcessedAt(Instant.now());
        });
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void markFailed(String eventId, String error) {
        repository.findById(eventId).ifPresent(event -> {
            event.setStatus(WebhookEventStatus.FAILED);
            event.setErrorMessage(error != null && error.length() > 1000 ? error.substring(0, 1000) : error);
            event.setProcessedAt(Instant.now());
        });
    }

    @Transactional(readOnly = true)
    public Optional<WebhookEvent> find(String eventId) {
        return repository.findById(eventId);
    }
}
