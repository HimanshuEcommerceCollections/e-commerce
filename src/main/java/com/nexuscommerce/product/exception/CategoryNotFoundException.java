package com.nexuscommerce.product.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

public class CategoryNotFoundException extends DomainException {
    public CategoryNotFoundException(UUID id) {
        super(HttpStatus.NOT_FOUND, "Category not found: " + id);
    }
}
