<?php

namespace App\Models;

class State extends BaseModel
{
    protected $fillable = [
        'country_id',
        'name',
        'code',
        'timezone',
        'sort_order',
        'status',
    ];

    protected $casts = [
        'status' => 'integer',
    ];

    public function country()
    {
        return $this->belongsTo(Country::class);
    }
}