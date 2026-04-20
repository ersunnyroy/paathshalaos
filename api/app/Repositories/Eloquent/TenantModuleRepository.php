<?php

namespace App\Repositories\Eloquent;

use App\Models\Module;
use Illuminate\Database\Eloquent\Collection;

class TenantModuleRepository implements \App\Repositories\Contracts\TenantModuleRepositoryInterface
{
    public function getTenantModules(int $tenantId): Collection
    {
        return \DB::table('tenant_modules')
            ->join('modules', 'tenant_modules.module_id', '=', 'modules.id')
            ->where('tenant_modules.tenant_id', $tenantId)
            ->select('modules.*', 'tenant_modules.is_enabled')
            ->get();
    }

    public function getEnabledModules(int $tenantId): array
    {
        return \DB::table('tenant_modules')
            ->join('modules', 'tenant_modules.module_id', '=', 'modules.id')
            ->where('tenant_modules.tenant_id', $tenantId)
            ->where('tenant_modules.is_enabled', 1)
            ->pluck('modules.slug')
            ->toArray();
    }

    public function isModuleEnabled(int $tenantId, string $moduleSlug): bool
    {
        return \DB::table('tenant_modules')
            ->join('modules', 'tenant_modules.module_id', '=', 'modules.id')
            ->where('tenant_modules.tenant_id', $tenantId)
            ->where('modules.slug', $moduleSlug)
            ->where('tenant_modules.is_enabled', 1)
            ->exists();
    }

    public function enableModule(int $tenantId, int $moduleId): void
    {
        $this->toggleModule($tenantId, $moduleId, true);
    }

    public function disableModule(int $tenantId, int $moduleId): void
    {
        $this->toggleModule($tenantId, $moduleId, false);
    }

    public function toggleModule(int $tenantId, int $moduleId, bool $isEnabled): void
    {
        \DB::table('tenant_modules')
            ->where('tenant_id', $tenantId)
            ->where('module_id', $moduleId)
            ->update(['is_enabled' => $isEnabled ? 1 : 0]);
    }

    public function syncModules(int $tenantId, array $moduleIds): void
    {
        foreach ($moduleIds as $moduleId) {
            \DB::table('tenant_modules')->updateOrInsert(
                ['tenant_id' => $tenantId, 'module_id' => $moduleId],
                ['is_enabled' => 1, 'created_at' => now(), 'updated_at' => now()]
            );
        }
    }
}