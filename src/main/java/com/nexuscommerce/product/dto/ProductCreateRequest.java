package com.nexuscommerce.product.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

public record ProductCreateRequest(
        @NotBlank @Size(max = 255) String name,
        @Size(max = 5000) String description,
        @NotNull @Positive BigDecimal price,
        @NotNull @PositiveOrZero Integer stockQuantity,
        @NotBlank @Size(max = 100) String sku,
        UUID categoryId,
        @Valid @Size(max = 10) List<ProductImageRequest> images
) {}
