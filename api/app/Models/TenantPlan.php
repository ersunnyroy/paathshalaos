<?php

namespace App\Models;

class TenantPlan extends BaseModel
{
    protected $fillable = [
        'tenant_id',
        'plan_id',
        'start_date',
        'end_date',
        'billing_cycle',
        'amount_paid',
        'payment_method',
        'transaction_id',
        'status',
    ];

    protected $casts = [
        'start_date' => 'date',
        'end_date' => 'date',
        'amount_paid' => 'decimal:2',
        'status' => 'integer',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }

    public function plan()
    {
        return $this->belongsTo(Plan::class);
    }

    public function isActive()
    {
        return (bool) $this->status;
    }

    public function isExpired()
    {
        return $this->end_date && $this->end_date->isPast();
    }
}