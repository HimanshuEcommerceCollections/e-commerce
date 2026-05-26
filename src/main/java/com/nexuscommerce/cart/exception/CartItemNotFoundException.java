package com.nexuscommerce.cart.exception;

import java.util.UUID;

public class CartItemNotFoundException extends RuntimeException {
    public CartItemNotFoundException(UUID productId) {
        super("Cart item not found for product: " + productId);
    }
}
