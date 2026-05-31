package com.nexuscommerce.product.exception;

public class SlugAlreadyExistsException extends RuntimeException {
    public SlugAlreadyExistsException(String slug) {
        super("A category with slug '" + slug + "' already exists");
    }
}
