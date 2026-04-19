<?php

namespace App\Repositories\Contracts;

interface FeatureRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Feature;
    public function findBySlug(string $slug): ?\App\Models\Feature;
    public function findByModuleId(int $moduleId);
    public function create(array $data): \App\Models\Feature;
    public function update(int $id, array $data): \App\Models\Feature;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
}