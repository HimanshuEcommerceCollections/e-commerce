package com.nexuscommerce.product.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "product_images")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ProductImage extends BaseEntity {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "product_id", nullable = false)
    private Product product;

    @Column(nullable = false, length = 2048)
    private String url;

    @Column(length = 255)
    private String altText;

    /** Display order within the product's gallery (0-based, ascending). */
    @Column(nullable = false)
    private int position;

    /**
     * Marks the gallery's primary/thumbnail image. Exactly one image per product
     * should be primary; that invariant is normalized in {@code ProductService}.
     * ({@code primary} is a SQL reserved word, hence the {@code is_primary} column.)
     */
    @Column(name = "is_primary", nullable = false)
    @Builder.Default
    private boolean primary = false;

    // ── Media metadata ────────────────────────────────────────────────────────

    /** Intrinsic pixel width, if known. */
    @Column
    private Integer width;

    /** Intrinsic pixel height, if known. */
    @Column
    private Integer height;

    /** MIME type, e.g. {@code image/webp}. */
    @Column(length = 100)
    private String contentType;

    /** Original file size in bytes, if known. */
    @Column
    private Long fileSizeBytes;

    /** Object-storage / CDN key (e.g. an S3 object key) backing {@link #url}. */
    @Column(length = 512)
    private String storageKey;
}
