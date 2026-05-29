package com.nexuscommerce.user.address.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record AddressRequest(

    @NotBlank(message = "Label is required")
    @Size(max = 50, message = "Label must not exceed 50 characters")
    String label,

    @NotBlank(message = "Recipient name is required")
    @Size(max = 200, message = "Recipient name must not exceed 200 characters")
    String recipientName,

    @Size(max = 20, message = "Phone must not exceed 20 characters")
    @Pattern(
        regexp = "^$|^\\+?[0-9 ()\\-]{6,20}$",
        message = "Phone must contain only digits, spaces, parentheses, hyphens, and an optional leading '+'"
    )
    String phone,

    @NotBlank(message = "Address line 1 is required")
    @Size(max = 255, message = "Address line 1 must not exceed 255 characters")
    String addressLine1,

    @Size(max = 255, message = "Address line 2 must not exceed 255 characters")
    String addressLine2,

    @NotBlank(message = "City is required")
    @Size(max = 100, message = "City must not exceed 100 characters")
    String city,

    @NotBlank(message = "State is required")
    @Size(max = 100, message = "State must not exceed 100 characters")
    String state,

    @NotBlank(message = "Postal code is required")
    @Size(max = 20, message = "Postal code must not exceed 20 characters")
    String postalCode,

    @NotBlank(message = "Country is required")
    @Size(max = 100, message = "Country must not exceed 100 characters")
    String country,

    boolean isDefault
) {}
