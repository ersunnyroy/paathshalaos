<?php

namespace App\Repositories\Eloquent;

use App\Models\Plan;
use App\Repositories\Contracts\PlanRepositoryInterface;

class PlanRepository extends DbRepository implements PlanRepositoryInterface
{
    protected function defaultFindWith(): array
    {
        return ['features'];
    }

    public function getAll(array $filters = []): \Illuminate\Database\Eloquent\Collection
    {
        $query = $this->newQuery();

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['is_default'])) {
            $query->where('is_default', $filters['is_default']);
        }

        return $query->orderBy('price', 'asc')->get();
    }

    public function findBySlug(string $slug): ?Plan
    {
        return $this->newQuery()->where('slug', $slug)->first();
    }

    public function getDefaultPlan(): ?Plan
    {
        return $this->newQuery()->where('is_default', 1)->first();
    }

    public function getActivePlans(): \Illuminate\Database\Eloquent\Collection
    {
        return $this->newQuery()->where('status', 1)->orderBy('price', 'asc')->get();
    }

    public function getPlanFeatures(int $planId): \Illuminate\Database\Eloquent\Collection
    {
        $plan = $this->findById($planId);
        return $plan ? $plan->features : new \Illuminate\Database\Eloquent\Collection();
    }

    public function assignFeature(int $planId, int $featureId, bool $enabled = true, bool $allowOverride = false): void
    {
        $plan = $this->findById($planId);
        if ($plan) {
            $plan->features()->syncWithoutDetaching([
                $featureId => ['is_enabled' => $enabled, 'allow_override' => $allowOverride]
            ]);
        }
    }
}