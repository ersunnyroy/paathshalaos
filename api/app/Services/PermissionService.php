<?php

namespace App\Services;

use App\Models\Permission;
use App\Repositories\Contracts\PermissionRepositoryInterface;

class PermissionService
{
    public function __construct(
        private PermissionRepositoryInterface $permissionRepository
    ) {}

    public function getAll(array $filters = [])
    {
        return $this->permissionRepository->getAll($filters);
    }

    public function findById(int $id): ?Permission
    {
        return $this->permissionRepository->findById($id);
    }

    public function findBySlug(string $slug): ?Permission
    {
        return $this->permissionRepository->findBySlug($slug);
    }

    public function create(array $data): Permission
    {
        return $this->permissionRepository->create($data);
    }

    public function update(int $id, array $data): Permission
    {
        return $this->permissionRepository->update($id, $data);
    }

    public function delete(int $id): bool
    {
        return $this->permissionRepository->delete($id);
    }

    public function paginate(int $perPage = 15)
    {
        return $this->permissionRepository->paginate($perPage);
    }

    public function getGlobalPermissions()
    {
        return $this->permissionRepository->getGlobalPermissions();
    }
}