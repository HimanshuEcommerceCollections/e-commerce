package com.nexuscommerce.auth.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class EmailAlreadyRegisteredException extends DomainException {

    public EmailAlreadyRegisteredException(String email) {
        super(HttpStatus.CONFLICT, "An account is already registered for: " + email);
    }
}
