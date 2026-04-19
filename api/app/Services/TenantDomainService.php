<?php

namespace App\Services;

use App\Models\Tenant;
use App\Models\TenantDomain;
use App\Repositories\Contracts\TenantRepositoryInterface;

class TenantDomainService
{
    public function __construct(
        private TenantRepositoryInterface $tenantRepository
    ) {}

    public function detectTenantByDomain(string $domain): ?Tenant
    {
        $tenantDomain = TenantDomain::where('domain', $domain)
            ->where('status', 1)
            ->first();

        if ($tenantDomain) {
            return $tenantDomain->tenant;
        }

        $subdomain = $this->extractSubdomain($domain);
        if ($subdomain) {
            return $this->tenantRepository->findBySubdomain($subdomain);
        }

        return null;
    }

    public function detectTenantBySubdomain(string $subdomain): ?Tenant
    {
        $tenant = $this->tenantRepository->findBySubdomain($subdomain);
        if ($tenant && $tenant->isActive()) {
            return $tenant;
        }

        $tenantDomain = TenantDomain::where('domain', $subdomain)
            ->where('type', 'subdomain')
            ->where('status', 1)
            ->first();

        return $tenantDomain?->tenant;
    }

    public function getTenantDomain(int $tenantId, string $type = 'subdomain'): ?TenantDomain
    {
        return TenantDomain::where('tenant_id', $tenantId)
            ->where('type', $type)
            ->where('is_primary', 1)
            ->first();
    }

    public function addCustomDomain(int $tenantId, string $domain, int $branchId = null): TenantDomain
    {
        $existing = TenantDomain::where('domain', $domain)->first();
        if ($existing) {
            throw new \Exception('Domain already in use');
        }

        return TenantDomain::create([
            'tenant_id' => $tenantId,
            'branch_id' => $branchId,
            'domain' => $domain,
            'type' => 'custom',
            'is_primary' => 1,
            'status' => 1,
        ]);
    }

    public function getPrimaryDomain(int $tenantId): ?string
    {
        $domain = TenantDomain::where('tenant_id', $tenantId)
            ->where('is_primary', 1)
            ->first();

        return $domain?->domain;
    }

    public function setPrimaryDomain(int $tenantId, int $domainId): void
    {
        TenantDomain::where('tenant_id', $tenantId)
            ->where('is_primary', 1)
            ->update(['is_primary' => 0]);

        TenantDomain::where('id', $domainId)
            ->where('tenant_id', $tenantId)
            ->update(['is_primary' => 1]);
    }

    private function extractSubdomain(string $host): ?string
    {
        $parts = explode('.', $host);

        if (count($parts) > 2) {
            return $parts[0];
        }

        return null;
    }
}