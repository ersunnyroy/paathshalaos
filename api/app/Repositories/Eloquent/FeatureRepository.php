<?php

namespace App\Repositories\Eloquent;

use App\Models\Feature;
use App\Repositories\Contracts\FeatureRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class FeatureRepository implements FeatureRepositoryInterface
{
    protected Feature $model;

    public function __construct(Feature $model)
    {
        $this->model = $model;
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();

        if (isset($filters['module_id'])) {
            $query->where('module_id', $filters['module_id']);
        }

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['is_default_enabled'])) {
            $query->where('is_default_enabled', $filters['is_default_enabled']);
        }

        if (isset($filters['search'])) {
            $query->where(function ($q) use ($filters) {
                $q->where('name', 'like', '%' . $filters['search'] . '%')
                    ->orWhere('slug', 'like', '%' . $filters['search'] . '%');
            });
        }

        return $query->orderBy('sort_order')->get();
    }

    public function findById(int $id): ?Feature
    {
        return $this->model->with('module')->find($id);
    }

    public function findBySlug(string $slug): ?Feature
    {
        return $this->model->with('module')->where('slug', $slug)->first();
    }

    public function findByModuleId(int $moduleId): Collection
    {
        return $this->model->where('module_id', $moduleId)
            ->orderBy('sort_order')
            ->get();
    }

    public function create(array $data): Feature
    {
        return $this->model->create($data);
    }

    public function update(int $id, array $data): Feature
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