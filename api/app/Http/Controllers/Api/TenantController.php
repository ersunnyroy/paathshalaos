<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\TenantService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class TenantController extends Controller
{
    public function __construct(
        private TenantService $tenantService
    ) {}

    public function index(Request $request)
    {
        $filters = $request->all();

        $tenants = $this->tenantService->getAll($filters);

        return response()->json([
            'success' => true,
            'data' => $tenants,
        ]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'slug' => ['required', 'string', 'max:255', 'unique:tenants,slug'],
            'subdomain' => ['required', 'string', 'max:63', 'unique:tenants,subdomain'],
            'email' => ['required', 'email'],
            'phone' => ['nullable', 'string', 'max:20'],
            'address' => ['nullable', 'string', 'max:500'],
            'status' => ['nullable', 'in:0,1'],
            'institute_type' => ['nullable', 'string', 'max:100'],
            'country' => ['nullable', 'string', 'max:2'],
            'timezone' => ['nullable', 'string', 'max:50'],
            'currency' => ['nullable', 'string', 'max:3'],
        ]);

        $tenant = $this->tenantService->create($data);

        return response()->json([
            'success' => true,
            'message' => 'Tenant created successfully',
            'data' => $tenant,
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
            'success' => true,
            'available' => !$exists,
            'message' => $exists ? 'Subdomain is already taken' : 'Subdomain is available',
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
            'success' => true,
            'available' => !$exists,
            'message' => $exists ? 'Domain is already taken' : 'Domain is available',
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
            'data' => $tenant,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'slug' => ['sometimes', 'string', 'max:255', 'unique:tenants,slug,' . $id],
            'subdomain' => ['sometimes', 'string', 'max:63', 'unique:tenants,subdomain,' . $id],
            'email' => ['sometimes', 'email'],
            'phone' => ['nullable', 'string', 'max:20'],
            'address' => ['nullable', 'string', 'max:500'],
            'status' => ['nullable', 'in:0,1'],
            'institute_type' => ['nullable', 'string', 'max:100'],
            'country' => ['nullable', 'string', 'max:2'],
            'timezone' => ['nullable', 'string', 'max:50'],
            'currency' => ['nullable', 'string', 'max:3'],
        ]);

        $tenant = $this->tenantService->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Tenant updated successfully',
            'data' => $tenant,
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

    public function toggleStatus(Request $request, int $id)
    {
        $data = $request->validate([
            'status' => ['required', 'in:0,1'],
        ]);

        $tenant = $this->tenantService->update($id, ['status' => $data['status']]);

        return response()->json([
            'success' => true,
            'message' => 'Status updated successfully',
            'data' => $tenant,
        ]);
    }

    public function stats()
    {
        $totalTenants = DB::table('tenants')->count();
        $activeTenants = DB::table('tenants')->where('status', 1)->count();
        $inactiveTenants = DB::table('tenants')->where('status', 0)->count();
        $totalUsers = DB::table('users')->count();
        $totalBranches = DB::table('branches')->count();

        return response()->json([
            'success' => true,
            'data' => [
                'total_tenants' => $totalTenants,
                'active_tenants' => $activeTenants,
                'inactive_tenants' => $inactiveTenants,
                'total_users' => $totalUsers,
                'total_branches' => $totalBranches,
            ],
        ]);
    }

    public function byDomain(Request $request)
    {
        $host = $request->getHost();
        $subdomain = $request->query('subdomain');

        if ($subdomain) {
            $tenant = $this->tenantService->findBySubdomain($subdomain);
        } else {
            $tenant = $this->tenantService->findBySubdomain($host);
        }

        if (!$tenant || !$tenant->status) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => [
                'id' => $tenant->id,
                'name' => $tenant->name,
                'subdomain' => $tenant->subdomain,
                'email' => $tenant->email,
                'phone' => $tenant->phone,
                'logo' => $tenant->logo,
                'favicon' => $tenant->favicon,
                'primary_color' => $tenant->primary_color,
                'secondary_color' => $tenant->secondary_color,
                'address' => $tenant->address,
                'website' => $tenant->website,
                'institute_type' => $tenant->institute_type,
            ],
        ]);
    }
}