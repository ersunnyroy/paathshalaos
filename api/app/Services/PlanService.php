<?php

namespace App\Services;

use App\Repositories\Contracts\PlanRepositoryInterface;
use App\Repositories\Contracts\TenantPlanRepositoryInterface;
use App\Repositories\Contracts\UserRepositoryInterface;
use App\Repositories\Contracts\BranchRepositoryInterface;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Log;

class PlanService
{
    public function __construct(
        private PlanRepositoryInterface $planRepository,
        private TenantPlanRepositoryInterface $tenantPlanRepository,
        private UserRepositoryInterface $userRepository,
        private BranchRepositoryInterface $branchRepository
    ) {}

    public function getTenantPlan(int $tenantId)
    {
        return $this->tenantPlanRepository->getTenantActivePlan($tenantId);
    }

    public function getPlanFeatures(int $tenantId): array
    {
        $cacheKey = "tenant:{$tenantId}:features";
        $cached = Redis::get($cacheKey);

        if ($cached) {
            return json_decode($cached, true);
        }

        $tenantPlan = $this->tenantPlanRepository->getTenantActivePlan($tenantId);

        if (!$tenantPlan) {
            return [];
        }

        $featureCollection = $this->planRepository->getPlanFeatures($tenantPlan->plan_id);
        $features = $featureCollection->pluck('slug')->toArray();

        $featuresArray = array_fill_keys($features, true);
        Redis::setex($cacheKey, 3600, json_encode($featuresArray));

        return $featuresArray;
    }

    public function isFeatureEnabled(int $tenantId, string $featureSlug): bool
    {
        $features = $this->getPlanFeatures($tenantId);
        return $features[$featureSlug] ?? false;
    }

    public function assignPlan(int $tenantId, int $planId, int $days = null)
    {
        $tenantPlan = $this->tenantPlanRepository->assignPlan($tenantId, $planId, $days);

        Redis::del("tenant:{$tenantId}:features");

        Log::info('Plan assigned to tenant', [
            'tenant_id' => $tenantId,
            'plan_id' => $planId,
        ]);

        return $tenantPlan;
    }

    public function checkLimits(int $tenantId, string $type): bool
    {
        $tenantPlan = $this->tenantPlanRepository->getTenantActivePlan($tenantId);

        if (!$tenantPlan) {
            return false;
        }

        $plan = $tenantPlan->plan;

        switch ($type) {
            case 'students':
                $current = $this->userRepository->getAll(['tenant_id' => $tenantId, 'status' => 1])->count();
                return $current < $plan->max_students;

            case 'teachers':
                $current = $this->userRepository->getAll(['tenant_id' => $tenantId, 'status' => 1])->count();
                return $current < $plan->max_teachers;

            case 'branches':
                $current = $this->branchRepository->getAll(['tenant_id' => $tenantId, 'status' => 1])->count();
                return $current < $plan->max_branches;

            default:
                return true;
        }
    }

    public function clearCache(int $tenantId): void
    {
        Redis::del("tenant:{$tenantId}:features");
    }
}