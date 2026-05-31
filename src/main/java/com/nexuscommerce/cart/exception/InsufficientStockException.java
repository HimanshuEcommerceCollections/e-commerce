package com.nexuscommerce.cart.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class InsufficientStockException extends DomainException {
    public InsufficientStockException(int available, int requested) {
        super(HttpStatus.BAD_REQUEST, "Only " + available + " units available, but " + requested + " requested");
    }
}
