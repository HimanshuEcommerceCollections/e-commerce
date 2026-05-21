package com.nexuscommerce.product.service;

import com.nexuscommerce.product.dto.ProductCreateRequest;
import com.nexuscommerce.product.dto.ProductDetailResponse;
import com.nexuscommerce.product.dto.ProductSummaryResponse;
import com.nexuscommerce.product.dto.ProductUpdateRequest;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductCategory;
import com.nexuscommerce.product.entity.ProductStatus;
import com.nexuscommerce.product.exception.CategoryNotFoundException;
import com.nexuscommerce.product.exception.ProductNotFoundException;
import com.nexuscommerce.product.exception.ProductOwnershipException;
import com.nexuscommerce.product.exception.SkuAlreadyExistsException;
import com.nexuscommerce.product.mapper.ProductMapper;
import com.nexuscommerce.product.repository.ProductCategoryRepository;
import com.nexuscommerce.product.repository.ProductRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional
public class ProductService {

    private final ProductRepository productRepository;
    private final ProductCategoryRepository categoryRepository;
    private final ProductMapper productMapper;

    public ProductDetailResponse create(ProductCreateRequest request, UUID merchantId) {
        if (productRepository.existsBySkuAndDeletedFalse(request.sku())) {
            throw new SkuAlreadyExistsException(request.sku());
        }

        ProductCategory category = resolveCategory(request.categoryId());

        Product product = Product.builder()
                .name(request.name())
                .description(request.description())
                .price(request.price())
                .stockQuantity(request.stockQuantity())
                .sku(request.sku())
                .status(ProductStatus.DRAFT)
                .imageUrls(request.imageUrls() != null ? new ArrayList<>(request.imageUrls()) : new ArrayList<>())
                .category(category)
                .merchantId(merchantId)
                .build();

        return productMapper.toDetailResponse(productRepository.save(product));
    }

    public ProductDetailResponse update(UUID productId, ProductUpdateRequest request, UUID merchantId) {
        Product product = getOwnedProduct(productId, merchantId);

        if (request.sku() != null && !request.sku().equals(product.getSku())
                && productRepository.existsBySkuAndIdNotAndDeletedFalse(request.sku(), productId)) {
            throw new SkuAlreadyExistsException(request.sku());
        }

        if (request.name() != null) product.setName(request.name());
        if (request.description() != null) product.setDescription(request.description());
        if (request.price() != null) product.setPrice(request.price());
        if (request.stockQuantity() != null) product.setStockQuantity(request.stockQuantity());
        if (request.sku() != null) product.setSku(request.sku());
        if (request.status() != null) product.setStatus(request.status());
        if (request.imageUrls() != null) product.setImageUrls(new ArrayList<>(request.imageUrls()));
        if (request.categoryId() != null) product.setCategory(resolveCategory(request.categoryId()));

        return productMapper.toDetailResponse(product);
    }

    public void softDelete(UUID productId, UUID merchantId) {
        Product product = getOwnedProduct(productId, merchantId);
        product.setDeleted(true);
    }

    @Transactional(readOnly = true)
    public ProductDetailResponse findById(UUID id) {
        return productRepository.findByIdAndDeletedFalse(id)
                .map(productMapper::toDetailResponse)
                .orElseThrow(() -> new ProductNotFoundException(id));
    }

    @Transactional(readOnly = true)
    public Page<ProductSummaryResponse> findAllActive(Pageable pageable) {
        return productRepository.findByStatusAndDeletedFalse(ProductStatus.ACTIVE, pageable)
                .map(productMapper::toSummaryResponse);
    }

    @Transactional(readOnly = true)
    public Page<ProductSummaryResponse> findByMerchant(UUID merchantId, Pageable pageable) {
        return productRepository.findByMerchantIdAndDeletedFalse(merchantId, pageable)
                .map(productMapper::toSummaryResponse);
    }

    @Transactional(readOnly = true)
    public Page<ProductSummaryResponse> findByCategory(UUID categoryId, Pageable pageable) {
        return productRepository.findByCategoryIdAndStatusAndDeletedFalse(categoryId, ProductStatus.ACTIVE, pageable)
                .map(productMapper::toSummaryResponse);
    }

    private Product getOwnedProduct(UUID productId, UUID merchantId) {
        Product product = productRepository.findByIdAndDeletedFalse(productId)
                .orElseThrow(() -> new ProductNotFoundException(productId));
        if (!product.getMerchantId().equals(merchantId)) {
            throw new ProductOwnershipException();
        }
        return product;
    }

    private ProductCategory resolveCategory(UUID categoryId) {
        if (categoryId == null) return null;
        return categoryRepository.findById(categoryId)
                .filter(c -> !c.isDeleted())
                .orElseThrow(() -> new CategoryNotFoundException(categoryId));
    }
}
