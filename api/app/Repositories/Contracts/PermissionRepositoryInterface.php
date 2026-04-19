<?php

namespace App\Repositories\Contracts;

interface PermissionRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Permission;
    public function findBySlug(string $slug): ?\App\Models\Permission;
    public function create(array $data): \App\Models\Permission;
    public function update(int $id, array $data): \App\Models\Permission;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
    public function getGlobalPermissions();
}