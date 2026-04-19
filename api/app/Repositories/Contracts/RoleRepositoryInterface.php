<?php

namespace App\Repositories\Contracts;

interface RoleRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Role;
    public function findBySlug(string $slug): ?\App\Models\Role;
    public function create(array $data): \App\Models\Role;
    public function update(int $id, array $data): \App\Models\Role;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
    public function getByTenantId(int $tenantId);
    public function getDefaultRole(int $tenantId): ?\App\Models\Role;
}