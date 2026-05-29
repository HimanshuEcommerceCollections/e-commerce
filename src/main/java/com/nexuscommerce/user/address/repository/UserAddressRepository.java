package com.nexuscommerce.user.address.repository;

import com.nexuscommerce.user.address.entity.UserAddress;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface UserAddressRepository extends JpaRepository<UserAddress, UUID> {

    List<UserAddress> findByUserIdAndDeletedFalseOrderByCreatedAtDesc(UUID userId);

    Optional<UserAddress> findByIdAndUserIdAndDeletedFalse(UUID id, UUID userId);

    long countByUserIdAndDeletedFalse(UUID userId);

    Optional<UserAddress> findTopByUserIdAndIdNotAndDeletedFalseOrderByCreatedAtDesc(UUID userId, UUID excludeId);

    @Modifying(clearAutomatically = true)
    @Query("UPDATE UserAddress a SET a.isDefault = false WHERE a.userId = :userId AND a.deleted = false")
    void clearDefaultForUser(@Param("userId") UUID userId);
}
