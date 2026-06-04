package com.nexuscommerce.order.dto;

import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Lightweight order view for list endpoints. Intentionally omits line items so
 * listing a customer's orders never triggers per-row lazy loading (no N+1).
 */
public record OrderSummaryResponse(
        UUID id,
        String orderNumber,
        OrderStatus status,
        String currency,
        BigDecimal grandTotal,
        Instant createdAt
) {
    public static OrderSummaryResponse from(Order order) {
        return new OrderSummaryResponse(
                order.getId(),
                order.getOrderNumber(),
                order.getStatus(),
                order.getCurrency(),
                order.getGrandTotal(),
                order.getCreatedAt()
        );
    }
}
