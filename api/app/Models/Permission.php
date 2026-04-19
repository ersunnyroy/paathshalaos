<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Permission extends Model
{
    use SoftDeletes;

    protected $fillable = [
        'name',
        'slug',
        'description',
        'module',
        'is_global',
        'status',
    ];

    protected $casts = [
        'is_global' => 'boolean',
        'status' => 'boolean',
    ];

    public function roles()
    {
        return $this->belongsToMany(Role::class, 'role_permissions')
            ->withPivot('assigned_by')
            ->withTimestamps();
    }

    public function isActive()
    {
        return (bool) $this->status;
    }

    public function isGlobal()
    {
        return (bool) $this->is_global;
    }
}