<?php

namespace App\Models\Traits;

use Illuminate\Http\Request;

trait BranchScopeTrait
{
    protected function applyBranchScope($query, ?int $branchId = null, ?int $tenantId = null)
    {
        $request = request();
        
        $branchId = $branchId ?? $request->header('X-Branch-ID');
        $user = $request->user();

        if (!$branchId && $user && $user->branch_id) {
            $branchId = $user->branch_id;
        }

        $tenantId = $tenantId ?? $user?->tenant_id;

        if ($tenantId) {
            $query->where('tenant_id', $tenantId);
        }

        if ($branchId) {
            $query->where('branch_id', $branchId);
        }

        return $query;
    }

    protected function isBranchAdmin(?int $userId = null): bool
    {
        $user = $userId ? \App\Models\User::find($userId) : request()->user();
        
        if (!$user) {
            return false;
        }

        if ($user->branch_id) {
            return true;
        }

        return false;
    }

    protected function canAccessAllBranches(?int $userId = null): bool
    {
        $user = $userId ? \App\Models\User::find($userId) : request()->user();
        
        if (!$user) {
            return false;
        }

        if ($user->hasRole('super_admin') || $user->hasRole('admin')) {
            return true;
        }

        return false;
    }
}