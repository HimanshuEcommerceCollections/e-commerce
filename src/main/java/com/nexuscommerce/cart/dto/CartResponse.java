package com.nexuscommerce.cart.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record CartResponse(
        UUID cartId,
        UUID customerId,
        List<CartItemResponse> items,
        int totalItems,
        BigDecimal totalPrice,
        Instant updatedAt
) {}
