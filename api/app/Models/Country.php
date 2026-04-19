<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Country extends Model
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
        'status' => 'boolean',
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