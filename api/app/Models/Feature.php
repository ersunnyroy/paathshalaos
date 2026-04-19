<?php

namespace App\Models;

use Illuminate\Database\Eloquent\SoftDeletes;

class Feature extends BaseModel
{
    use SoftDeletes;

    protected $fillable = [
        'module_id',
        'name',
        'slug',
        'description',
        'sort_order',
        'is_default_enabled',
        'status',
    ];

    protected $casts = [
        'is_default_enabled' => 'boolean',
        'status' => 'integer',
    ];

    public function module()
    {
        return $this->belongsTo(Module::class);
    }

    public function tenants()
    {
        return $this->belongsToMany(Tenant::class, 'tenant_features')
            ->withPivot('is_enabled')
            ->withTimestamps();
    }

    public function isActive()
    {
        return (bool) $this->status;
    }

    public function isDefaultEnabled()
    {
        return (bool) $this->is_default_enabled;
    }
}