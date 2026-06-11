package com.nexuscommerce.payment.webhook;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/** Replay was requested for an event id that was never stored. */
public class WebhookEventNotFoundException extends DomainException {
    public WebhookEventNotFoundException(String eventId) {
        super(HttpStatus.NOT_FOUND, "Webhook event not found: " + eventId);
    }
}
