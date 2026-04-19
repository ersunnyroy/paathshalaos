<?php

namespace App\Models;

use Illuminate\Database\Eloquent\SoftDeletes;

class Module extends BaseModel
{
    use SoftDeletes;

    protected $fillable = [
        'name',
        'slug',
        'description',
        'icon',
        'sort_order',
        'is_core',
        'status',
    ];

    protected $casts = [
        'is_core' => 'boolean',
        'status' => 'integer',
    ];

    public function features()
    {
        return $this->hasMany(Feature::class);
    }

    public function tenants()
    {
        return $this->belongsToMany(Tenant::class, 'tenant_modules')
            ->withPivot('is_enabled')
            ->withTimestamps();
    }

    public function isActive()
    {
        return (bool) $this->status;
    }

    public function isCore()
    {
        return (bool) $this->is_core;
    }
}