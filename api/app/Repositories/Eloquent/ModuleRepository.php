<?php

namespace App\Repositories\Eloquent;

use App\Models\Module;
use App\Repositories\Contracts\ModuleRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class ModuleRepository implements ModuleRepositoryInterface
{
    protected Module $model;

    public function __construct(Module $model)
    {
        $this->model = $model;
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['is_core'])) {
            $query->where('is_core', $filters['is_core']);
        }

        if (isset($filters['search'])) {
            $query->where(function ($q) use ($filters) {
                $q->where('name', 'like', '%' . $filters['search'] . '%')
                    ->orWhere('slug', 'like', '%' . $filters['search'] . '%');
            });
        }

        return $query->orderBy('sort_order')->get();
    }

    public function findById(int $id): ?Module
    {
        return $this->model->with('features')->find($id);
    }

    public function findBySlug(string $slug): ?Module
    {
        return $this->model->with('features')->where('slug', $slug)->first();
    }

    public function create(array $data): Module
    {
        return $this->model->create($data);
    }

    public function update(int $id, array $data): Module
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
        return $this->model->orderBy('sort_order')->paginate($perPage);
    }
}