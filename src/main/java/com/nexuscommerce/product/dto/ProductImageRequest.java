package com.nexuscommerce.product.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/**
 * One image in a product's gallery. Display order is taken from the position of
 * this element within the request list, so callers send images in display order
 * rather than supplying an explicit position.
 */
public record ProductImageRequest(
        @NotBlank @Size(max = 2048) String url,
        @Size(max = 255) String altText,
        boolean primary,
        @Positive Integer width,
        @Positive Integer height,
        @Size(max = 100) String contentType,
        @Positive Long fileSizeBytes,
        @Size(max = 512) String storageKey
) {}
