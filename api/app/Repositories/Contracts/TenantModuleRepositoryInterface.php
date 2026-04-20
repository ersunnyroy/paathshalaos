<?php

namespace App\Repositories\Contracts;

interface TenantModuleRepositoryInterface
{
    public function getTenantModules(int $tenantId): \Illuminate\Database\Eloquent\Collection;
    public function getEnabledModules(int $tenantId): array;
    public function isModuleEnabled(int $tenantId, string $moduleSlug): bool;
    public function enableModule(int $tenantId, int $moduleId): void;
    public function disableModule(int $tenantId, int $moduleId): void;
    public function toggleModule(int $tenantId, int $moduleId, bool $isEnabled): void;
    public function syncModules(int $tenantId, array $moduleIds): void;
}