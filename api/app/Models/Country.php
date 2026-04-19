<?php

namespace App\Models;

class Country extends BaseModel
{
    protected $fillable = [
        'name',
        'code',
        'currency',
        'currency_symbol',
        'timezone',
        'flag',
        'sort_order',
        'status',
    ];

    protected $casts = [
        'status' => 'integer',
    ];

    public function states()
    {
        return $this->hasMany(State::class);
    }

    public function boards()
    {
        return $this->hasMany(Board::class);
    }
}