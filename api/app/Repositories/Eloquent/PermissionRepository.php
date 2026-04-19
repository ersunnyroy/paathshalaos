<?php

namespace App\Repositories\Eloquent;

use App\Models\Permission;
use App\Repositories\Contracts\PermissionRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class PermissionRepository implements PermissionRepositoryInterface
{
    protected Permission $model;

    public function __construct(Permission $model)
    {
        $this->model = $model;
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['module'])) {
            $query->where('module', $filters['module']);
        }

        if (isset($filters['is_global'])) {
            $query->where('is_global', $filters['is_global']);
        }

        if (isset($filters['search'])) {
            $query->where(function ($q) use ($filters) {
                $q->where('name', 'like', '%' . $filters['search'] . '%')
                    ->orWhere('slug', 'like', '%' . $filters['search'] . '%');
            });
        }

        return $query->orderBy('module')->orderBy('name')->get();
    }

    public function findById(int $id): ?Permission
    {
        return $this->model->find($id);
    }

    public function findBySlug(string $slug): ?Permission
    {
        return $this->model->where('slug', $slug)->first();
    }

    public function create(array $data): Permission
    {
        return $this->model->create($data);
    }

    public function update(int $id, array $data): Permission
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
        return $this->model->orderBy('module')->orderBy('name')->paginate($perPage);
    }

    public function getGlobalPermissions(): Collection
    {
        return $this->model->where('is_global', 1)
            ->where('status', 1)
            ->orderBy('name')
            ->get();
    }
}