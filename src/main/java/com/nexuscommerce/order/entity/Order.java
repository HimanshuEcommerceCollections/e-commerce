package com.nexuscommerce.order.entity;

import com.nexuscommerce.common.entity.BaseEntity;
import com.nexuscommerce.payment.PaymentStatus;
import jakarta.persistence.*;
import lombok.*;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * A placed order — a self-contained historical record.
 *
 * <p>It snapshots everything it displays so later edits/soft-deletes to the
 * source rows never rewrite history: line prices/names/SKUs are copied onto
 * {@link OrderItem}, and the shipping address is copied into the {@code ship_*}
 * columns rather than referencing {@code user_addresses}.
 *
 * <p>Owner is stored as a plain {@code userId} (no {@code @ManyToOne} to User) to
 * keep modules decoupled, mirroring the cart/product convention.
 */
@Entity
@Table(
    name = "orders",
    uniqueConstraints = @UniqueConstraint(columnNames = "order_number", name = "uk_orders_order_number"),
    indexes = @Index(name = "idx_orders_user_id", columnList = "user_id, deleted")
)
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Order extends BaseEntity {

    @Column(nullable = false)
    private UUID userId;

    /** Human-readable reference shown to customers (e.g. {@code NX-...}). Globally unique. */
    @Column(name = "order_number", nullable = false, length = 40)
    private String orderNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private OrderStatus status;

    /** ISO-4217 currency code for every money field on this order. */
    @Column(nullable = false, length = 3)
    private String currency;

    // ── Money breakdown (all BigDecimal(12,2)) ───────────────────────────────
    // v1 only populates subtotal == grandTotal; tax/shipping/discount stay 0 but
    // exist so adding them later is a service change, not a schema change.

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal subtotal;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal taxTotal;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal shippingTotal;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal discountTotal;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal grandTotal;

    // ── Payment (populated by the gateway; nullable until initiated) ──────────

    @Enumerated(EnumType.STRING)
    @Column(length = 20)
    private PaymentStatus paymentStatus;

    /** Gateway reference for reconciliation (generated id today, Stripe id later). */
    @Column(length = 255)
    private String paymentReference;

    /** Reserved for Stripe — the PaymentIntent id. Unused by the manual gateway. */
    @Column(length = 255)
    private String paymentIntentId;

    // ── Shipping address snapshot ─────────────────────────────────────────────

    @Column(nullable = false, length = 200)
    private String shipRecipientName;

    @Column(length = 20)
    private String shipPhone;

    @Column(nullable = false, length = 255)
    private String shipAddressLine1;

    @Column(length = 255)
    private String shipAddressLine2;

    @Column(nullable = false, length = 100)
    private String shipCity;

    @Column(nullable = false, length = 100)
    private String shipState;

    @Column(nullable = false, length = 20)
    private String shipPostalCode;

    @Column(nullable = false, length = 100)
    private String shipCountry;

    // ── Line items ─────────────────────────────────────────────────────────────

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    @Builder.Default
    private List<OrderItem> items = new ArrayList<>();

    /** Attach a line item, keeping both sides of the relationship in sync. */
    public void addItem(OrderItem item) {
        item.setOrder(this);
        items.add(item);
    }
}
