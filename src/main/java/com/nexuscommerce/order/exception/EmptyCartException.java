package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class EmptyCartException extends DomainException {
    public EmptyCartException() {
        super(HttpStatus.BAD_REQUEST, "Your cart is empty");
    }
}
