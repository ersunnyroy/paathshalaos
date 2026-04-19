<?php

namespace App\Models;

use Illuminate\Database\Eloquent\SoftDeletes;

class TenantDomain extends BaseModel
{
    use SoftDeletes;

    protected $fillable = [
        'tenant_id',
        'branch_id',
        'domain',
        'type',
        'is_primary',
        'status',
    ];

    protected $casts = [
        'is_primary' => 'boolean',
        'status' => 'integer',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }

    public function branch()
    {
        return $this->belongsTo(Branch::class);
    }

    public function isPrimary(): bool
    {
        return (bool) $this->is_primary;
    }

    public function isActive(): bool
    {
        return (bool) $this->status;
    }
}