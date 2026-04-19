<?php

namespace App\Repositories\Contracts;

interface UserRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\User;
    public function findByEmail(string $email): ?\App\Models\User;
    public function findByPhone(string $phone): ?\App\Models\User;
    public function create(array $data): \App\Models\User;
    public function update(int $id, array $data): \App\Models\User;
    public function delete(int $id): bool;
    public function paginate(int $perPage = 15);
    public function getByTenantId(int $tenantId);
}