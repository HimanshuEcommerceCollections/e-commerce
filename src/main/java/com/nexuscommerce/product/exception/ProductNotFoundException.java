package com.nexuscommerce.product.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

public class ProductNotFoundException extends DomainException {
    public ProductNotFoundException(UUID id) {
        super(HttpStatus.NOT_FOUND, "Product not found: " + id);
    }
}
