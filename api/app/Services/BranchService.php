<?php

namespace App\Services;

use App\Models\Branch;
use App\Repositories\Contracts\BranchRepositoryInterface;
use Illuminate\Support\Facades\Log;

class BranchService
{
    public function __construct(
        private BranchRepositoryInterface $branchRepository
    ) {}

    public function getAll(array $filters = [])
    {
        return $this->branchRepository->getAll($filters);
    }

    public function findById(int $id): ?Branch
    {
        return $this->branchRepository->findById($id);
    }

    public function findBySubdomain(string $subdomain): ?Branch
    {
        return $this->branchRepository->findBySubdomain($subdomain);
    }

    public function create(array $data): Branch
    {
        $data['slug'] = str()->slug($data['name']);
        return $this->branchRepository->create($data);
    }

    public function update(int $id, array $data): Branch
    {
        if (isset($data['name'])) {
            $data['slug'] = str()->slug($data['name']);
        }
        return $this->branchRepository->update($id, $data);
    }

    public function delete(int $id): bool
    {
        return $this->branchRepository->delete($id);
    }

    public function paginate(int $perPage = 15)
    {
        return $this->branchRepository->paginate($perPage);
    }

    public function getByTenantId(int $tenantId)
    {
        return $this->branchRepository->getByTenantId($tenantId);
    }
}