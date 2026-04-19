<?php

namespace App\Models;

class Medium extends BaseModel
{
    protected $fillable = ['name', 'slug', 'sort_order', 'is_active'];
    protected $casts = ['is_active' => 'boolean'];
}