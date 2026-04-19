<?php

namespace App\Repositories\Contracts;

interface ModuleRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Module;
    public function findBySlug(string $slug): ?\App\Models\Module;
    public function create(array $data): \App\Models\Module;
    public function update(int $id, array $data): \App\Models\Module;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
}