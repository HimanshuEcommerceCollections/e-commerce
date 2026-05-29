package com.nexuscommerce.user.address.service;

import com.nexuscommerce.user.address.dto.AddressRequest;
import com.nexuscommerce.user.address.dto.AddressResponse;
import com.nexuscommerce.user.address.entity.UserAddress;
import com.nexuscommerce.user.address.exception.AddressLimitExceededException;
import com.nexuscommerce.user.address.exception.AddressNotFoundException;
import com.nexuscommerce.user.address.repository.UserAddressRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true)
public class UserAddressService {

    private final UserAddressRepository addressRepository;

    @Value("${app.user.address.max-per-user:5}")
    private int maxAddressesPerUser;

    @Transactional
    public AddressResponse create(UUID userId, AddressRequest request) {
        lockUser(userId);

        long count = addressRepository.countByUserIdAndDeletedFalse(userId);
        if (count >= maxAddressesPerUser) {
            throw new AddressLimitExceededException(maxAddressesPerUser);
        }

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

        return AddressResponse.from(addressRepository.save(address));
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
        lockUser(userId);

        UserAddress address = resolveOwned(userId, addressId);

        if (request.isDefault() && !address.isDefault()) {
            addressRepository.clearDefaultForUserExcept(userId, addressId);
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

        return AddressResponse.from(addressRepository.save(address));
    }

    @Transactional
    public void delete(UUID userId, UUID addressId) {
        lockUser(userId);

        UserAddress address = resolveOwned(userId, addressId);
        boolean wasDefault = address.isDefault();

        address.setDeleted(true);
        addressRepository.saveAndFlush(address);

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
        lockUser(userId);

        UserAddress address = resolveOwned(userId, addressId);
        if (address.isDefault()) {
            return AddressResponse.from(address);
        }

        addressRepository.clearDefaultForUserExcept(userId, addressId);
        address.setDefault(true);
        return AddressResponse.from(addressRepository.save(address));
    }

    private UserAddress resolveOwned(UUID userId, UUID addressId) {
        return addressRepository.findByIdAndUserIdAndDeletedFalse(addressId, userId)
                .orElseThrow(() -> new AddressNotFoundException(addressId));
    }

    private void lockUser(UUID userId) {
        addressRepository.acquireUserMutationLock("user_address:" + userId);
    }
}
