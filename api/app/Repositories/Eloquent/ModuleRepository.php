<?php

namespace App\Repositories\Eloquent;

use App\Models\Module;
use App\Repositories\Contracts\ModuleRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class ModuleRepository extends DbRepository implements ModuleRepositoryInterface
{
    public function __construct(Module $model)
    {
        parent::__construct($model);
    }

    protected function defaultFindWith(): array
    {
        return ['features'];
    }

    protected function paginationOrderBy(): array
    {
        return [['sort_order', 'asc']];
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
                $q->where('name', 'like', '%'.$filters['search'].'%')
                    ->orWhere('slug', 'like', '%'.$filters['search'].'%');
            });
        }

        return $query->orderBy('sort_order')->get();
    }

    public function findById(int $id): ?Module
    {
        /** @var ?Module */
        return parent::findById($id);
    }

    public function findBySlug(string $slug): ?Module
    {
        return $this->model->with('features')->where('slug', $slug)->first();
    }

    public function create(array $data): Module
    {
        $model = parent::create($data);
        assert($model instanceof Module);

        return $model;
    }

    public function update(int $id, array $data): Module
    {
        $model = parent::update($id, $data);
        assert($model instanceof Module);

        return $model;
    }
}
