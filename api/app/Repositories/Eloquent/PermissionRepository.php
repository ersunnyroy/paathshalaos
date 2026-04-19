<?php

namespace App\Repositories\Eloquent;

use App\Models\Permission;
use App\Repositories\Contracts\PermissionRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class PermissionRepository extends DbRepository implements PermissionRepositoryInterface
{
    public function __construct(Permission $model)
    {
        parent::__construct($model);
    }

    protected function paginationOrderBy(): array
    {
        return [
            ['module', 'asc'],
            ['name', 'asc'],
        ];
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
                $q->where('name', 'like', '%'.$filters['search'].'%')
                    ->orWhere('slug', 'like', '%'.$filters['search'].'%');
            });
        }

        return $query->orderBy('module')->orderBy('name')->get();
    }

    public function findById(int $id): ?Permission
    {
        /** @var ?Permission */
        return parent::findById($id);
    }

    public function findBySlug(string $slug): ?Permission
    {
        return $this->model->where('slug', $slug)->first();
    }

    public function create(array $data): Permission
    {
        $model = parent::create($data);
        assert($model instanceof Permission);

        return $model;
    }

    public function update(int $id, array $data): Permission
    {
        $model = parent::update($id, $data);
        assert($model instanceof Permission);

        return $model;
    }

    public function getGlobalPermissions(): Collection
    {
        return $this->model->where('is_global', 1)
            ->where('status', 1)
            ->orderBy('name')
            ->get();
    }
}
