package com.nexuscommerce.user.address.dto;

import com.nexuscommerce.user.address.entity.UserAddress;

import java.time.Instant;
import java.util.UUID;

public record AddressResponse(
    UUID id,
    String label,
    String recipientName,
    String phone,
    String addressLine1,
    String addressLine2,
    String city,
    String state,
    String postalCode,
    String country,
    boolean isDefault,
    Instant createdAt,
    Instant updatedAt
) {
    public static AddressResponse from(UserAddress address) {
        return new AddressResponse(
            address.getId(),
            address.getLabel(),
            address.getRecipientName(),
            address.getPhone(),
            address.getAddressLine1(),
            address.getAddressLine2(),
            address.getCity(),
            address.getState(),
            address.getPostalCode(),
            address.getCountry(),
            address.isDefault(),
            address.getCreatedAt(),
            address.getUpdatedAt()
        );
    }
}
