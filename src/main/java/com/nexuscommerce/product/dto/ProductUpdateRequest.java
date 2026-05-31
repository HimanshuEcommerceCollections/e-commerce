package com.nexuscommerce.product.dto;

import com.nexuscommerce.product.entity.ProductStatus;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

public record ProductUpdateRequest(
        @Size(max = 255) String name,
        @Size(max = 5000) String description,
        @Positive BigDecimal price,
        @PositiveOrZero Integer stockQuantity,
        @Size(max = 100) String sku,
        ProductStatus status,
        UUID categoryId,
        @Valid @Size(max = 10) List<ProductImageRequest> images
) {}
