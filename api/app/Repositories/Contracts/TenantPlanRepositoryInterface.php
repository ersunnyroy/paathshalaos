<?php

namespace App\Repositories\Contracts;

interface TenantPlanRepositoryInterface
{
    public function getTenantActivePlan(int $tenantId): ?\App\Models\TenantPlan;
    public function getTenantPlanHistory(int $tenantId): \Illuminate\Database\Eloquent\Collection;
    public function assignPlan(int $tenantId, int $planId, ?int $days = null): \App\Models\TenantPlan;
    public function cancelPlan(int $tenantId): bool;
    public function isPlanActive(int $tenantId): bool;
    public function isPlanExpired(int $tenantId): bool;
}