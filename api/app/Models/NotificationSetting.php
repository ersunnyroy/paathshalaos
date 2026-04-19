<?php

namespace App\Models;

class NotificationSetting extends BaseModel
{
    protected $fillable = [
        'tenant_id',
        'email_enabled',
        'smtp_host',
        'smtp_port',
        'smtp_username',
        'smtp_password',
        'smtp_encryption',
        'smtp_from_email',
        'smtp_from_name',
        'sms_enabled',
        'sms_provider',
        'twilio_sid',
        'twilio_auth_token',
        'twilio_phone_number',
        'push_enabled',
        'fcm_server_key',
        'fcm_config',
    ];

    protected $casts = [
        'email_enabled' => 'boolean',
        'sms_enabled' => 'boolean',
        'push_enabled' => 'boolean',
        'fcm_config' => 'array',
    ];

    protected $hidden = [
        'smtp_password',
        'twilio_auth_token',
        'fcm_server_key',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }

    public function isEmailEnabled(): bool
    {
        return (bool) $this->email_enabled;
    }

    public function isSmsEnabled(): bool
    {
        return (bool) $this->sms_enabled;
    }

    public function isPushEnabled(): bool
    {
        return (bool) $this->push_enabled;
    }
}