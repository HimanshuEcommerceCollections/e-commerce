package com.nexuscommerce.order.controller;

import com.nexuscommerce.auth.security.CustomerUserDetails;
import com.nexuscommerce.common.dto.ApiResponse;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.dto.OrderResponse;
import com.nexuscommerce.order.dto.OrderSummaryResponse;
import com.nexuscommerce.order.service.CheckoutCoordinator;
import com.nexuscommerce.order.service.OrderService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;
    private final CheckoutCoordinator checkoutCoordinator;

    /**
     * Place an order from the caller's cart. An optional {@code Idempotency-Key}
     * header makes the call replay-safe: retrying with the same key returns the
     * already-created order instead of creating (and charging) a second one.
     */
    @PostMapping
    @PreAuthorize("hasRole('CUSTOMER')")
    public ResponseEntity<ApiResponse<CheckoutResponse>> checkout(
            @Valid @RequestBody CheckoutRequest request,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        CheckoutResponse result = checkoutCoordinator.checkout(
                principal.getUser().getId(), request, idempotencyKey);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.created("Order placed successfully", result));
    }

    /** List the caller's orders, newest first. */
    @GetMapping
    @PreAuthorize("hasRole('CUSTOMER')")
    public ResponseEntity<ApiResponse<Page<OrderSummaryResponse>>> findMyOrders(
            @AuthenticationPrincipal CustomerUserDetails principal,
            @PageableDefault(size = 20, sort = "createdAt") Pageable pageable) {
        return ResponseEntity.ok(ApiResponse.ok(
                orderService.findMyOrders(principal.getUser().getId(), pageable)));
    }

    /** Fetch one of the caller's orders in full. */
    @GetMapping("/{id}")
    @PreAuthorize("hasRole('CUSTOMER')")
    public ResponseEntity<ApiResponse<OrderResponse>> findById(
            @PathVariable UUID id,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        return ResponseEntity.ok(ApiResponse.ok(
                orderService.findById(principal.getUser().getId(), id)));
    }

    /** Cancel one of the caller's orders (restocks the items). */
    @PostMapping("/{id}/cancel")
    @PreAuthorize("hasRole('CUSTOMER')")
    public ResponseEntity<ApiResponse<OrderResponse>> cancel(
            @PathVariable UUID id,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        return ResponseEntity.ok(ApiResponse.ok("Order cancelled",
                orderService.cancel(principal.getUser().getId(), id)));
    }

    /**
     * Manually confirm payment for an order. Temporary admin-only stand-in for the
     * future Stripe webhook; moves a PENDING_PAYMENT order to PAID.
     */
    @PostMapping("/{id}/pay")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<ApiResponse<OrderResponse>> markPaid(@PathVariable UUID id) {
        return ResponseEntity.ok(ApiResponse.ok("Order marked as paid", orderService.markPaid(id)));
    }
}
