package com.nexuscommerce.auth.dto;

import com.nexuscommerce.auth.entity.UserRole;
import jakarta.validation.constraints.*;

/**
 * Payload for POST /api/auth/register.
 * role defaults to ROLE_CUSTOMER when omitted (handled in AuthService).
 */
public record RegisterRequest(

    @NotBlank(message = "Email is required")
    @Email(message = "Must be a valid email address")
    @Size(max = 255, message = "Email must not exceed 255 characters")
    String email,

    @NotBlank(message = "Password is required")
    @Size(min = 8, max = 100, message = "Password must be between 8 and 100 characters")
    String password,

    @NotBlank(message = "First name is required")
    @Size(max = 100, message = "First name must not exceed 100 characters")
    String firstName,

    @NotBlank(message = "Last name is required")
    @Size(max = 100, message = "Last name must not exceed 100 characters")
    String lastName,

    /** Optional vanity name shown in the UI */
    @Size(max = 200, message = "Display name must not exceed 200 characters")
    String displayName,

    /** When null the service defaults to ROLE_CUSTOMER */
    UserRole role
) {}
