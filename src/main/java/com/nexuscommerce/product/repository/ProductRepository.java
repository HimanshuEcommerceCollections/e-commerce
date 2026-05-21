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

    boolean existsBySkuAndDeletedFalse(String sku);

    boolean existsBySkuAndIdNotAndDeletedFalse(String sku, UUID id);

    Optional<Product> findByIdAndDeletedFalse(UUID id);
}
