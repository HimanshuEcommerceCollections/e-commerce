package com.nexuscommerce.product.repository;

import com.nexuscommerce.product.entity.ProductCategory;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;
import java.util.UUID;

public interface ProductCategoryRepository extends JpaRepository<ProductCategory, UUID> {

    Optional<ProductCategory> findBySlug(String slug);

    boolean existsBySlug(String slug);
}
