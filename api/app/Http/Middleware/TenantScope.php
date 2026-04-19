<?php

namespace App\Http\Middleware;

use App\Services\TenantService;
use App\Models\Tenant;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class TenantScope
{
    protected TenantService $tenantService;

    public function __construct(TenantService $tenantService)
    {
        $this->tenantService = $tenantService;
    }

    public function handle(Request $request, Closure $next): Response
    {
        $subdomain = $this->getSubdomain($request);
        $tenantId = $request->header('X-Tenant-ID');
        $user = $request->user();

        if ($tenantId) {
            $tenant = $this->tenantService->findById($tenantId);
        } elseif ($subdomain) {
            $tenant = $this->tenantService->findBySubdomain($subdomain);
        } elseif ($user && $user->tenant_id) {
            $tenant = $this->tenantService->findById($user->tenant_id);
        } else {
            $tenant = null;
        }

        if ($tenant && !$tenant->isActive()) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant is inactive',
            ], 403);
        }

        $request->merge(['tenant' => $tenant]);

        return $next($request);
    }

    private function getSubdomain(Request $request): ?string
    {
        $host = $request->getHost();
        $parts = explode('.', $host);

        if (count($parts) > 2) {
            return $parts[0];
        }

        return null;
    }
}