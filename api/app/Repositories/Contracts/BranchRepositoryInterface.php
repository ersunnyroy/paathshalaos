<?php

namespace App\Repositories\Contracts;

interface BranchRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\Branch;
    public function findBySubdomain(string $subdomain): ?\App\Models\Branch;
    public function create(array $data): \App\Models\Branch;
    public function update(int $id, array $data): \App\Models\Branch;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
    public function getByTenantId(int $tenantId);
}