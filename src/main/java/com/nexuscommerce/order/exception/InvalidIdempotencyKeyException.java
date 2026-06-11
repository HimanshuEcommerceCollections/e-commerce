package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/** The Idempotency-Key header is present but malformed. */
public class InvalidIdempotencyKeyException extends DomainException {
    public InvalidIdempotencyKeyException() {
        super(HttpStatus.BAD_REQUEST,
                "Idempotency-Key must be 1-80 characters of letters, digits, '-' or '_'");
    }
}
