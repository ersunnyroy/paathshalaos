<?php

namespace App\Repositories\Eloquent;

use App\Helpers\CommonHelper;
use App\Models\User;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Database\Eloquent\Collection;

class UserRepository extends DbRepository implements UserRepositoryInterface
{
    public function __construct(User $model)
    {
        parent::__construct($model);
    }

    protected function defaultFindWith(): array
    {
        return ['tenant', 'branch', 'roles', 'roles.permissions'];
    }

    public function getAll(array $filters = [])
    {
        $query = $this->model->newQuery()->with(['roles', 'tenant']);

        if (isset($filters['tenant_id'])) {
            $query->whereIn('tenant_id', CommonHelper::primaryKeyCandidatesForLookup((int) $filters['tenant_id']));
        }

        if (isset($filters['branch_id'])) {
            $query->whereIn('branch_id', CommonHelper::primaryKeyCandidatesForLookup((int) $filters['branch_id']));
        }

        if (isset($filters['status'])) {
            $query->where('status', $filters['status']);
        }

        if (isset($filters['email'])) {
            $query->where('email', $filters['email']);
        }

        if (isset($filters['phone'])) {
            $query->where('phone', $filters['phone']);
        }

        if (isset($filters['search'])) {
            $query->where(function ($q) use ($filters) {
                $q->where('name', 'like', '%'.$filters['search'].'%')
                    ->orWhere('email', 'like', '%'.$filters['search'].'%')
                    ->orWhere('phone', 'like', '%'.$filters['search'].'%');
            });
        }

        return $query->orderBy('name')->get()->map(function ($user) {
            return [
                'id' => $user->getEncryptedId(),
                'name' => $user->name,
                'email' => $user->email,
                'phone' => $user->phone,
                'status' => $user->status,
                'tenant_id' => $user->tenant_id,
                'branch_id' => $user->branch_id,
                'avatar' => $user->avatar,
                'roles' => $user->roles->map(fn($role) => [
                    'id' => $role->getEncryptedId(),
                    'name' => $role->name,
                    'slug' => $role->slug,
                ])->toArray(),
                'created_at' => $user->created_at?->toIso8601String(),
            ];
        });
    }

    public function findById(int $id): ?User
    {
        /** @var ?User */
        return parent::findById($id);
    }

    public function findByEmail(string $email): ?User
    {
        return $this->model->where('email', $email)->first();
    }

    public function findByPhone(string $phone): ?User
    {
        return $this->model->where('phone', $phone)->first();
    }

    public function create(array $data): User
    {
        $model = parent::create($data);
        assert($model instanceof User);

        return $model;
    }

    public function update(int $id, array $data): User
    {
        $model = parent::update($id, $data);
        assert($model instanceof User);

        return $model;
    }

    public function getByTenantId(int $tenantId): Collection
    {
        return $this->model->where('tenant_id', $tenantId)
            ->orderBy('name')
            ->get();
    }
}
