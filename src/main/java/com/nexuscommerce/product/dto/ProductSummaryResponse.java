package com.nexuscommerce.product.dto;

import com.nexuscommerce.product.entity.ProductStatus;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

public record ProductSummaryResponse(
        UUID id,
        String name,
        BigDecimal price,
        int stockQuantity,
        String sku,
        ProductStatus status,
        String categoryName,
        String primaryImageUrl,
        UUID merchantId,
        Instant createdAt
) {}
