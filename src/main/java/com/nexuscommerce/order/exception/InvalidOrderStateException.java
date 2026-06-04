package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/**
 * A requested transition is not allowed from the order's current status
 * (e.g. cancelling an already-shipped order, or paying a cancelled one).
 */
public class InvalidOrderStateException extends DomainException {
    public InvalidOrderStateException(String message) {
        super(HttpStatus.CONFLICT, message);
    }
}
