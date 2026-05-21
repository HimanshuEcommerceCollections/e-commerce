package com.nexuscommerce.product.controller;

import com.nexuscommerce.auth.security.CustomerUserDetails;
import com.nexuscommerce.common.dto.ApiResponse;
import com.nexuscommerce.product.dto.ProductCreateRequest;
import com.nexuscommerce.product.dto.ProductDetailResponse;
import com.nexuscommerce.product.dto.ProductSummaryResponse;
import com.nexuscommerce.product.dto.ProductUpdateRequest;
import com.nexuscommerce.product.service.ProductService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/products")
@RequiredArgsConstructor
public class ProductController {

    private final ProductService productService;

    @GetMapping
    public ResponseEntity<ApiResponse<Page<ProductSummaryResponse>>> findAllActive(
            @PageableDefault(size = 20, sort = "createdAt") Pageable pageable) {
        return ResponseEntity.ok(ApiResponse.ok(productService.findAllActive(pageable)));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<ProductDetailResponse>> findById(@PathVariable UUID id) {
        return ResponseEntity.ok(ApiResponse.ok(productService.findById(id)));
    }

    @GetMapping("/my")
    @PreAuthorize("hasRole('MERCHANT')")
    public ResponseEntity<ApiResponse<Page<ProductSummaryResponse>>> findMyProducts(
            @AuthenticationPrincipal CustomerUserDetails principal,
            @PageableDefault(size = 20, sort = "createdAt") Pageable pageable) {
        UUID merchantId = principal.getUser().getId();
        return ResponseEntity.ok(ApiResponse.ok(productService.findByMerchant(merchantId, pageable)));
    }

    @GetMapping("/category/{categoryId}")
    public ResponseEntity<ApiResponse<Page<ProductSummaryResponse>>> findByCategory(
            @PathVariable UUID categoryId,
            @PageableDefault(size = 20, sort = "createdAt") Pageable pageable) {
        return ResponseEntity.ok(ApiResponse.ok(productService.findByCategory(categoryId, pageable)));
    }

    @PostMapping
    @PreAuthorize("hasRole('MERCHANT')")
    public ResponseEntity<ApiResponse<ProductDetailResponse>> create(
            @Valid @RequestBody ProductCreateRequest request,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID merchantId = principal.getUser().getId();
        ProductDetailResponse data = productService.create(request, merchantId);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.created("Product listed successfully", data));
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasRole('MERCHANT')")
    public ResponseEntity<ApiResponse<ProductDetailResponse>> update(
            @PathVariable UUID id,
            @Valid @RequestBody ProductUpdateRequest request,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID merchantId = principal.getUser().getId();
        ProductDetailResponse data = productService.update(id, request, merchantId);
        return ResponseEntity.ok(ApiResponse.ok("Product updated successfully", data));
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasRole('MERCHANT')")
    public ResponseEntity<ApiResponse<Void>> delete(
            @PathVariable UUID id,
            @AuthenticationPrincipal CustomerUserDetails principal) {
        UUID merchantId = principal.getUser().getId();
        productService.softDelete(id, merchantId);
        return ResponseEntity.ok(ApiResponse.noContent("Product removed successfully"));
    }
}
