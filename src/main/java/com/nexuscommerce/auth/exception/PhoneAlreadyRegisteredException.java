package com.nexuscommerce.auth.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class PhoneAlreadyRegisteredException extends DomainException {

    public PhoneAlreadyRegisteredException(String phoneNumber) {
        super(HttpStatus.CONFLICT, "An account is already registered for phone: " + phoneNumber);
    }
}
