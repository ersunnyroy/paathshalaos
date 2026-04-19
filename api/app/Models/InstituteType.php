<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class InstituteType extends Model
{
    protected $fillable = ['name', 'slug', 'category', 'sort_order', 'is_active'];
    protected $casts = ['is_active' => 'boolean'];
}