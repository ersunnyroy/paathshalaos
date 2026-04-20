<?php

namespace App\Repositories\Eloquent;

use Illuminate\Database\Eloquent\Collection;

class TenantFeatureRepository implements \App\Repositories\Contracts\TenantFeatureRepositoryInterface
{
    public function getTenantFeatures(int $tenantId): Collection
    {
        return \DB::table('tenant_features')
            ->join('features', 'tenant_features.feature_id', '=', 'features.id')
            ->where('tenant_features.tenant_id', $tenantId)
            ->select('features.*', 'tenant_features.is_enabled')
            ->get();
    }

    public function getEnabledFeatures(int $tenantId): array
    {
        return \DB::table('tenant_features')
            ->join('features', 'tenant_features.feature_id', '=', 'features.id')
            ->where('tenant_features.tenant_id', $tenantId)
            ->where('tenant_features.is_enabled', 1)
            ->pluck('features.slug')
            ->toArray();
    }

    public function isFeatureEnabled(int $tenantId, string $featureSlug): bool
    {
        return \DB::table('tenant_features')
            ->join('features', 'tenant_features.feature_id', '=', 'features.id')
            ->where('tenant_features.tenant_id', $tenantId)
            ->where('features.slug', $featureSlug)
            ->where('tenant_features.is_enabled', 1)
            ->exists();
    }

    public function enableFeature(int $tenantId, int $featureId): void
    {
        $this->toggleFeature($tenantId, $featureId, true);
    }

    public function disableFeature(int $tenantId, int $featureId): void
    {
        $this->toggleFeature($tenantId, $featureId, false);
    }

    public function toggleFeature(int $tenantId, int $featureId, bool $isEnabled): void
    {
        \DB::table('tenant_features')
            ->where('tenant_id', $tenantId)
            ->where('feature_id', $featureId)
            ->update(['is_enabled' => $isEnabled ? 1 : 0]);
    }

    public function syncFeatures(int $tenantId, array $featureIds): void
    {
        foreach ($featureIds as $featureId) {
            \DB::table('tenant_features')->updateOrInsert(
                ['tenant_id' => $tenantId, 'feature_id' => $featureId],
                ['is_enabled' => 1, 'created_at' => now(), 'updated_at' => now()]
            );
        }
    }
}