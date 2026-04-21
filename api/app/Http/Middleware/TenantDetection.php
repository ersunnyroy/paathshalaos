<?php

namespace App\Http\Middleware;

use App\Models\Tenant;
use App\Services\TenantDomainService;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class TenantDetection
{
    protected TenantDomainService $domainService;

    public function __construct(TenantDomainService $domainService)
    {
        $this->domainService = $domainService;
    }

    public function handle(Request $request, Closure $next): Response
    {
        $tenant = $this->detectTenant($request);

        if ($tenant && !$tenant->isActive()) {
            return response()->json([
                'success' => false,
                'message' => 'Institution is inactive',
            ], 403);
        }

        $request->merge(['current_tenant' => $tenant]);

        if ($tenant) {
            $request->headers->set('X-Tenant-ID', (string) $tenant->id);
        }

        return $next($request);
    }

    private function detectTenant(Request $request): ?Tenant
    {
        // 1. Explicit tenant ID header (fastest)
        $tenantId = $request->header('X-Tenant-ID');
        if ($tenantId) {
            $tenant = Tenant::find($tenantId);
            if ($tenant && $tenant->isActive()) {
                return $tenant;
            }
        }

        // 2. Resolved host header sent by frontend (used in local dev and proxied requests)
        $tenantHost = $request->header('X-Tenant-Host');
        if ($tenantHost) {
            $tenant = $this->domainService->detectTenantByDomain($tenantHost);
            if ($tenant && $tenant->isActive()) {
                return $tenant;
            }
        }

        // 3. Actual request host (production / staging)
        $host = $request->getHost();
        if ($host && $host !== 'localhost' && $host !== '127.0.0.1') {
            return $this->domainService->detectTenantByDomain($host);
        }

        // 4. Authenticated user's tenant
        $user = $request->user();
        if ($user && $user->tenant_id) {
            return Tenant::find($user->tenant_id);
        }

        return null;
    }
}