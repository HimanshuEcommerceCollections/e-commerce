package com.nexuscommerce.user.address.controller;

import com.nexuscommerce.user.address.dto.AddressRequest;
import com.nexuscommerce.user.address.dto.AddressResponse;
import com.nexuscommerce.user.address.service.UserAddressService;
import com.nexuscommerce.auth.security.CustomerUserDetails;
import com.nexuscommerce.common.dto.ApiResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/users/me/addresses")
@RequiredArgsConstructor
public class UserAddressController {

    private final UserAddressService addressService;

    @PostMapping
    public ResponseEntity<ApiResponse<AddressResponse>> create(
            @AuthenticationPrincipal CustomerUserDetails userDetails,
            @Valid @RequestBody AddressRequest request) {
        AddressResponse response = addressService.create(userDetails.getUser().getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.created("Address added successfully", response));
    }

    @GetMapping
    public ResponseEntity<ApiResponse<List<AddressResponse>>> findAll(
            @AuthenticationPrincipal CustomerUserDetails userDetails) {
        List<AddressResponse> addresses = addressService.findAll(userDetails.getUser().getId());
        return ResponseEntity.ok(ApiResponse.ok("Addresses retrieved", addresses));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ApiResponse<AddressResponse>> findById(
            @AuthenticationPrincipal CustomerUserDetails userDetails,
            @PathVariable UUID id) {
        AddressResponse response = addressService.findById(userDetails.getUser().getId(), id);
        return ResponseEntity.ok(ApiResponse.ok(response));
    }

    @PutMapping("/{id}")
    public ResponseEntity<ApiResponse<AddressResponse>> update(
            @AuthenticationPrincipal CustomerUserDetails userDetails,
            @PathVariable UUID id,
            @Valid @RequestBody AddressRequest request) {
        AddressResponse response = addressService.update(userDetails.getUser().getId(), id, request);
        return ResponseEntity.ok(ApiResponse.ok("Address updated successfully", response));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<ApiResponse<Void>> delete(
            @AuthenticationPrincipal CustomerUserDetails userDetails,
            @PathVariable UUID id) {
        addressService.delete(userDetails.getUser().getId(), id);
        return ResponseEntity.ok(ApiResponse.noContent("Address removed successfully"));
    }

    @PatchMapping("/{id}/default")
    public ResponseEntity<ApiResponse<AddressResponse>> setDefault(
            @AuthenticationPrincipal CustomerUserDetails userDetails,
            @PathVariable UUID id) {
        AddressResponse response = addressService.setDefault(userDetails.getUser().getId(), id);
        return ResponseEntity.ok(ApiResponse.ok("Default address updated", response));
    }
}
