package com.nexuscommerce.product.exception;

public class ProductOwnershipException extends RuntimeException {
    public ProductOwnershipException() {
        super("You do not have permission to modify this product");
    }
}
