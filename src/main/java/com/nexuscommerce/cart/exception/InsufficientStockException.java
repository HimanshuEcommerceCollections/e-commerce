package com.nexuscommerce.cart.exception;

public class InsufficientStockException extends RuntimeException {
    public InsufficientStockException(int available, int requested) {
        super("Only " + available + " units available, but " + requested + " requested");
    }
}
