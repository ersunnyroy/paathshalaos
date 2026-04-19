<?php

namespace App\Repositories\Eloquent;

use App\Helpers\CommonHelper;
use App\Models\Branch;
use App\Repositories\Contracts\BranchRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class BranchRepository extends DbRepository implements BranchRepositoryInterface
{
    public function __construct(Branch $model)
    {
        parent::__construct($model);
    }

    protected function defaultFindWith(): array
    {
        return ['tenant'];
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->model->newQuery();

        if (isset($filters['tenant_id'])) {
            $query->whereIn('tenant_id', CommonHelper::primaryKeyCandidatesForLookup((int) $filters['tenant_id']));
        }

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

    public function findById(int $id): ?Branch
    {
        /** @var ?Branch */
        return parent::findById($id);
    }

    public function findBySubdomain(string $subdomain): ?Branch
    {
        return $this->model->where('subdomain', $subdomain)->first();
    }

    public function create(array $data): Branch
    {
        $model = parent::create($data);
        assert($model instanceof Branch);

        return $model;
    }

    public function update(int $id, array $data): Branch
    {
        $model = parent::update($id, $data);
        assert($model instanceof Branch);

        return $model;
    }

    public function getByTenantId(int $tenantId): Collection
    {
        return $this->model->where('tenant_id', $tenantId)
            ->orderBy('name')
            ->get();
    }
}
