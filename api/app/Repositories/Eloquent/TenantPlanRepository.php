<?php

namespace App\Repositories\Eloquent;

use App\Models\TenantPlan;
use App\Models\Plan;
use App\Repositories\Contracts\TenantPlanRepositoryInterface;

class TenantPlanRepository extends DbRepository implements TenantPlanRepositoryInterface
{
    protected function defaultFindWith(): array
    {
        return ['plan', 'tenant'];
    }

    public function getTenantActivePlan(int $tenantId): ?TenantPlan
    {
        return $this->newQuery()
            ->where('tenant_id', $tenantId)
            ->where('status', 1)
            ->where(function ($query) {
                $query->whereNull('end_date')
                    ->orWhere('end_date', '>=', now()->toDateString());
            })
            ->first();
    }

    public function getTenantPlanHistory(int $tenantId): \Illuminate\Database\Eloquent\Collection
    {
        return $this->newQuery()
            ->where('tenant_id', $tenantId)
            ->with(['plan'])
            ->orderBy('created_at', 'desc')
            ->get();
    }

    public function assignPlan(int $tenantId, int $planId, ?int $days = null): TenantPlan
    {
        $this->newQuery()
            ->where('tenant_id', $tenantId)
            ->update(['status' => 0]);

        $plan = Plan::findOrFail($planId);

        return $this->create([
            'tenant_id' => $tenantId,
            'plan_id' => $planId,
            'start_date' => now()->toDateString(),
            'end_date' => $days ? now()->addDays($days)->toDateString() : null,
            'billing_cycle' => $plan->billing_cycle,
            'amount_paid' => $plan->price,
            'status' => 1,
        ]);
    }

    public function cancelPlan(int $tenantId): bool
    {
        return (bool) $this->newQuery()
            ->where('tenant_id', $tenantId)
            ->where('status', 1)
            ->update(['status' => 0]);
    }

    public function isPlanActive(int $tenantId): bool
    {
        return $this->getTenantActivePlan($tenantId) !== null;
    }

    public function isPlanExpired(int $tenantId): bool
    {
        $plan = $this->getTenantActivePlan($tenantId);
        return $plan && $plan->end_date && $plan->end_date->isPast();
    }
}