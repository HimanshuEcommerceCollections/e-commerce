package com.nexuscommerce.auth.exception;

public class EmailAlreadyRegisteredException extends RuntimeException {

    public EmailAlreadyRegisteredException(String email) {
        super("An account is already registered for: " + email);
    }
}
