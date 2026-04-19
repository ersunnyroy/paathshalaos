<?php

namespace App\Repositories\Contracts;

interface TenantRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Tenant;
    public function findBySubdomain(string $subdomain): ?\App\Models\Tenant;
    public function findBySlug(string $slug): ?\App\Models\Tenant;
    public function create(array $data): \App\Models\Tenant;
    public function update(int $id, array $data): \App\Models\Tenant;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
}