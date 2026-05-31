package com.nexuscommerce.user.address.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

public class AddressLimitExceededException extends DomainException {

    public AddressLimitExceededException(int limit) {
        super(HttpStatus.BAD_REQUEST, "You can save a maximum of " + limit + " addresses per account");
    }
}
