<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use App\Models\SmtpSetting;

class SmtpSettingsSeeder extends Seeder
{
    public function run(): void
    {
        $paathshalaTenantId = \App\Models\Tenant::where('subdomain', 'paathshala')->value('id');

        SmtpSetting::updateOrInsert(
            ['is_platform' => 1],
            [
                'is_platform' => 1,
                'tenant_id' => $paathshalaTenantId,
                'host' => 'sandbox.smtp.mailtrap.io',
                'port' => '587',
                'username' => '20c5e7d0e3f183',
                'password' => 'b71dc0a55f962c',
                'encryption' => 'tls',
                'from_email' => 'noreply@paathshala.com',
                'from_name' => 'PaathshalaOS',
                'created_at' => now(),
                'updated_at' => now(),
            ]
        );

        $this->command->info('Platform SMTP settings seeded successfully!');
    }
}