<?php

namespace App\Models;

use Illuminate\Database\Eloquent\SoftDeletes;

class Tenant extends BaseModel
{
    use SoftDeletes;

    protected $fillable = [
        'name',
        'slug',
        'subdomain',
        'email',
        'phone',
        'address',
        'address_line1',
        'city',
        'state',
        'postal_code',
        'logo',
        'primary_color',
        'status',
        // NEW ONBOARDING FIELDS
        'institute_type',
        'country',
        'timezone',
        'currency',
        'website',
        'alternate_contact',
        'secondary_contact_name',
        'board',
        'medium',
        'established_year',
        'tax_id',
        'registration_code',
        'student_count',
        'branch_count',
        'facebook',
        'twitter',
        'instagram',
        'linkedin',
    ];

    protected $casts = [
        'status' => 'integer',
    ];

    public function branches()
    {
        return $this->hasMany(Branch::class);
    }

    public function users()
    {
        return $this->hasMany(User::class);
    }

    public function roles()
    {
        return $this->hasMany(Role::class);
    }

    public function modules()
    {
        return $this->belongsToMany(Module::class, 'tenant_modules')
            ->withPivot('is_enabled')
            ->withTimestamps();
    }

    public function features()
    {
        return $this->belongsToMany(Feature::class, 'tenant_features')
            ->withPivot('is_enabled')
            ->withTimestamps();
    }

    public function isActive()
    {
        return (bool) $this->status;
    }
}