<?php

namespace App\Repositories\Eloquent;

use App\Models\Branch;
use App\Repositories\Contracts\BranchRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class BranchRepository implements BranchRepositoryInterface
{
    protected Branch $model;

    public function __construct(Branch $model)
    {
        $this->model = $model;
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();

        if (isset($filters['tenant_id'])) {
            $query->where('tenant_id', $filters['tenant_id']);
        }

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['search'])) {
            $query->where(function ($q) use ($filters) {
                $q->where('name', 'like', '%' . $filters['search'] . '%')
                    ->orWhere('email', 'like', '%' . $filters['search'] . '%');
            });
        }

        return $query->orderBy('name')->get();
    }

    public function findById(int $id): ?Branch
    {
        return $this->model->with('tenant')->find($id);
    }

    public function findBySubdomain(string $subdomain): ?Branch
    {
        return $this->model->where('subdomain', $subdomain)->first();
    }

    public function create(array $data): Branch
    {
        return $this->model->create($data);
    }

    public function update(int $id, array $data): Branch
    {
        $model = $this->findById($id);
        $model->update($data);
        return $model->fresh();
    }

    public function delete(int $id): bool
    {
        return (bool) $this->findById($id)?->delete();
    }

    public function paginate(int $perPage = 15)
    {
        return $this->model->orderBy('name')->paginate($perPage);
    }

    public function getByTenantId(int $tenantId): Collection
    {
        return $this->model->where('tenant_id', $tenantId)
            ->orderBy('name')
            ->get();
    }
}