<?php

namespace App\Repositories\Contracts;

interface PlanRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Plan;
    public function findBySlug(string $slug): ?\App\Models\Plan;
    public function create(array $data): \App\Models\Plan;
    public function update(int $id, array $data): \App\Models\Plan;
    public function delete(int $id): bool;
    public function getDefaultPlan(): ?\App\Models\Plan;
    public function getActivePlans(): \Illuminate\Database\Eloquent\Collection;
    public function getPlanFeatures(int $planId): \Illuminate\Database\Eloquent\Collection;
    public function assignFeature(int $planId, int $featureId, bool $enabled = true, bool $allowOverride = false): void;
}