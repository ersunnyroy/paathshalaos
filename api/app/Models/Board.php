<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Board extends Model
{
    protected $fillable = ['country_id', 'name', 'slug', 'code', 'sort_order', 'is_active'];
    protected $casts = ['is_active' => 'boolean'];

    public function country()
    {
        return $this->belongsTo(Country::class);
    }
}