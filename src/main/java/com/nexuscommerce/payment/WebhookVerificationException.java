package com.nexuscommerce.payment;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/**
 * An inbound payment webhook failed signature verification or could not be
 * parsed. Maps to {@code 400 Bad Request} so the provider does not keep retrying
 * a payload we will never accept.
 */
public class WebhookVerificationException extends DomainException {
    public WebhookVerificationException(String message) {
        super(HttpStatus.BAD_REQUEST, message);
    }
}
