package com.nexuscommerce.cart.dto;

import java.math.BigDecimal;
import java.util.UUID;

public record CartItemResponse(
        UUID productId,
        String productName,
        String sku,
        String primaryImageUrl,
        BigDecimal unitPrice,
        int quantity,
        BigDecimal subtotal,
        boolean available
) {}
