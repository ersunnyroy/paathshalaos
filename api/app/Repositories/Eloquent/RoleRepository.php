<?php

namespace App\Repositories\Eloquent;

use App\Models\Role;
use App\Repositories\Contracts\RoleRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class RoleRepository extends DbRepository implements RoleRepositoryInterface
{
    public function __construct(Role $model)
    {
        parent::__construct($model);
    }

    protected function defaultFindWith(): array
    {
        return ['permissions'];
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();
        
        \Log::info('RoleRepository getAll filters', $filters);

        if (isset($filters['tenant_id'])) {
            $query->where('tenant_id', (int) $filters['tenant_id']);
        }

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['is_default'])) {
            $query->where('is_default', $filters['is_default']);
        }

        return $query->orderBy('name')->get();
    }

    public function findById(int $id): ?Role
    {
        /** @var ?Role */
        return parent::findById($id);
    }

    public function findBySlug(string $slug): ?Role
    {
        return $this->model->where('slug', $slug)->first();
    }

    public function create(array $data): Role
    {
        $model = parent::create($data);
        assert($model instanceof Role);

        return $model;
    }

    public function update(int $id, array $data): Role
    {
        $model = parent::update($id, $data);
        assert($model instanceof Role);

        return $model;
    }

    public function getByTenantId(int $tenantId): Collection
    {
        return $this->model->where('tenant_id', $tenantId)
            ->orderBy('name')
            ->get();
    }

    public function getDefaultRole(int $tenantId): ?Role
    {
        return $this->model->where('tenant_id', $tenantId)
            ->where('is_default', 1)
            ->first();
    }
}
