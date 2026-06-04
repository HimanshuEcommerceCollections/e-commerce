package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

/**
 * A cart item can no longer be ordered because the product was deleted or is no
 * longer ACTIVE. 409 (not 400): the request was valid, but server state changed
 * since the item was added to the cart.
 */
public class ProductUnavailableException extends DomainException {
    public ProductUnavailableException(UUID productId) {
        super(HttpStatus.CONFLICT, "Product " + productId + " is no longer available for purchase");
    }
}
