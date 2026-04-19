<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Medium extends Model
{
    protected $fillable = ['name', 'slug', 'sort_order', 'is_active'];
    protected $casts = ['is_active' => 'boolean'];
}