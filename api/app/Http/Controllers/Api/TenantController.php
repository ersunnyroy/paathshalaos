<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreTenantRequest;
use App\Http\Requests\UpdateTenantRequest;
use App\Http\Requests\ToggleTenantStatusRequest;
use App\Services\TenantService;
use App\Services\TenantDomainService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TenantController extends Controller
{
    public function __construct(
        private TenantService $tenantService,
        private TenantDomainService $domainService
    ) {}

    public function index(Request $request)
    {
        $tenants = $this->tenantService->getAll($request->all());

        return response()->json([
            'success' => true,
            'data'    => $tenants,
        ]);
    }

    public function store(StoreTenantRequest $request)
    {
        $tenant = $this->tenantService->create($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Tenant created successfully',
            'data'    => $tenant,
        ], 201);
    }

    public function checkSubdomain(Request $request)
    {
        $subdomain = $request->query('subdomain');

        if (!$subdomain) {
            return response()->json([
                'success' => false,
                'message' => 'Subdomain is required',
            ], 400);
        }

        $exists = $this->tenantService->findBySubdomain($subdomain);

        return response()->json([
            'success'   => true,
            'available' => !$exists,
            'message'   => $exists ? 'This subdomain is already taken. Please choose another.' : 'Subdomain is available',
        ]);
    }

    public function checkDomain(Request $request)
    {
        $domain = $request->query('domain');

        if (!$domain) {
            return response()->json([
                'success' => false,
                'message' => 'Domain is required',
            ], 400);
        }

        $exists = $this->tenantService->findBySubdomain($domain);

        return response()->json([
            'success'   => true,
            'available' => !$exists,
            'message'   => $exists ? 'This domain is already taken. Please choose another.' : 'Domain is available',
        ]);
    }

    public function show(int $id)
    {
        $tenant = $this->tenantService->findById($id);

        if (!$tenant) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data'    => $tenant,
        ]);
    }

    public function update(UpdateTenantRequest $request, int $id)
    {
        $tenant = $this->tenantService->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Tenant updated successfully',
            'data'    => $tenant,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->tenantService->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Tenant deleted successfully',
        ]);
    }

    public function toggleStatus(ToggleTenantStatusRequest $request, int $id)
    {
        $tenant = $this->tenantService->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Status updated successfully',
            'data'    => $tenant,
        ]);
    }

    public function stats()
    {
        return response()->json([
            'success' => true,
            'data'    => [
                'total_tenants'    => DB::table('tenants')->count(),
                'active_tenants'   => DB::table('tenants')->where('status', 1)->count(),
                'inactive_tenants' => DB::table('tenants')->where('status', 0)->count(),
                'total_users'      => DB::table('users')->count(),
                'total_branches'   => DB::table('branches')->count(),
            ],
        ]);
    }

    public function info(Request $request)
    {
        // Primary: full domain from X-Tenant-Host header
        // Fallback: construct from ?tenant_key= (local dev convenience)
        $host = $request->header('X-Tenant-Host');

        if (!$host) {
            $tenantKey = $request->query('tenant_key');
            if ($tenantKey) {
                $appDomain = config('app.domain', 'paathshalaos.com');
                $host = $tenantKey . '.' . $appDomain;
            }
        }

        if (!$host) {
            return response()->json([
                'success' => false,
                'message' => 'X-Tenant-Host header is required',
            ], 400);
        }

        $tenant = $this->domainService->detectTenantByDomain($host);

        if (!$tenant) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant not found',
            ], 404);
        }

        if (!$tenant->isActive()) {
            return response()->json([
                'success' => false,
                'message' => 'Institution is inactive',
            ], 403);
        }

        return response()->json([
            'success' => true,
            'data'    => [
                'id'              => $tenant->id,
                'name'            => $tenant->name,
                'subdomain'       => $tenant->subdomain,
                'logo_url'        => $tenant->logo_url,
                'favicon_url'     => $tenant->favicon_url,
                'primary_color'   => $tenant->primary_color,
                'secondary_color' => $tenant->secondary_color ?? null,
                'host'            => $host,
            ],
        ]);
    }

    public function byDomain(Request $request)
    {
        $host      = $request->getHost();
        $subdomain = $request->query('subdomain');

        $tenant = $subdomain
            ? $this->tenantService->findBySubdomain($subdomain)
            : $this->tenantService->findBySubdomain($host);

        if (!$tenant || !$tenant->status) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data'    => [
                'id'             => $tenant->id,
                'name'           => $tenant->name,
                'subdomain'      => $tenant->subdomain,
                'email'          => $tenant->email,
                'phone'          => $tenant->phone,
                'logo'           => $tenant->logo,
                'favicon'        => $tenant->favicon,
                'primary_color'  => $tenant->primary_color,
                'secondary_color'=> $tenant->secondary_color,
                'address'        => $tenant->address,
                'website'        => $tenant->website,
                'institute_type' => $tenant->institute_type,
            ],
        ]);
    }
}
