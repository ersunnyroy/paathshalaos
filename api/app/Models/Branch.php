<?php

namespace App\Models;

use Illuminate\Database\Eloquent\SoftDeletes;

class Branch extends BaseModel
{
    use SoftDeletes;

    protected $fillable = [
        'tenant_id',
        'name',
        'slug',
        'subdomain',
        'address',
        'phone',
        'email',
        'status',
    ];

    protected $casts = [
        'status' => 'integer',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }

    public function users()
    {
        return $this->hasMany(User::class);
    }

    public function isActive()
    {
        return (bool) $this->status;
    }
}