package com.nexuscommerce.user.address.exception;

public class AddressLimitExceededException extends RuntimeException {

    public AddressLimitExceededException() {
        super("You can save a maximum of 5 addresses per account");
    }
}
