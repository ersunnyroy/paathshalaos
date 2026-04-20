<?php

namespace App\Repositories\Eloquent;

use App\Models\SmtpSetting;
use App\Models\EmailTemplate;

class SmtpSettingsRepository implements \App\Repositories\Contracts\SmtpSettingsRepositoryInterface
{
    public function findByTenant(int $tenantId): ?SmtpSetting
    {
        return SmtpSetting::where('tenant_id', $tenantId)
            ->where('is_platform', 0)
            ->first();
    }

    public function findPlatform(): ?SmtpSetting
    {
        return SmtpSetting::where('is_platform', 1)->first();
    }

    public function findActiveTemplate(string $slug): ?EmailTemplate
    {
        return EmailTemplate::where('slug', $slug)
            ->where('is_active', 1)
            ->first();
    }
}