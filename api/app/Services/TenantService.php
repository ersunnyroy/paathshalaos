<?php

namespace App\Services;

use App\Models\Tenant;
use App\Models\Module;
use App\Models\Feature;
use App\Repositories\Contracts\TenantRepositoryInterface;
use App\Repositories\Contracts\ModuleRepositoryInterface;
use App\Repositories\Contracts\FeatureRepositoryInterface;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Log;

class TenantService
{
    public function __construct(
        private TenantRepositoryInterface $tenantRepository,
        private ModuleRepositoryInterface $moduleRepository,
        private FeatureRepositoryInterface $featureRepository,
    ) {}

    public function getAll(array $filters = []): \Illuminate\Database\Eloquent\Collection
    {
        return $this->tenantRepository->getAll($filters);
    }

    public function findById(int $id): ?Tenant
    {
        return $this->tenantRepository->findById($id);
    }

    public function findBySubdomain(string $subdomain): ?Tenant
    {
        return $this->tenantRepository->findBySubdomain($subdomain);
    }

    public function create(array $data): Tenant
    {
        return $this->tenantRepository->create($data);
    }

    public function update(int $id, array $data): Tenant
    {
        return $this->tenantRepository->update($id, $data);
    }

    public function delete(int $id): bool
    {
        return $this->tenantRepository->delete($id);
    }

    public function paginate(int $perPage = 15)
    {
        return $this->tenantRepository->paginate($perPage);
    }

    public function enableDefaultModules(int $tenantId): void
    {
        $modules = $this->moduleRepository->getAll(['status' => 1]);

        foreach ($modules as $module) {
            \DB::table('tenant_modules')->insert([
                'tenant_id' => $tenantId,
                'module_id' => $module->id,
                'is_enabled' => $module->is_core ? 1 : 0,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        Redis::del("tenant:{$tenantId}:modules");
    }

    public function enableDefaultFeatures(int $tenantId): void
    {
        $features = $this->featureRepository->getAll(['status' => 1]);

        foreach ($features as $feature) {
            \DB::table('tenant_features')->insert([
                'tenant_id' => $tenantId,
                'feature_id' => $feature->id,
                'is_enabled' => $feature->is_default_enabled,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        Redis::del("tenant:{$tenantId}:features");
    }

    public function toggleModule(int $tenantId, int $moduleId, bool $isEnabled): void
    {
        \DB::table('tenant_modules')
            ->where('tenant_id', $tenantId)
            ->where('module_id', $moduleId)
            ->update(['is_enabled' => $isEnabled ? 1 : 0]);

        Redis::del("tenant:{$tenantId}:modules");
        Redis::del("tenant:{$tenantId}:features");

        Log::info('Module toggled', [
            'tenant_id' => $tenantId,
            'module_id' => $moduleId,
            'is_enabled' => $isEnabled,
        ]);
    }

    public function toggleFeature(int $tenantId, int $featureId, bool $isEnabled): void
    {
        \DB::table('tenant_features')
            ->where('tenant_id', $tenantId)
            ->where('feature_id', $featureId)
            ->update(['is_enabled' => $isEnabled ? 1 : 0]);

        Redis::del("tenant:{$tenantId}:features");

        Log::info('Feature toggled', [
            'tenant_id' => $tenantId,
            'feature_id' => $featureId,
            'is_enabled' => $isEnabled,
        ]);
    }

    public function isModuleEnabled(int $tenantId, string $moduleSlug): bool
    {
        $modules = $this->getEnabledModules($tenantId);

        return in_array($moduleSlug, $modules);
    }

    public function isFeatureEnabled(int $tenantId, string $featureSlug): bool
    {
        $redisKey = "tenant:{$tenantId}:features";
        $cached = Redis::get($redisKey);

        if ($cached) {
            $features = json_decode($cached, true);
            return $features[$featureSlug] ?? $this->getDefaultFeatureStatus($featureSlug);
        }

        $isEnabled = \DB::table('tenant_features')
            ->join('features', 'tenant_features.feature_id', '=', 'features.id')
            ->where('tenant_features.tenant_id', $tenantId)
            ->where('features.slug', $featureSlug)
            ->value('tenant_features.is_enabled');

        $defaultStatus = $this->getDefaultFeatureStatus($featureSlug);

        return $isEnabled !== null ? (bool) $isEnabled : $defaultStatus;
    }

    public function getEnabledModules(int $tenantId): array
    {
        $redisKey = "tenant:{$tenantId}:modules";
        $cached = Redis::get($redisKey);

        if ($cached) {
            return json_decode($cached, true);
        }

        $modules = \DB::table('tenant_modules')
            ->join('modules', 'tenant_modules.module_id', '=', 'modules.id')
            ->where('tenant_modules.tenant_id', $tenantId)
            ->where('tenant_modules.is_enabled', 1)
            ->pluck('modules.slug')
            ->toArray();

        Redis::setex($redisKey, 3600, json_encode($modules));

        return $modules;
    }

    public function getEnabledFeatures(int $tenantId): array
    {
        $redisKey = "tenant:{$tenantId}:features";
        $cached = Redis::get($redisKey);

        if ($cached) {
            return json_decode($cached, true);
        }

        $features = \DB::table('tenant_features')
            ->join('features', 'tenant_features.feature_id', '=', 'features.id')
            ->where('tenant_features.tenant_id', $tenantId)
            ->where('tenant_features.is_enabled', 1)
            ->pluck('features.slug')
            ->toArray();

        $featuresArray = array_combine($features, array_fill(0, count($features), true));
        $featuresArray = array_fill_keys($features, true);

        Redis::setex($redisKey, 3600, json_encode($featuresArray));

        return $featuresArray;
    }

    private function getDefaultFeatureStatus(string $featureSlug): bool
    {
        $feature = $this->featureRepository->findBySlug($featureSlug);
        return $feature ? $feature->isDefaultEnabled() : false;
    }
}