package com.nexuscommerce.common.exception;

import org.springframework.http.HttpStatus;

/**
 * Base type for application/domain exceptions. Each subclass declares the HTTP
 * status it should map to; the single {@code GlobalExceptionHandler} renders any
 * subclass via {@link #getStatus()} and {@link #getMessage()}.
 *
 * <p>This keeps the handler decoupled from feature modules: a new module adds its
 * own exceptions extending this type and needs no changes to the handler.
 */
public abstract class DomainException extends RuntimeException {

    private final HttpStatus status;

    protected DomainException(HttpStatus status, String message) {
        super(message);
        this.status = status;
    }

    public HttpStatus getStatus() {
        return status;
    }
}
