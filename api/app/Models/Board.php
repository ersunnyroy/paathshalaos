<?php

namespace App\Models;

class Board extends BaseModel
{
    protected $fillable = ['country_id', 'name', 'slug', 'code', 'sort_order', 'is_active'];
    protected $casts = ['is_active' => 'boolean'];

    public function country()
    {
        return $this->belongsTo(Country::class);
    }
}