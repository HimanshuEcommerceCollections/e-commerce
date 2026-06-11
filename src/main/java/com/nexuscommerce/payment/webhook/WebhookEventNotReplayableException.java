package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/**
 * Replay was requested for an event that cannot be re-dispatched — already
 * processed (replaying would double-apply it) or stored without a payload
 * (pre-V7 marker rows).
 */
public class WebhookEventNotReplayableException extends DomainException {
    public WebhookEventNotReplayableException(String eventId, String reason) {
        super(HttpStatus.CONFLICT, "Webhook event " + eventId + " cannot be replayed: " + reason);
    }
}
