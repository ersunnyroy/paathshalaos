<?php

namespace App\Models;

class EmailTemplate extends BaseModel
{
    protected $fillable = [
        'slug',
        'name',
        'subject',
        'body',
        'variables',
        'is_default',
        'is_active',
        'created_by',
        'updated_by',
    ];

    protected $casts = [
        'is_default' => 'boolean',
        'is_active' => 'boolean',
    ];

    public function isActive(): bool
    {
        return (bool) $this->is_active;
    }
}