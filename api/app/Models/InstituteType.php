<?php

namespace App\Models;

class InstituteType extends BaseModel
{
    protected $fillable = ['name', 'slug', 'category', 'sort_order', 'is_active'];
    protected $casts = ['is_active' => 'boolean'];
}