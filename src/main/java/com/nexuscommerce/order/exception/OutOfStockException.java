package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

/**
 * The requested quantity could not be reserved because stock ran out between
 * adding to the cart and checking out (a concurrent buyer won the last units).
 * 409 signals the client should re-fetch the cart and retry.
 */
public class OutOfStockException extends DomainException {
    public OutOfStockException(String productName) {
        super(HttpStatus.CONFLICT, "Insufficient stock for '" + productName + "'");
    }
}
