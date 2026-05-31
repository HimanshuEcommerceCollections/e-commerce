package com.nexuscommerce.user.address.exception;

import com.nexuscommerce.common.exception.DomainException;
import org.springframework.http.HttpStatus;

import java.util.UUID;

public class AddressNotFoundException extends DomainException {

    public AddressNotFoundException(UUID id) {
        super(HttpStatus.NOT_FOUND, "Address not found: " + id);
    }
}
