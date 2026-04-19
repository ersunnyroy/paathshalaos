<?php

namespace App\Repositories\Eloquent;

use App\Helpers\CommonHelper;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/**
 * Base Eloquent repository: shared CRUD, obfuscated id lookup, and common select helpers.
 * Concrete repositories extend this class and override {@see defaultFindWith()} /
 * {@see paginationOrderBy()} when needed.
 */
abstract class DbRepository
{
    public function __construct(
        protected Model $model
    ) {}

    /**
     * Relation names to eager-load in {@see findById()}.
     *
     * @return list<string>
     */
    protected function defaultFindWith(): array
    {
        return [];
    }

    /**
     * Default ORDER BY clauses for {@see paginate()}.
     *
     * @return list<array{0: string, 1?: string}>
     */
    protected function paginationOrderBy(): array
    {
        return [['name', 'asc']];
    }

    public function findById(int $id): ?Model
    {
        $with = $this->defaultFindWith();

        foreach (CommonHelper::primaryKeyCandidatesForLookup($id) as $candidate) {
            $query = $this->model->newQuery();
            if ($with !== []) {
                $query->with($with);
            }
            $found = $query->find($candidate);
            if ($found !== null) {
                return $found;
            }
        }

        return null;
    }

    public function create(array $data): Model
    {
        return $this->model->create($data);
    }

    public function update(int $id, array $data): Model
    {
        $model = $this->findById($id);
        if ($model === null) {
            throw new ModelNotFoundException(class_basename($this->model).' not found for id: '.$id);
        }
        $model->update($data);

        return $model->fresh();
    }

    public function delete(int $id): bool
    {
        return (bool) $this->findById($id)?->delete();
    }

    public function paginate(int $perPage = 15): LengthAwarePaginator
    {
        $query = $this->model->newQuery();
        foreach ($this->paginationOrderBy() as $order) {
            $query->orderBy($order[0], $order[1] ?? 'asc');
        }

        return $query->paginate($perPage);
    }

    protected function newQuery(): Builder
    {
        return $this->model->newQuery();
    }

    /**
     * First row matching equality filters (column => value).
     *
     * @param  array<string, mixed>  $columnsEqual
     */
    public function findWhere(array $columnsEqual): ?Model
    {
        return $this->newQuery()->where($columnsEqual)->first();
    }

    /**
     * First row matching $scope with optional eager loads.
     *
     * @param  array<string, mixed>|callable(Builder): void  $scope
     * @param  list<string>  $with
     */
    public function findWhereWith(array|callable $scope, array $with = []): ?Model
    {
        $query = $this->newQuery()->with($with);
        $this->applyWhereScope($query, $scope);

        return $query->first();
    }

    /**
     * All rows matching $scope with optional eager loads and ordering.
     *
     * @param  array<string, mixed>|callable(Builder): void  $scope
     * @param  list<string>  $with
     * @param  list<array{0: string, 1?: string}>  $orderBy
     */
    public function findAllWhere(array|callable $scope, array $with = [], array $orderBy = []): Collection
    {
        $query = $this->newQuery()->with($with);
        $this->applyWhereScope($query, $scope);
        foreach ($orderBy as $pair) {
            if (is_array($pair) && isset($pair[0])) {
                $query->orderBy($pair[0], $pair[1] ?? 'asc');
            }
        }

        return $query->get();
    }

    /**
     * @param  array<string, mixed>|callable(Builder): void  $scope
     */
    public function findAllWhereSimple(array|callable $scope): Collection
    {
        return $this->findAllWhere($scope, [], []);
    }

    /**
     * @param  array<string, mixed>|callable(Builder): void  $scope
     */
    protected function applyWhereScope(Builder $query, array|callable $scope): void
    {
        if (is_array($scope)) {
            $query->where($scope);
        } else {
            $scope($query);
        }
    }
}
