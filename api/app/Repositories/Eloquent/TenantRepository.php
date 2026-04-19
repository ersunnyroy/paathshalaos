<?php

namespace App\Repositories\Eloquent;

use App\Models\Tenant;
use App\Repositories\Contracts\TenantRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class TenantRepository extends DbRepository implements TenantRepositoryInterface
{
    public function __construct(Tenant $model)
    {
        parent::__construct($model);
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['search'])) {
            $query->where(function ($q) use ($filters) {
                $q->where('name', 'like', '%'.$filters['search'].'%')
                    ->orWhere('email', 'like', '%'.$filters['search'].'%');
            });
        }

        return $query->orderBy('name')->get();
    }

    public function findById(int $id): ?Tenant
    {
        /** @var ?Tenant */
        return parent::findById($id);
    }

    public function findBySubdomain(string $subdomain): ?Tenant
    {
        return $this->model->where('subdomain', $subdomain)->first();
    }

    public function findBySlug(string $slug): ?Tenant
    {
        return $this->model->where('slug', $slug)->first();
    }

    public function create(array $data): Tenant
    {
        $model = parent::create($data);
        assert($model instanceof Tenant);

        return $model;
    }

    public function update(int $id, array $data): Tenant
    {
        $model = parent::update($id, $data);
        assert($model instanceof Tenant);

        return $model;
    }
}
