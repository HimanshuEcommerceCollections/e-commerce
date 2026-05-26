package com.nexuscommerce.cart.controller;

import com.nexuscommerce.auth.security.CustomerUserDetails;
import com.nexuscommerce.cart.dto.CartItemRequest;
import com.nexuscommerce.cart.dto.CartItemUpdateRequest;
import com.nexuscommerce.cart.dto.CartResponse;
import com.nexuscommerce.cart.service.CartService;
import com.nexuscommerce.common.dto.ApiResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/cart")
@RequiredArgsConstructor
@PreAuthorize("hasRole('CUSTOMER')")
public class CartController {

    private final CartService cartService;

    @GetMapping
    public ResponseEntity<ApiResponse<CartResponse>> getCart(
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID userId = principal.getUser().getId();
        return ResponseEntity.ok(ApiResponse.ok(cartService.getCart(userId)));
    }

    @PostMapping("/items")
    public ResponseEntity<ApiResponse<CartResponse>> addItem(
            @Valid @RequestBody CartItemRequest request,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID userId = principal.getUser().getId();
        return ResponseEntity.ok(ApiResponse.ok("Item added to cart", cartService.addItem(userId, request)));
    }

    @PutMapping("/items/{productId}")
    public ResponseEntity<ApiResponse<CartResponse>> updateItem(
            @PathVariable UUID productId,
            @Valid @RequestBody CartItemUpdateRequest request,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID userId = principal.getUser().getId();
        return ResponseEntity.ok(ApiResponse.ok("Cart item updated", cartService.updateItem(userId, productId, request)));
    }

    @DeleteMapping("/items/{productId}")
    public ResponseEntity<ApiResponse<Void>> removeItem(
            @PathVariable UUID productId,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID userId = principal.getUser().getId();
        cartService.removeItem(userId, productId);
        return ResponseEntity.ok(ApiResponse.noContent("Item removed from cart"));
    }

    @DeleteMapping
    public ResponseEntity<ApiResponse<Void>> clearCart(
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID userId = principal.getUser().getId();
        cartService.clearCart(userId);
        return ResponseEntity.ok(ApiResponse.noContent("Cart cleared"));
    }
}
