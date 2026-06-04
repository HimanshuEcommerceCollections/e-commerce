package com.nexuscommerce.order.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * A single line of an {@link Order}. All product-derived fields are snapshots
 * taken at checkout time — the live product may later change price, be renamed,
 * or be soft-deleted without affecting placed orders.
 *
 * <p>{@code merchantId} is snapshotted per line so a multi-vendor order can be
 * split, reported, and (later) paid out per merchant without re-reading products.
 */
@Entity
@Table(
    name = "order_items",
    indexes = {
        @Index(name = "idx_order_items_order_id", columnList = "order_id"),
        @Index(name = "idx_order_items_merchant_id", columnList = "merchant_id, deleted")
    }
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OrderItem extends BaseEntity {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id", nullable = false)
    private Order order;

    @Column(nullable = false)
    private UUID productId;

    @Column(nullable = false)
    private UUID merchantId;

    @Column(nullable = false, length = 255)
    private String productName;

    @Column(nullable = false, length = 100)
    private String sku;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal unitPrice;

    @Column(nullable = false)
    private int quantity;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal lineTotal;
}
