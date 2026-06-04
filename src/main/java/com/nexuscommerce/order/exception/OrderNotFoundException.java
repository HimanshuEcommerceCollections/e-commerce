package com.nexuscommerce.order.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

public class OrderNotFoundException extends DomainException {
    public OrderNotFoundException(UUID orderId) {
        super(HttpStatus.NOT_FOUND, "Order " + orderId + " was not found");
    }
}
