package com.nexuscommerce.product.service;

import com.nexuscommerce.product.dto.ProductCreateRequest;
import com.nexuscommerce.product.dto.ProductDetailResponse;
import com.nexuscommerce.product.dto.ProductImageRequest;
import com.nexuscommerce.product.dto.ProductSummaryResponse;
import com.nexuscommerce.product.dto.ProductUpdateRequest;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductCategory;
import com.nexuscommerce.product.entity.ProductImage;
import com.nexuscommerce.product.entity.ProductStatus;
import com.nexuscommerce.product.exception.CategoryNotFoundException;
import com.nexuscommerce.product.exception.ProductNotFoundException;
import com.nexuscommerce.product.exception.SkuAlreadyExistsException;
import com.nexuscommerce.product.mapper.ProductMapper;
import com.nexuscommerce.product.repository.ProductCategoryRepository;
import com.nexuscommerce.product.repository.ProductRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional
public class ProductService {

    private final ProductRepository productRepository;
    private final ProductCategoryRepository categoryRepository;
    private final ProductMapper productMapper;

    public ProductDetailResponse create(ProductCreateRequest request, UUID merchantId) {
        if (productRepository.existsBySku(request.sku())) {
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
                .category(category)
                .merchantId(merchantId)
                .build();

        applyImages(product, request.images());

        return productMapper.toDetailResponse(productRepository.save(product));
    }

    public ProductDetailResponse update(UUID productId, ProductUpdateRequest request, UUID merchantId) {
        Product product = getOwnedProduct(productId, merchantId);

        if (request.sku() != null && !request.sku().equals(product.getSku())
                && productRepository.existsBySkuAndIdNot(request.sku(), productId)) {
            throw new SkuAlreadyExistsException(request.sku());
        }

        if (request.name() != null) product.setName(request.name());
        if (request.description() != null) product.setDescription(request.description());
        if (request.price() != null) product.setPrice(request.price());
        if (request.stockQuantity() != null) product.setStockQuantity(request.stockQuantity());
        if (request.sku() != null) product.setSku(request.sku());
        if (request.status() != null) product.setStatus(request.status());
        if (request.categoryId() != null) product.setCategory(resolveCategory(request.categoryId()));
        if (request.images() != null) {
            // Full replacement: drop the existing gallery (orphanRemoval deletes the
            // rows) and rebuild it from the request in the given order.
            product.clearImages();
            applyImages(product, request.images());
        }

        return productMapper.toDetailResponse(product);
    }

    public void softDelete(UUID productId, UUID merchantId) {
        Product product = getOwnedProduct(productId, merchantId);
        product.setDeleted(true);
    }

    /**
     * Public product detail lookup.
     *
     * <p>ACTIVE products are visible to everyone. Non-ACTIVE products
     * (DRAFT/INACTIVE/ARCHIVED) are visible only to their owning merchant or an
     * admin; for anyone else they are reported as not found — this both hides
     * unpublished listings and avoids leaking that the product exists.
     *
     * @param requesterId the authenticated caller's id, or {@code null} if anonymous
     * @param isAdmin     whether the caller holds the ADMIN role
     */
    @Transactional(readOnly = true)
    public ProductDetailResponse findById(UUID id, UUID requesterId, boolean isAdmin) {
        Product product = productRepository.findByIdAndDeletedFalse(id)
                .orElseThrow(() -> new ProductNotFoundException(id));

        if (product.getStatus() != ProductStatus.ACTIVE
                && !isAdmin
                && !product.getMerchantId().equals(requesterId)) {
            throw new ProductNotFoundException(id);
        }

        return productMapper.toDetailResponse(product);
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
        // Report a product owned by another merchant as not-found (404) rather
        // than forbidden (403): a 403 would confirm the id exists to a caller
        // who has no right to know that.
        Product product = productRepository.findByIdAndDeletedFalse(productId)
                .orElseThrow(() -> new ProductNotFoundException(productId));
        if (!product.getMerchantId().equals(merchantId)) {
            throw new ProductNotFoundException(productId);
        }
        return product;
    }

    /**
     * Builds {@link ProductImage} children from the request and attaches them to
     * the product in list order. Position is the 0-based index. The single-primary
     * invariant is normalized here (no DB constraint yet): the first image flagged
     * {@code primary} wins; if none is flagged, the first image becomes primary.
     */
    private void applyImages(Product product, List<ProductImageRequest> imageRequests) {
        if (imageRequests == null || imageRequests.isEmpty()) {
            return;
        }

        int primaryIndex = 0;
        for (int i = 0; i < imageRequests.size(); i++) {
            if (imageRequests.get(i).primary()) {
                primaryIndex = i;
                break;
            }
        }

        for (int i = 0; i < imageRequests.size(); i++) {
            ProductImageRequest req = imageRequests.get(i);
            product.addImage(ProductImage.builder()
                    .url(req.url())
                    .altText(req.altText())
                    .position(i)
                    .primary(i == primaryIndex)
                    .width(req.width())
                    .height(req.height())
                    .contentType(req.contentType())
                    .fileSizeBytes(req.fileSizeBytes())
                    .storageKey(req.storageKey())
                    .build());
        }
    }

    private ProductCategory resolveCategory(UUID categoryId) {
        if (categoryId == null) return null;
        return categoryRepository.findById(categoryId)
                .filter(c -> !c.isDeleted())
                .orElseThrow(() -> new CategoryNotFoundException(categoryId));
    }
}
