<?php

namespace App\Models;

class SmtpSetting extends BaseModel
{
    protected $fillable = [
        'tenant_id',
        'is_platform',
        'host',
        'port',
        'username',
        'password',
        'encryption',
        'from_email',
        'from_name',
    ];

    protected $hidden = [
        'password',
    ];

    protected $casts = [
        'is_platform' => 'boolean',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }
}