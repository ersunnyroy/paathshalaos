<?php

namespace App\Repositories\Contracts;

interface TenantFeatureRepositoryInterface
{
    public function getTenantFeatures(int $tenantId): \Illuminate\Database\Eloquent\Collection;
    public function getEnabledFeatures(int $tenantId): array;
    public function isFeatureEnabled(int $tenantId, string $featureSlug): bool;
    public function enableFeature(int $tenantId, int $featureId): void;
    public function disableFeature(int $tenantId, int $featureId): void;
    public function toggleFeature(int $tenantId, int $featureId, bool $isEnabled): void;
    public function syncFeatures(int $tenantId, array $featureIds): void;
}