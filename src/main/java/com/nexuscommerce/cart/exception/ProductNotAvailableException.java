package com.nexuscommerce.cart.exception;

import java.util.UUID;

public class ProductNotAvailableException extends RuntimeException {
    public ProductNotAvailableException(UUID productId) {
        super("Product " + productId + " is not available for purchase");
    }
}
