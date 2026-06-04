package com.nexuscommerce.order.dto;

import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.payment.PaymentStatus;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Full order detail, including line items and the shipping snapshot.
 */
public record OrderResponse(
        UUID id,
        String orderNumber,
        OrderStatus status,
        String currency,
        BigDecimal subtotal,
        BigDecimal taxTotal,
        BigDecimal shippingTotal,
        BigDecimal discountTotal,
        BigDecimal grandTotal,
        PaymentStatus paymentStatus,
        ShippingAddressResponse shippingAddress,
        List<OrderItemResponse> items,
        Instant createdAt,
        Instant updatedAt
) {
    public static OrderResponse from(Order order) {
        List<OrderItemResponse> items = order.getItems().stream()
                .map(OrderItemResponse::from)
                .toList();
        return new OrderResponse(
                order.getId(),
                order.getOrderNumber(),
                order.getStatus(),
                order.getCurrency(),
                order.getSubtotal(),
                order.getTaxTotal(),
                order.getShippingTotal(),
                order.getDiscountTotal(),
                order.getGrandTotal(),
                order.getPaymentStatus(),
                ShippingAddressResponse.from(order),
                items,
                order.getCreatedAt(),
                order.getUpdatedAt()
        );
    }
}
