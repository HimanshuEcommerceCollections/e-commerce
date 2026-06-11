package com.nexuscommerce.product.repository;

import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;
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

    /** Batch lookup for cart rendering — one query instead of one per line. */
    List<Product> findByIdInAndDeletedFalse(Collection<UUID> ids);

    // ── Stock movements ───────────────────────────────────────────────────────
    // Atomic conditional decrement: the `stockQuantity >= :qty` guard makes the
    // check-and-decrement a single statement, so concurrent checkouts of the last
    // units can never oversell — no row lock, no retry. A return of 0 means the
    // product is gone/inactive or stock was insufficient; the caller distinguishes.
    // (Bulk updates bypass @Version, which is fine: the WHERE clause is the guard.)
    @Modifying
    @Query("""
            UPDATE Product p
               SET p.stockQuantity = p.stockQuantity - :qty
             WHERE p.id = :id
               AND p.deleted = false
               AND p.status = com.nexuscommerce.product.entity.ProductStatus.ACTIVE
               AND p.stockQuantity >= :qty
            """)
    int decrementStock(@Param("id") UUID id, @Param("qty") int qty);

    /** Return units to stock — used when an order is cancelled/refunded. */
    @Modifying
    @Query("UPDATE Product p SET p.stockQuantity = p.stockQuantity + :qty WHERE p.id = :id")
    int incrementStock(@Param("id") UUID id, @Param("qty") int qty);
}
