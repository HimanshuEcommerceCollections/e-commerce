package com.nexuscommerce.auth.dto;

import com.nexuscommerce.auth.entity.User;
import com.nexuscommerce.auth.entity.UserRole;

import java.time.Instant;
import java.util.UUID;

/**
 * Returned by both /register and /login.
 * Includes everything the client needs to bootstrap a session
 * without an extra /me round-trip.
 */
public record AuthResponse(

    String accessToken,

    /** Always "Bearer" — included so clients don't hard-code it */
    String tokenType,

    /** Milliseconds until the access token expires */
    long expiresIn,

    UUID userId,
    String email,
    String firstName,
    String lastName,
    String displayName,
    UserRole role,
    Instant issuedAt
) {
    public static AuthResponse of(String token, long expiresIn, User user) {
        return new AuthResponse(
            token,
            "Bearer",
            expiresIn,
            user.getId(),
            user.getEmail(),
            user.getFirstName(),
            user.getLastName(),
            user.getDisplayName(),
            user.getRole(),
            Instant.now()
        );
    }
}
