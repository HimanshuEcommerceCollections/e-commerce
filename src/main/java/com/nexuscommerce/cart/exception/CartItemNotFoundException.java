package com.nexuscommerce.cart.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

public class CartItemNotFoundException extends DomainException {
    public CartItemNotFoundException(UUID productId) {
        super(HttpStatus.NOT_FOUND, "Cart item not found for product: " + productId);
    }
}
