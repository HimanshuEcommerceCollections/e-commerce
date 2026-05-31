package com.nexuscommerce.product.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(
    name = "products",
    uniqueConstraints = @UniqueConstraint(columnNames = "sku", name = "uk_products_sku")
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Product extends BaseEntity {

    @Column(nullable = false, length = 255)
    private String name;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal price;

    @Column(nullable = false)
    private int stockQuantity;

    @Column(nullable = false, unique = true, length = 100)
    private String sku;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private ProductStatus status = ProductStatus.DRAFT;

    @OneToMany(mappedBy = "product", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("position ASC")
    @Builder.Default
    private List<ProductImage> images = new ArrayList<>();

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "category_id")
    private ProductCategory category;

    // Stored as plain UUID — no @ManyToOne to User to keep modules decoupled
    @Column(nullable = false)
    private UUID merchantId;

    // Optimistic lock — guards stockQuantity (and other fields) against lost
    // updates under concurrent writes (e.g. simultaneous checkout decrements).
    // Hibernate manages this column; it is intentionally not set via the builder.
    @Version
    private Long version;

    // ── Image gallery helpers ───────────────────────────────────────────────
    // Keep both sides of the bidirectional relationship in sync. Mutate this
    // collection in place (never reassign it) so orphanRemoval can track deletes.

    public void addImage(ProductImage image) {
        image.setProduct(this);
        images.add(image);
    }

    public void clearImages() {
        images.clear();
    }

    /**
     * URL of the primary image, or — if none is flagged primary — the first image
     * by display order. {@code null} when the product has no images.
     */
    public String getPrimaryImageUrl() {
        return images.stream()
                .filter(ProductImage::isPrimary)
                .findFirst()
                .or(() -> images.stream().findFirst())
                .map(ProductImage::getUrl)
                .orElse(null);
    }
}
