<?php

namespace App\Repositories\Eloquent;

use App\Models\EmailTemplate;
use Illuminate\Database\Eloquent\Collection;

class EmailTemplateRepository extends DbRepository implements \App\Repositories\Contracts\EmailTemplateRepositoryInterface
{
    protected function defaultFindWith(): array
    {
        return [];
    }

    public function getAll(array $filters = []): Collection
    {
        $query = $this->newQuery();

        if (isset($filters['is_active'])) {
            $query->where('is_active', $filters['is_active']);
        }

        if (isset($filters['is_default'])) {
            $query->where('is_default', $filters['is_default']);
        }

        return $query->orderBy('name', 'asc')->get();
    }

    public function findBySlug(string $slug): ?EmailTemplate
    {
        return $this->newQuery()->where('slug', $slug)->first();
    }

    public function findActiveBySlug(string $slug): ?EmailTemplate
    {
        return $this->newQuery()
            ->where('slug', $slug)
            ->where('is_active', 1)
            ->first();
    }

    public function activate(int $id): void
    {
        $template = $this->findById($id);
        if ($template) {
            $template->update(['is_active' => 1]);
        }
    }

    public function deactivate(int $id): void
    {
        $template = $this->findById($id);
        if ($template) {
            $template->update(['is_active' => 0]);
        }
    }
}