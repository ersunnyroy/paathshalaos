<?php

namespace App\Models;

class Plan extends BaseModel
{
    protected $fillable = [
        'name',
        'slug',
        'description',
        'price',
        'max_students',
        'max_teachers',
        'max_branches',
        'max_storage_mb',
        'is_default',
        'is_trial',
        'trial_days',
        'billing_cycle',
        'status',
    ];

    protected $casts = [
        'price' => 'decimal:2',
        'is_default' => 'boolean',
        'is_trial' => 'boolean',
        'status' => 'integer',
    ];

    public function tenantPlans()
    {
        return $this->hasMany(TenantPlan::class, 'plan_id');
    }

    public function features()
    {
        return $this->belongsToMany(Feature::class, 'plan_features')
            ->withPivot('is_enabled', 'allow_override')
            ->withTimestamps();
    }

    public function isActive()
    {
        return (bool) $this->status;
    }
}