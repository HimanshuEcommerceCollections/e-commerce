package com.nexuscommerce.order.dto;

import jakarta.validation.constraints.NotNull;

import java.util.UUID;

/**
 * Request to place an order from the caller's current cart.
 *
 * @param addressId one of the caller's saved addresses to ship to (snapshotted onto the order)
 */
public record CheckoutRequest(

    @NotNull(message = "Shipping address id is required")
    UUID addressId
) {}
