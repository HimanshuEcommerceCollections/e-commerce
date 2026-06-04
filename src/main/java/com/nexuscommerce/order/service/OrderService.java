package com.nexuscommerce.order.service;

import com.nexuscommerce.cart.entity.Cart;
import com.nexuscommerce.cart.entity.CartItem;
import com.nexuscommerce.cart.repository.CartItemRepository;
import com.nexuscommerce.cart.repository.CartRepository;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.OrderResponse;
import com.nexuscommerce.order.dto.OrderSummaryResponse;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderItem;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.exception.EmptyCartException;
import com.nexuscommerce.order.exception.InvalidOrderStateException;
import com.nexuscommerce.order.exception.OrderNotFoundException;
import com.nexuscommerce.order.exception.OutOfStockException;
import com.nexuscommerce.order.exception.ProductUnavailableException;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.payment.PaymentGateway;
import com.nexuscommerce.payment.PaymentInitiation;
import com.nexuscommerce.payment.PaymentRequest;
import com.nexuscommerce.payment.PaymentStatus;
import com.nexuscommerce.product.entity.Product;
import com.nexuscommerce.product.entity.ProductStatus;
import com.nexuscommerce.product.repository.ProductRepository;
import com.nexuscommerce.user.address.entity.UserAddress;
import com.nexuscommerce.user.address.exception.AddressNotFoundException;
import com.nexuscommerce.user.address.repository.UserAddressRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class OrderService {

    private final OrderRepository orderRepository;
    private final CartRepository cartRepository;
    private final CartItemRepository cartItemRepository;
    private final ProductRepository productRepository;
    private final UserAddressRepository addressRepository;
    private final PaymentGateway paymentGateway;

    @Value("${app.order.currency:USD}")
    private String currency;

    /**
     * Place an order from the caller's cart in a single transaction:
     * validate → snapshot price/name/merchant → atomically decrement stock →
     * persist the order → clear the cart → initiate payment. Any failure rolls
     * the whole thing back, so stock is never decremented for an order that
     * isn't created.
     */
    @Transactional
    public OrderResponse checkout(UUID userId, CheckoutRequest request) {
        Cart cart = cartRepository.findByUserIdAndDeletedFalse(userId)
                .orElseThrow(EmptyCartException::new);

        List<CartItem> items = cartItemRepository.findByCartIdAndDeletedFalse(cart.getId());
        if (items.isEmpty()) {
            throw new EmptyCartException();
        }

        UserAddress address = addressRepository.findByIdAndUserIdAndDeletedFalse(request.addressId(), userId)
                .orElseThrow(() -> new AddressNotFoundException(request.addressId()));

        Order order = newOrderFor(userId, address);

        BigDecimal subtotal = BigDecimal.ZERO;
        for (CartItem item : items) {
            Product product = productRepository.findByIdAndDeletedFalse(item.getProductId())
                    .orElseThrow(() -> new ProductUnavailableException(item.getProductId()));
            if (product.getStatus() != ProductStatus.ACTIVE) {
                throw new ProductUnavailableException(product.getId());
            }

            // Atomic check-and-decrement: 0 rows means a concurrent buyer took the
            // last units (availability was already verified just above).
            if (productRepository.decrementStock(product.getId(), item.getQuantity()) == 0) {
                throw new OutOfStockException(product.getName());
            }

            BigDecimal lineTotal = product.getPrice().multiply(BigDecimal.valueOf(item.getQuantity()));
            subtotal = subtotal.add(lineTotal);

            order.addItem(OrderItem.builder()
                    .productId(product.getId())
                    .merchantId(product.getMerchantId())
                    .productName(product.getName())
                    .sku(product.getSku())
                    .unitPrice(product.getPrice())
                    .quantity(item.getQuantity())
                    .lineTotal(lineTotal)
                    .build());
        }

        applyTotals(order, subtotal);

        // Initiate payment (manual today → PENDING; Stripe later → returns a client secret).
        PaymentInitiation payment = paymentGateway.initiate(
                new PaymentRequest(order.getOrderNumber(), order.getGrandTotal(), order.getCurrency()));
        order.setPaymentStatus(payment.status());
        order.setPaymentReference(payment.reference());

        Order saved = orderRepository.save(order);

        // Cart consumed by the order — soft-delete its items.
        items.forEach(i -> i.setDeleted(true));

        return OrderResponse.from(saved);
    }

    public Page<OrderSummaryResponse> findMyOrders(UUID userId, Pageable pageable) {
        return orderRepository.findByUserIdAndDeletedFalseOrderByCreatedAtDesc(userId, pageable)
                .map(OrderSummaryResponse::from);
    }

    public OrderResponse findById(UUID userId, UUID orderId) {
        Order order = orderRepository.findByIdAndUserIdAndDeletedFalse(orderId, userId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
        return OrderResponse.from(order);
    }

    /**
     * Customer-initiated cancellation. Allowed only before fulfilment begins
     * ({@code PENDING_PAYMENT} or {@code PAID}); returns the reserved stock.
     */
    @Transactional
    public OrderResponse cancel(UUID userId, UUID orderId) {
        Order order = orderRepository.findByIdAndUserIdAndDeletedFalse(orderId, userId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));

        if (order.getStatus() != OrderStatus.PENDING_PAYMENT && order.getStatus() != OrderStatus.PAID) {
            throw new InvalidOrderStateException(
                    "An order with status " + order.getStatus() + " can no longer be cancelled");
        }

        order.getItems().forEach(item ->
                productRepository.incrementStock(item.getProductId(), item.getQuantity()));

        order.setStatus(OrderStatus.CANCELLED);
        return OrderResponse.from(order);
    }

    /**
     * Manual payment confirmation — the stand-in for the future Stripe webhook.
     * Moves a {@code PENDING_PAYMENT} order to {@code PAID}.
     */
    @Transactional
    public OrderResponse markPaid(UUID orderId) {
        Order order = orderRepository.findByIdAndDeletedFalse(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));

        if (order.getStatus() != OrderStatus.PENDING_PAYMENT) {
            throw new InvalidOrderStateException(
                    "Only a PENDING_PAYMENT order can be marked paid (current: " + order.getStatus() + ")");
        }

        order.setStatus(OrderStatus.PAID);
        order.setPaymentStatus(PaymentStatus.SUCCEEDED);
        return OrderResponse.from(order);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private Order newOrderFor(UUID userId, UserAddress address) {
        return Order.builder()
                .userId(userId)
                .orderNumber(generateOrderNumber())
                .status(OrderStatus.PENDING_PAYMENT)
                .currency(currency)
                .shipRecipientName(address.getRecipientName())
                .shipPhone(address.getPhone())
                .shipAddressLine1(address.getAddressLine1())
                .shipAddressLine2(address.getAddressLine2())
                .shipCity(address.getCity())
                .shipState(address.getState())
                .shipPostalCode(address.getPostalCode())
                .shipCountry(address.getCountry())
                .build();
    }

    private void applyTotals(Order order, BigDecimal subtotal) {
        order.setSubtotal(subtotal);
        order.setTaxTotal(BigDecimal.ZERO);
        order.setShippingTotal(BigDecimal.ZERO);
        order.setDiscountTotal(BigDecimal.ZERO);
        // grand = subtotal + tax + shipping - discount (only subtotal is non-zero in v1)
        order.setGrandTotal(subtotal
                .add(order.getTaxTotal())
                .add(order.getShippingTotal())
                .subtract(order.getDiscountTotal()));
    }

    private String generateOrderNumber() {
        for (int attempt = 0; attempt < 5; attempt++) {
            String candidate = "NX-"
                    + Long.toString(Instant.now().toEpochMilli(), 36).toUpperCase()
                    + "-"
                    + Integer.toString(ThreadLocalRandom.current().nextInt(0x10000, 0x100000), 36).toUpperCase();
            if (!orderRepository.existsByOrderNumber(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("Unable to generate a unique order number after several attempts");
    }
}
