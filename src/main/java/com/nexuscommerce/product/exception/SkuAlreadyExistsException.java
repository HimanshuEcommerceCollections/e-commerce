package com.nexuscommerce.product.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class SkuAlreadyExistsException extends DomainException {
    public SkuAlreadyExistsException(String sku) {
        super(HttpStatus.CONFLICT, "A product with SKU '" + sku + "' already exists");
    }
}
