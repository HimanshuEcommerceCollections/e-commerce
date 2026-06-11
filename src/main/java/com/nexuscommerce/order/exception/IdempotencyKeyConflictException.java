package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/**
 * The same Idempotency-Key was reused with a different request body. Replaying
 * the original response would silently ignore the new request, and creating a
 * second order would break the key's contract — so the call is rejected and the
 * client must pick a fresh key.
 */
public class IdempotencyKeyConflictException extends DomainException {
    public IdempotencyKeyConflictException() {
        super(HttpStatus.UNPROCESSABLE_ENTITY,
                "This Idempotency-Key was already used with a different request. Use a new key.");
    }
}
