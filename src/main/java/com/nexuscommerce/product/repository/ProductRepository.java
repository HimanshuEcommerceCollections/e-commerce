package com.nexuscommerce.product.repository;

import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface ProductRepository extends JpaRepository<Product, UUID> {

    Page<Product> findByStatusAndDeletedFalse(ProductStatus status, Pageable pageable);

    Page<Product> findByMerchantIdAndDeletedFalse(UUID merchantId, Pageable pageable);

    Page<Product> findByCategoryIdAndStatusAndDeletedFalse(UUID categoryId, ProductStatus status, Pageable pageable);

    // SKU uniqueness is enforced globally by the uk_products_sku DB constraint,
    // which covers soft-deleted rows too. These checks must match that scope
    // (not deleted-aware) so the app rejects duplicates before the insert
    // rather than letting it surface as a DataIntegrityViolation.
    boolean existsBySku(String sku);

    boolean existsBySkuAndIdNot(String sku, UUID id);

    Optional<Product> findByIdAndDeletedFalse(UUID id);
}
