<?php

namespace App\Repositories\Contracts;

interface SmtpSettingsRepositoryInterface
{
    public function findByTenant(int $tenantId): ?\App\Models\SmtpSetting;
    public function findPlatform(): ?\App\Models\SmtpSetting;
    public function findActiveTemplate(string $slug): ?\App\Models\EmailTemplate;
}