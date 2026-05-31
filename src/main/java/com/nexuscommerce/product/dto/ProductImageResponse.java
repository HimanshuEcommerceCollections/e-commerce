package com.nexuscommerce.product.dto;

import java.util.UUID;

public record ProductImageResponse(
        UUID id,
        String url,
        String altText,
        int position,
        boolean primary,
        Integer width,
        Integer height,
        String contentType,
        Long fileSizeBytes,
        String storageKey
) {}
