package com.nexuscommerce.payment.webhook;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;

public interface WebhookEventRepository extends JpaRepository<WebhookEvent, String> {

    /**
     * Atomically claim an event for re-dispatch: FAILED events are always
     * claimable; RECEIVED events only once stale (in-flight lease expired —
     * i.e. the original processor crashed). Resetting {@code receivedAt}
     * restarts the lease for the claimant. Exactly one of any set of concurrent
     * redeliveries/replays wins, so the same event is never dispatched twice
     * at once.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("""
            UPDATE WebhookEvent e
               SET e.status = com.nexuscommerce.payment.webhook.WebhookEventStatus.RECEIVED,
                   e.receivedAt = :now
             WHERE e.eventId = :eventId
               AND (e.status = com.nexuscommerce.payment.webhook.WebhookEventStatus.FAILED
                    OR (e.status = com.nexuscommerce.payment.webhook.WebhookEventStatus.RECEIVED
                        AND e.receivedAt < :staleBefore))
            """)
    int claimForRedispatch(@Param("eventId") String eventId,
                           @Param("staleBefore") Instant staleBefore,
                           @Param("now") Instant now);
}
