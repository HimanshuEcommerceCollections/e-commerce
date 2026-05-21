package com.nexuscommerce.product.dto;

import com.nexuscommerce.product.entity.ProductStatus;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record ProductDetailResponse(
        UUID id,
        String name,
        String description,
        BigDecimal price,
        int stockQuantity,
        String sku,
        ProductStatus status,
        CategoryResponse category,
        List<String> imageUrls,
        UUID merchantId,
        Instant createdAt,
        Instant updatedAt
) {}
