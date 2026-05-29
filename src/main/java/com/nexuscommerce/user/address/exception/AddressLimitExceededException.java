package com.nexuscommerce.user.address.exception;

public class AddressLimitExceededException extends RuntimeException {

    public AddressLimitExceededException(int limit) {
        super("You can save a maximum of " + limit + " addresses per account");
    }
}
