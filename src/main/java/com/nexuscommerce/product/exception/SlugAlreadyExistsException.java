package com.nexuscommerce.product.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class SlugAlreadyExistsException extends DomainException {
    public SlugAlreadyExistsException(String slug) {
        super(HttpStatus.CONFLICT, "A category with slug '" + slug + "' already exists");
    }
}
