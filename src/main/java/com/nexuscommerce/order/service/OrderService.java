package com.nexuscommerce.order.service;

import com.nexuscommerce.cart.entity.Cart;
import com.nexuscommerce.cart.entity.CartItem;
import com.nexuscommerce.cart.repository.CartItemRepository;
import com.nexuscommerce.cart.repository.CartRepository;
import com.nexuscommerce.order.dto.CheckoutRequest;
import com.nexuscommerce.order.dto.CheckoutResponse;
import com.nexuscommerce.order.dto.OrderResponse;
import com.nexuscommerce.order.dto.OrderSummaryResponse;
import com.nexuscommerce.order.entity.CancellationActor;
import com.nexuscommerce.order.entity.Order;
import com.nexuscommerce.order.entity.OrderItem;
import com.nexuscommerce.order.entity.OrderStatus;
import com.nexuscommerce.order.exception.EmptyCartException;
import com.nexuscommerce.order.exception.IdempotencyKeyConflictException;
import com.nexuscommerce.order.exception.InvalidOrderStateException;
import com.nexuscommerce.order.exception.OrderNotFoundException;
import com.nexuscommerce.order.exception.OutOfStockException;
import com.nexuscommerce.order.exception.ProductUnavailableException;
import com.nexuscommerce.order.repository.OrderRepository;
import com.nexuscommerce.payment.MoneyUnits;
import com.nexuscommerce.payment.PaymentAmountMismatchException;
import com.nexuscommerce.payment.PaymentEventHandler;
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
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

@Slf4j
@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class OrderService implements PaymentEventHandler {

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
     *
     * <p>Callers go through {@link CheckoutCoordinator}, which handles
     * Idempotency-Key replay around this method; {@code idempotencyKey} and
     * {@code requestHash} are stamped here so the V6 partial unique index turns
     * a same-key race into a conflict the coordinator resolves by replaying.
     */
    @Transactional
    public CheckoutResponse checkout(UUID userId, CheckoutRequest request,
                                     String idempotencyKey, String requestHash) {
        Cart cart = cartRepository.findByUserIdAndDeletedFalse(userId)
                .orElseThrow(EmptyCartException::new);

        List<CartItem> items = cartItemRepository.findByCartIdAndDeletedFalse(cart.getId());
        if (items.isEmpty()) {
            throw new EmptyCartException();
        }

        UserAddress address = addressRepository.findByIdAndUserIdAndDeletedFalse(request.addressId(), userId)
                .orElseThrow(() -> new AddressNotFoundException(request.addressId()));

        Order order = newOrderFor(userId, address);
        order.setIdempotencyKey(idempotencyKey);
        order.setRequestHash(requestHash);

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

        // Initiate payment. Manual → PENDING with a generated reference; Stripe →
        // PENDING with a PaymentIntent id + a clientSecret the client confirms with.
        PaymentInitiation payment = paymentGateway.initiate(
                new PaymentRequest(order.getOrderNumber(), order.getGrandTotal(), order.getCurrency()));
        order.setPaymentStatus(payment.status());
        order.setPaymentReference(payment.reference());
        // Stored so the Stripe webhook can reconcile its event back to this order.
        order.setPaymentIntentId(payment.reference());

        Order saved = orderRepository.save(order);

        // Cart consumed by the order — soft-delete its items.
        items.forEach(i -> i.setDeleted(true));

        // clientSecret is returned to the client but never persisted on the order.
        return CheckoutResponse.of(OrderResponse.from(saved), payment.clientSecret());
    }

    /**
     * Replay path for idempotent checkout: returns the response for an order
     * already created under this (user, Idempotency-Key) pair, or empty if none
     * exists yet.
     *
     * <p>A still-pending order re-fetches its {@code clientSecret} from the
     * gateway (it is deliberately never persisted); a terminal order
     * (cancelled/failed) replays without a secret — the client must start a
     * fresh checkout with a new key.
     *
     * @throws IdempotencyKeyConflictException if the key exists but was used
     *         with a different request body
     */
    public Optional<CheckoutResponse> replayCheckout(UUID userId, String idempotencyKey, String requestHash) {
        Order existing = orderRepository
                .findByUserIdAndIdempotencyKeyAndDeletedFalse(userId, idempotencyKey)
                .orElse(null);
        if (existing == null) {
            return Optional.empty();
        }
        if (!requestHash.equals(existing.getRequestHash())) {
            throw new IdempotencyKeyConflictException();
        }
        String clientSecret = existing.getStatus() == OrderStatus.PENDING_PAYMENT
                ? paymentGateway.findClientSecret(existing.getPaymentIntentId()).orElse(null)
                : null;
        log.info("Replaying checkout for order {} (idempotency key reuse)", existing.getOrderNumber());
        return Optional.of(CheckoutResponse.of(OrderResponse.from(existing), clientSecret));
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
     * Customer-initiated cancellation. Allowed for any unshipped order
     * (PENDING_PAYMENT, PAID, CONFIRMED). Every state change goes through an
     * atomic claim shared with the webhook/expiry paths, so a concurrent
     * cancellation (double-click, the webhook echo of our own gateway cancel,
     * a dashboard refund) can never double-restock — only the claim winner
     * releases stock; a losing claim re-reads and returns the settled order.
     * <ul>
     *   <li>a paid order is refunded through the gateway first — if the refund
     *       fails, nothing changes (the gateway error propagates);</li>
     *   <li>an unpaid order's PaymentIntent is cancelled at the gateway so it can
     *       never be confirmed afterwards; if the payment is mid-flight the
     *       cancellation is rejected and the customer retries once the webhook
     *       settles the outcome.</li>
     * </ul>
     */
    @Transactional
    public OrderResponse cancel(UUID userId, UUID orderId) {
        Order order = orderRepository.findByIdAndUserIdAndDeletedFalse(orderId, userId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));

        boolean cancellable = order.getStatus() == OrderStatus.PENDING_PAYMENT
                || order.getStatus() == OrderStatus.PAID
                || order.getStatus() == OrderStatus.CONFIRMED;
        if (!cancellable) {
            throw new InvalidOrderStateException(
                    "An order with status " + order.getStatus() + " can no longer be cancelled");
        }

        // Snapshot before the claim — the claim clears the persistence context.
        List<OrderItem> items = List.copyOf(order.getItems());

        int claimed;
        if (order.getStatus() == OrderStatus.PENDING_PAYMENT) {
            // Kill the intent first: without this, the customer could still
            // complete payment for an order we are about to cancel.
            if (order.getPaymentIntentId() != null
                    && !paymentGateway.cancelPayment(order.getPaymentIntentId())) {
                throw new InvalidOrderStateException(
                        "Payment for this order is completing — wait for the result, then cancel or refund");
            }
            claimed = orderRepository.claimPendingCancellation(
                    orderId, "Cancelled by customer", CancellationActor.CUSTOMER);
        } else {
            // Money was captured: return it before claiming. The gateway refund is
            // idempotent (keyed on the intent), so if the claim is then lost to the
            // charge.refunded webhook, no second refund and no second restock occur.
            String refundReference = paymentGateway.refund(
                    order.getPaymentIntentId(), order.getGrandTotal(), order.getCurrency());
            log.info("Refund {} issued for order {}", refundReference, order.getOrderNumber());
            claimed = orderRepository.claimRefundCancellation(
                    orderId, "Cancelled by customer", CancellationActor.CUSTOMER);
        }

        if (claimed == 1) {
            restock(items);
        }

        Order settled = orderRepository.findByIdAndUserIdAndDeletedFalse(orderId, userId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
        if (settled.getStatus() != OrderStatus.CANCELLED) {
            // Lost the claim to a payment that completed concurrently.
            throw new InvalidOrderStateException(
                    "An order with status " + settled.getStatus() + " can no longer be cancelled");
        }
        return OrderResponse.from(settled);
    }

    /**
     * Manual payment confirmation — the operator counterpart of the Stripe
     * webhook, for the manual gateway only (a provider that reports payments
     * itself must never be overridden by hand: the order would read PAID with no
     * money captured, and the real success webhook would then be ignored).
     * The PENDING_PAYMENT → PAID transition is an atomic claim, so it cannot
     * race a concurrent cancellation into an inconsistent state.
     */
    @Transactional
    public OrderResponse markPaid(UUID orderId) {
        if (!paymentGateway.supportsManualConfirmation()) {
            throw new InvalidOrderStateException(
                    "Manual payment confirmation is disabled for the active payment provider");
        }
        Order order = orderRepository.findByIdAndDeletedFalse(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));

        if (orderRepository.claimManualPaid(order.getId()) == 0) {
            Order current = orderRepository.findByIdAndDeletedFalse(orderId)
                    .orElseThrow(() -> new OrderNotFoundException(orderId));
            throw new InvalidOrderStateException(
                    "Only a PENDING_PAYMENT order can be marked paid (current: " + current.getStatus() + ")");
        }
        return OrderResponse.from(orderRepository.findByIdAndDeletedFalse(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId)));
    }

    // ── PaymentEventHandler (verified gateway events) ─────────────────────────

    /**
     * {@inheritDoc}
     *
     * <p>Validates the captured amount and currency against the order before
     * marking it PAID — a mismatch throws, so the webhook event is stored FAILED
     * (replayable after investigation) instead of confirming a wrong amount.
     */
    @Override
    @Transactional
    public void confirmPaymentByIntent(String paymentIntentId, long amountMinor, String reportedCurrency) {
        Order order = orderRepository.findByPaymentIntentIdAndDeletedFalse(paymentIntentId).orElse(null);
        if (order == null) {
            log.warn("Payment succeeded for unknown intent {} — ignoring", paymentIntentId);
            return;
        }
        if (order.getStatus() == OrderStatus.PAID) {
            return; // already reconciled by an earlier delivery of this event
        }
        if (order.getStatus() != OrderStatus.PENDING_PAYMENT) {
            // CANCELLED here means the customer was charged for an order we no
            // longer honour — loud, ops must refund (or the expiry/cancel path
            // failed to kill the intent).
            log.error("Payment succeeded for order {} in unexpected state {} — manual review required",
                    order.getOrderNumber(), order.getStatus());
            return;
        }

        long expectedMinor = MoneyUnits.toMinorUnits(order.getGrandTotal(), order.getCurrency());
        if (expectedMinor != amountMinor || !order.getCurrency().equalsIgnoreCase(reportedCurrency)) {
            throw new PaymentAmountMismatchException(order.getOrderNumber(),
                    expectedMinor, amountMinor, order.getCurrency(), reportedCurrency);
        }

        order.setStatus(OrderStatus.PAID);
        order.setPaymentStatus(PaymentStatus.SUCCEEDED);
    }

    /**
     * {@inheritDoc}
     *
     * <p>Deliberately does NOT restock or cancel: a declined attempt is not
     * terminal — the customer can retry the same PaymentIntent. Stock for truly
     * abandoned orders is released by the expiry job, which also cancels the
     * intent so it cannot succeed afterwards.
     */
    @Override
    @Transactional
    public void recordPaymentFailureByIntent(String paymentIntentId) {
        Order order = orderRepository.findByPaymentIntentIdAndDeletedFalse(paymentIntentId).orElse(null);
        if (order == null) {
            log.warn("Payment failed for unknown intent {} — ignoring", paymentIntentId);
            return;
        }
        order.setLastPaymentFailureAt(Instant.now());
        if (order.getStatus() == OrderStatus.PENDING_PAYMENT) {
            order.setPaymentStatus(PaymentStatus.FAILED);
        }
        log.info("Recorded failed payment attempt for order {}", order.getOrderNumber());
    }

    @Override
    @Transactional
    public void cancelPaymentByIntent(String paymentIntentId) {
        Order order = orderRepository.findByPaymentIntentIdAndDeletedFalse(paymentIntentId).orElse(null);
        if (order == null) {
            log.warn("Payment cancelled for unknown intent {} — ignoring", paymentIntentId);
            return;
        }
        if (order.getStatus() != OrderStatus.PENDING_PAYMENT) {
            // Includes the expiry job's own intent-cancel echoing back, and the
            // customer-cancel path — both already CANCELLED and restocked.
            return;
        }
        // Snapshot lines before the claim; only the claim winner may restock.
        List<OrderItem> items = List.copyOf(order.getItems());
        int claimed = orderRepository.claimPendingCancellation(
                order.getId(), "Payment cancelled at the provider", CancellationActor.GATEWAY);
        if (claimed == 1) {
            restock(items);
            log.info("Order {} cancelled after its PaymentIntent was cancelled at the provider",
                    order.getOrderNumber());
        }
    }

    /**
     * {@inheritDoc}
     *
     * <p>Reconciliation source of truth for refunds. Our own refund-on-cancel
     * already set REFUNDED/CANCELLED and restocked — this no-ops. A dashboard
     * refund of a paid order applies the same outcome here. Partial refunds are
     * out of scope until returns/RMA (Phase 5): logged, no state change.
     */
    @Override
    @Transactional
    public void recordRefundByIntent(String paymentIntentId, long amountRefundedMinor, String reportedCurrency) {
        Order order = orderRepository.findByPaymentIntentIdAndDeletedFalse(paymentIntentId).orElse(null);
        if (order == null) {
            log.warn("Refund reported for unknown intent {} — ignoring", paymentIntentId);
            return;
        }
        if (order.getPaymentStatus() == PaymentStatus.REFUNDED) {
            return; // already reconciled (our own cancel path, or a redelivery)
        }

        long totalMinor = MoneyUnits.toMinorUnits(order.getGrandTotal(), order.getCurrency());
        if (amountRefundedMinor < totalMinor) {
            log.warn("Partial refund ({} of {} minor units) reported for order {} — " +
                            "partial refunds are unsupported until returns/RMA; no state change",
                    amountRefundedMinor, totalMinor, order.getOrderNumber());
            return;
        }

        // Snapshot before the claim — the claim clears the persistence context.
        List<OrderItem> items = List.copyOf(order.getItems());

        // Stock-holding order (dashboard refund of a PAID order): the claim is
        // shared with customer cancel-with-refund, so whichever lands first does
        // the single restock; the other becomes a no-op below.
        if (orderRepository.claimRefundCancellation(
                order.getId(), "Refunded at the payment provider", CancellationActor.GATEWAY) == 1) {
            restock(items);
            log.info("Order {} reconciled as fully refunded", order.getOrderNumber());
            return;
        }

        // Already CANCELLED (stock already returned by the cancelling path) —
        // just make the payment status reflect the refund.
        if (orderRepository.markRefundedOnCancelled(order.getId()) == 1) {
            log.info("Order {} marked refunded (was already cancelled)", order.getOrderNumber());
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private void restock(List<OrderItem> items) {
        items.forEach(item ->
                productRepository.incrementStock(item.getProductId(), item.getQuantity()));
    }

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
