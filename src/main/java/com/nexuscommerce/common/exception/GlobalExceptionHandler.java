package com.nexuscommerce.common.exception;

import com.nexuscommerce.common.dto.ApiResponse;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.DisabledException;
import org.springframework.security.authentication.LockedException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;
import java.util.stream.Collectors;

@RestControllerAdvice
public class GlobalExceptionHandler {

    // ── Domain exceptions ───────────────────────────────────────────────────
    // Any DomainException renders with the HTTP status it carries. Feature
    // modules add new exceptions extending DomainException without touching this
    // class, so it stays decoupled from product/cart/order/etc.

    @ExceptionHandler(DomainException.class)
    public ResponseEntity<ApiResponse<Void>> handleDomain(DomainException ex) {
        return ResponseEntity.status(ex.getStatus().value())
                .body(ApiResponse.error(ex.getMessage()));
    }

    // ── Spring Security ──────────────────────────────────────────────────────

    @ExceptionHandler(BadCredentialsException.class)
    public ResponseEntity<ApiResponse<Void>> handleBadCredentials(BadCredentialsException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(ApiResponse.error("Invalid email or password"));
    }

    @ExceptionHandler(DisabledException.class)
    public ResponseEntity<ApiResponse<Void>> handleDisabled(DisabledException ex) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(ApiResponse.error("This account has been disabled"));
    }

    @ExceptionHandler(LockedException.class)
    public ResponseEntity<ApiResponse<Void>> handleLocked(LockedException ex) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(ApiResponse.error("This account is temporarily locked"));
    }

    // ── Request validation ─────────────────────────────────────────────────

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Map<String, String>>> handleValidation(MethodArgumentNotValidException ex) {
        Map<String, String> fieldErrors = ex.getBindingResult().getFieldErrors().stream()
                .collect(Collectors.toMap(
                        FieldError::getField,
                        fe -> fe.getDefaultMessage() != null ? fe.getDefaultMessage() : "Invalid value",
                        (first, second) -> first
                ));

        return ResponseEntity.badRequest()
                .body(ApiResponse.error("Validation failed", fieldErrors));
    }

    // ── Persistence / concurrency backstops ──────────────────────────────────

    /**
     * Concurrent-write backstop. A losing optimistic-lock update (stale
     * {@code @Version}) means another request modified the row first; the
     * client should re-fetch and retry.
     */
    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    public ResponseEntity<ApiResponse<Void>> handleOptimisticLock(ObjectOptimisticLockingFailureException ex) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(ApiResponse.error("This resource was updated by another request. Please retry."));
    }

    /**
     * Unique/foreign-key backstop. App-level checks (SKU, slug) catch the common
     * cases with specific messages; this guards the check-then-insert race and
     * any other constraint violation so it returns 409 rather than a generic 500.
     * The DB message is intentionally not echoed back to avoid leaking schema details.
     */
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ApiResponse<Void>> handleDataIntegrity(DataIntegrityViolationException ex) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(ApiResponse.error("The request conflicts with existing data"));
    }

    // ── Catch-all ────────────────────────────────────────────────────────────

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleUnexpected(Exception ex) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.error("An unexpected error occurred"));
    }
}
