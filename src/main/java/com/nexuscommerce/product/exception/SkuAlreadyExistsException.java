package com.nexuscommerce.product.exception;

public class SkuAlreadyExistsException extends RuntimeException {
    public SkuAlreadyExistsException(String sku) {
        super("A product with SKU '" + sku + "' already exists");
    }
}
