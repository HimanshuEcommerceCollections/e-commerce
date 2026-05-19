package com.nexuscommerce.common.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;

/**
 * Uniform envelope for every API response in NexusCommerce.
 *
 * Success:  { "success": true,  "message": "...", "data": {...}, "timestamp": "..." }
 * Error:    { "success": false, "message": "...", "data": null,  "timestamp": "..." }
 *
 * Use the static factory methods — never call the constructor directly.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiResponse<T>(
        boolean success,
        String message,
        T data,
        Instant timestamp
) {

    // ── Success factories ────────────────────────────────────────────────────

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, "Success", data, Instant.now());
    }

    public static <T> ApiResponse<T> ok(String message, T data) {
        return new ApiResponse<>(true, message, data, Instant.now());
    }

    public static <T> ApiResponse<T> created(T data) {
        return new ApiResponse<>(true, "Created successfully", data, Instant.now());
    }

    public static <T> ApiResponse<T> created(String message, T data) {
        return new ApiResponse<>(true, message, data, Instant.now());
    }

    /** Useful for DELETE or other void-result operations */
    public static ApiResponse<Void> noContent(String message) {
        return new ApiResponse<>(true, message, null, Instant.now());
    }

    // ── Error factories ──────────────────────────────────────────────────────

    public static <T> ApiResponse<T> error(String message) {
        return new ApiResponse<>(false, message, null, Instant.now());
    }

    public static <T> ApiResponse<T> error(String message, T errorDetails) {
        return new ApiResponse<>(false, message, errorDetails, Instant.now());
    }
}
