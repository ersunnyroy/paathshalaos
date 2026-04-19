<?php

namespace App\Services;

use App\Models\Feature;
use App\Repositories\Contracts\FeatureRepositoryInterface;

class FeatureService
{
    public function __construct(
        private FeatureRepositoryInterface $featureRepository
    ) {}

    public function getAll(array $filters = [])
    {
        return $this->featureRepository->getAll($filters);
    }

    public function findById(int $id): ?Feature
    {
        return $this->featureRepository->findById($id);
    }

    public function findBySlug(string $slug): ?Feature
    {
        return $this->featureRepository->findBySlug($slug);
    }

    public function findByModuleId(int $moduleId)
    {
        return $this->featureRepository->findByModuleId($moduleId);
    }

    public function create(array $data): Feature
    {
        return $this->featureRepository->create($data);
    }

    public function update(int $id, array $data): Feature
    {
        return $this->featureRepository->update($id, $data);
    }

    public function delete(int $id): bool
    {
        return $this->featureRepository->delete($id);
    }

    public function paginate(int $perPage = 15)
    {
        return $this->featureRepository->paginate($perPage);
    }
}