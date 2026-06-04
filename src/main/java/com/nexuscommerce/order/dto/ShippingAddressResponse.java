package com.nexuscommerce.order.dto;

import com.nexuscommerce.order.entity.Order;

/**
 * The shipping address as snapshotted on the order (not a live address row).
 */
public record ShippingAddressResponse(
        String recipientName,
        String phone,
        String addressLine1,
        String addressLine2,
        String city,
        String state,
        String postalCode,
        String country
) {
    public static ShippingAddressResponse from(Order order) {
        return new ShippingAddressResponse(
                order.getShipRecipientName(),
                order.getShipPhone(),
                order.getShipAddressLine1(),
                order.getShipAddressLine2(),
                order.getShipCity(),
                order.getShipState(),
                order.getShipPostalCode(),
                order.getShipCountry()
        );
    }
}
