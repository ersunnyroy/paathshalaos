<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class BranchScope
{
    public function handle(Request $request, Closure $next): Response
    {
        $branchId = $request->header('X-Branch-ID');
        $user = $request->user();

        $effectiveBranchId = $branchId ?? $user?->branch_id;

        if ($user && $user->branch_id && !$branchId) {
            $effectiveBranchId = $user->branch_id;
        }

        $request->merge(['branch_id' => $effectiveBranchId]);
        $request->attributes->set('branch_id', $effectiveBranchId);

        return $next($request);
    }
}