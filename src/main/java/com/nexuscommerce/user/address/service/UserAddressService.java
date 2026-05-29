package com.nexuscommerce.user.address.service;

import com.nexuscommerce.user.address.dto.AddressRequest;
import com.nexuscommerce.user.address.dto.AddressResponse;
import com.nexuscommerce.user.address.entity.UserAddress;
import com.nexuscommerce.user.address.exception.AddressLimitExceededException;
import com.nexuscommerce.user.address.exception.AddressNotFoundException;
import com.nexuscommerce.user.address.repository.UserAddressRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Objects;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class UserAddressService {

    private static final int MAX_ADDRESSES = 5;

    private final UserAddressRepository addressRepository;

    @Transactional
    public AddressResponse create(UUID userId, AddressRequest request) {
        long count = addressRepository.countByUserIdAndDeletedFalse(userId);
        if (count >= MAX_ADDRESSES) {
            throw new AddressLimitExceededException();
        }

        // First address is always default; explicit isDefault also triggers a swap
        boolean makeDefault = request.isDefault() || count == 0;
        if (makeDefault) {
            addressRepository.clearDefaultForUser(userId);
        }

        UserAddress address = UserAddress.builder()
                .userId(userId)
                .label(request.label())
                .recipientName(request.recipientName())
                .phone(request.phone())
                .addressLine1(request.addressLine1())
                .addressLine2(request.addressLine2())
                .city(request.city())
                .state(request.state())
                .postalCode(request.postalCode())
                .country(request.country())
                .isDefault(makeDefault)
                .build();

        return AddressResponse.from(Objects.requireNonNull(addressRepository.save(address)));
    }

    public List<AddressResponse> findAll(UUID userId) {
        return addressRepository.findByUserIdAndDeletedFalseOrderByCreatedAtDesc(userId)
                .stream()
                .map(AddressResponse::from)
                .toList();
    }

    public AddressResponse findById(UUID userId, UUID addressId) {
        return AddressResponse.from(resolveOwned(userId, addressId));
    }

    @Transactional
    public AddressResponse update(UUID userId, UUID addressId, AddressRequest request) {
        UserAddress address = resolveOwned(userId, addressId);

        if (request.isDefault() && !address.isDefault()) {
            addressRepository.clearDefaultForUser(userId);
            address.setDefault(true);
        }

        address.setLabel(request.label());
        address.setRecipientName(request.recipientName());
        address.setPhone(request.phone());
        address.setAddressLine1(request.addressLine1());
        address.setAddressLine2(request.addressLine2());
        address.setCity(request.city());
        address.setState(request.state());
        address.setPostalCode(request.postalCode());
        address.setCountry(request.country());

        return AddressResponse.from(Objects.requireNonNull(addressRepository.save(address)));
    }

    @Transactional
    public void delete(UUID userId, UUID addressId) {
        UserAddress address = resolveOwned(userId, addressId);
        boolean wasDefault = address.isDefault();

        address.setDeleted(true);
        addressRepository.saveAndFlush(address);

        // Promote the next most-recent address to default when the deleted one was default
        if (wasDefault) {
            addressRepository
                    .findTopByUserIdAndIdNotAndDeletedFalseOrderByCreatedAtDesc(userId, addressId)
                    .ifPresent(next -> {
                        next.setDefault(true);
                        addressRepository.save(next);
                    });
        }
    }

    @Transactional
    public AddressResponse setDefault(UUID userId, UUID addressId) {
        UserAddress address = resolveOwned(userId, addressId);
        addressRepository.clearDefaultForUser(userId);
        address.setDefault(true);
        return AddressResponse.from(Objects.requireNonNull(addressRepository.save(address)));
    }

    private UserAddress resolveOwned(UUID userId, UUID addressId) {
        return addressRepository.findByIdAndUserIdAndDeletedFalse(addressId, userId)
                .orElseThrow(() -> new AddressNotFoundException(addressId));
    }
}
