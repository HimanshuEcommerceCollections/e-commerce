package com.nexuscommerce.cart.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

public class ProductNotAvailableException extends DomainException {
    public ProductNotAvailableException(UUID productId) {
        super(HttpStatus.BAD_REQUEST, "Product " + productId + " is not available for purchase");
    }
}
