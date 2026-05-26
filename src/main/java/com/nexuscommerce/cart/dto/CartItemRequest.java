package com.nexuscommerce.cart.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

import java.util.UUID;

public record CartItemRequest(
        @NotNull UUID productId,
        @NotNull @Positive @Max(999) Integer quantity
) {}
