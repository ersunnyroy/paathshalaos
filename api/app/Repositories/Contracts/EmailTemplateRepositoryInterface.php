<?php

namespace App\Repositories\Contracts;

interface EmailTemplateRepositoryInterface
{
    public function getAll(array $filters = []);
    public function findById(int $id): ?\App\Models\EmailTemplate;
    public function findBySlug(string $slug): ?\App\Models\EmailTemplate;
    public function findActiveBySlug(string $slug): ?\App\Models\EmailTemplate;
    public function create(array $data): \App\Models\EmailTemplate;
    public function update(int $id, array $data): \App\Models\EmailTemplate;
    public function delete(int $id): bool;
    public function activate(int $id): void;
    public function deactivate(int $id): void;
}