<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Role extends Model
{
    use SoftDeletes;

    protected $fillable = [
        'tenant_id',
        'name',
        'slug',
        'description',
        'is_default',
        'status',
    ];

    protected $casts = [
        'is_default' => 'boolean',
        'status' => 'boolean',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }

    public function users()
    {
        return $this->belongsToMany(User::class, 'user_roles')
            ->withPivot('assigned_by')
            ->withTimestamps();
    }

    public function permissions()
    {
        return $this->belongsToMany(Permission::class, 'role_permissions')
            ->withPivot('assigned_by')
            ->withTimestamps();
    }

    public function isActive()
    {
        return (bool) $this->status;
    }

    public function givePermissionTo(Permission $permission)
    {
        if ($this->permissions()->where('permission_id', $permission->id)->doesntExist()) {
            $this->permissions()->attach($permission->id, [
                'assigned_by' => auth()->id() ?? null,
            ]);
        }
    }

    public function removePermission(Permission $permission)
    {
        $this->permissions()->detach($permission->id);
    }

    public function syncPermissions(array $permissionIds)
    {
        $this->permissions()->sync($permissionIds);
    }
}