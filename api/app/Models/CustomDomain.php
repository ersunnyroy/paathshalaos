<?php

namespace App\Models;

class CustomDomain extends BaseModel
{
    protected $fillable = [
        'tenant_id',
        'branch_id',
        'domain',
        'type',
        'status',
        'dns_instructions',
        'verified_at',
        'requested_by',
        'rejection_reason',
        'approved_by',
    ];

    protected $casts = [
        'verified_at' => 'datetime',
    ];

    public function tenant()
    {
        return $this->belongsTo(Tenant::class);
    }

    public function branch()
    {
        return $this->belongsTo(Branch::class);
    }

    public function requester()
    {
        return $this->belongsTo(User::class, 'requested_by');
    }

    public function approver()
    {
        return $this->belongsTo(User::class, 'approved_by');
    }

    public function isPending(): bool
    {
        return $this->status === 'pending';
    }

    public function isApproved(): bool
    {
        return $this->status === 'approved';
    }

    public function isRejected(): bool
    {
        return $this->status === 'rejected';
    }

    public function approve(int $approvedBy): void
    {
        $this->update([
            'status' => 'approved',
            'verified_at' => now(),
            'approved_by' => $approvedBy,
        ]);
    }

    public function reject(string $reason, int $approvedBy): void
    {
        $this->update([
            'status' => 'rejected',
            'rejection_reason' => $reason,
            'approved_by' => $approvedBy,
        ]);
    }

    public static function getDnsInstructions(): array
    {
        return [
            'type' => 'CNAME',
            'name' => '@',
            'value' => 'portal.paathshalaos.com',
            'ttl' => 3600,
            'note' => 'Setup may take 24-48 hours to propagate',
        ];
    }
}