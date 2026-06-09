package com.nexuscommerce.auth.dto;

import jakarta.validation.constraints.*;

/**
 * Payload for POST /api/auth/register.
 * Public self-registration is customer-only — the role is always
 * ROLE_CUSTOMER (assigned server-side in AuthService), never taken from the client.
 */
public record RegisterRequest(

    @NotBlank(message = "Email is required")
    @Email(message = "Must be a valid email address")
    @Size(max = 255, message = "Email must not exceed 255 characters")
    String email,

    @NotBlank(message = "Password is required")
    @Size(min = 8, max = 100, message = "Password must be between 8 and 100 characters")
    String password,

    @NotBlank(message = "Full name is required")
    @Size(max = 200, message = "Full name must not exceed 200 characters")
    String fullName,

    @NotBlank(message = "Phone number is required")
    @Pattern(
        regexp = "^[+]?[0-9 ()-]{7,20}$",
        message = "Must be a valid phone number"
    )
    @Size(max = 20, message = "Phone number must not exceed 20 characters")
    String phoneNumber
) {}
