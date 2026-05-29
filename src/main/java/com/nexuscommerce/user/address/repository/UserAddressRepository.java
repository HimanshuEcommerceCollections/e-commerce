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

    @Modifying
    @Query("UPDATE UserAddress a SET a.isDefault = false WHERE a.userId = :userId AND a.deleted = false")
    void clearDefaultForUser(@Param("userId") UUID userId);

    @Modifying
    @Query("UPDATE UserAddress a SET a.isDefault = false WHERE a.userId = :userId AND a.id <> :excludeId AND a.deleted = false")
    void clearDefaultForUserExcept(@Param("userId") UUID userId, @Param("excludeId") UUID excludeId);

    // Postgres advisory lock scoped to the current transaction. Serializes concurrent
    // address mutations for the same user so the per-user invariants (max-per-user count,
    // single default) hold without relying on application-level race windows.
    @Query(value = "SELECT pg_advisory_xact_lock(hashtext(:key))", nativeQuery = true)
    void acquireUserMutationLock(@Param("key") String key);
}
