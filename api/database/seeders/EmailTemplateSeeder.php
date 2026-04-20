<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use App\Models\EmailTemplate;

class EmailTemplateSeeder extends Seeder
{
    public function run(): void
    {
        $templates = [
            [
                'slug' => 'admin_credentials',
                'name' => 'Admin Credentials',
                'subject' => 'Your {{school_name}} Admin Account',
                'body' => <<<'HTML'
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #0f766e;">Welcome to PaathshalaOS</h2>
    <p>Hello {{admin_name}},</p>
    <p>Your admin account for <strong>{{school_name}}</strong> has been created.</p>
    <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0 0 10px;"><strong>Email:</strong> {{email}}</p>
        <p style="margin: 0;"><strong>Temporary Password:</strong> {{password}}</p>
    </div>
    <p>Please login and change your password immediately.</p>
    <p>Login URL: <a href="{{login_url}}" style="color: #0f766e;">Login</a></p>
    <p style="margin-top: 30px; color: #6b7280; font-size: 12px;">
        This is an automated message. Please do not reply.
    </p>
</div>
HTML,
                'variables' => 'admin_name,email,password,school_name,login_url',
                'is_default' => 1,
                'is_active' => 1,
            ],
            [
                'slug' => 'welcome_email',
                'name' => 'Welcome Email',
                'subject' => 'Welcome to {{school_name}}',
                'body' => <<<'HTML'
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #0f766e;">Welcome!</h2>
    <p>Hello {{user_name}},</p>
    <p>Welcome to <strong>{{school_name}}</strong>.</p>
    <p>Your account is ready to use. Get started by exploring the dashboard.</p>
    <p>Login URL: <a href="{{login_url}}" style="color: #0f766e;">Login</a></p>
</div>
HTML,
                'variables' => 'user_name,school_name,login_url',
                'is_default' => 0,
                'is_active' => 1,
            ],
            [
                'slug' => 'password_reset',
                'name' => 'Password Reset',
                'subject' => 'Reset your {{school_name}} password',
                'body' => <<<'HTML'
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #0f766e;">Password Reset</h2>
    <p>Hello {{user_name}},</p>
    <p>Click the button below to reset your password:</p>
    <p><a href="{{reset_url}}" style="background: #0f766e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Reset Password</a></p>
    <p style="color: #6b7280; font-size: 12px;">This link expires in 24 hours.</p>
</div>
HTML,
                'variables' => 'user_name,reset_url',
                'is_default' => 0,
                'is_active' => 1,
            ],
        ];

        foreach ($templates as $template) {
            EmailTemplate::updateOrInsert(
                ['slug' => $template['slug']],
                array_merge($template, [
                    'created_at' => now(),
                    'updated_at' => now(),
                ])
            );
        }

        $this->command->info('Email templates seeded successfully!');
    }
}