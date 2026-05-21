package com.nexuscommerce.product.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CategoryCreateRequest(
        @NotBlank @Size(max = 100) String name,
        @NotBlank @Size(max = 120) String slug,
        @Size(max = 500) String description
) {}
