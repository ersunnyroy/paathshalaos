<?php

namespace App\Services;

use App\Models\Module;
use App\Repositories\Contracts\ModuleRepositoryInterface;

class ModuleService
{
    public function __construct(
        private ModuleRepositoryInterface $moduleRepository
    ) {}

    public function getAll(array $filters = [])
    {
        return $this->moduleRepository->getAll($filters);
    }

    public function findById(int $id): ?Module
    {
        return $this->moduleRepository->findById($id);
    }

    public function findBySlug(string $slug): ?Module
    {
        return $this->moduleRepository->findBySlug($slug);
    }

    public function create(array $data): Module
    {
        return $this->moduleRepository->create($data);
    }

    public function update(int $id, array $data): Module
    {
        return $this->moduleRepository->update($id, $data);
    }

    public function delete(int $id): bool
    {
        return $this->moduleRepository->delete($id);
    }

    public function paginate(int $perPage = 15)
    {
        return $this->moduleRepository->paginate($perPage);
    }
}