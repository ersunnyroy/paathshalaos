<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\FeatureService;
use App\Services\TenantService;
use Illuminate\Http\Request;

class FeatureController extends Controller
{
    public function __construct(
        private FeatureService $featureService,
        private TenantService $tenantService
    ) {}

    public function index(Request $request)
    {
        $filters = $request->all();
        $features = $this->featureService->getAll($filters);

        return response()->json([
            'success' => true,
            'data' => $features,
        ]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'module_id' => ['required', 'integer'],
            'name' => ['required', 'string', 'max:255'],
            'slug' => ['required', 'string', 'max:100', 'unique:features,slug'],
            'description' => ['nullable', 'string', 'max:500'],
            'sort_order' => ['nullable', 'integer'],
            'is_default_enabled' => ['nullable', 'in:0,1'],
        ]);

        $feature = $this->featureService->create($data);

        return response()->json([
            'success' => true,
            'message' => 'Feature created successfully',
            'data' => $feature,
        ], 201);
    }

    public function show(int $id)
    {
        $feature = $this->featureService->findById($id);

        if (!$feature) {
            return response()->json([
                'success' => false,
                'message' => 'Feature not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $feature,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'module_id' => ['sometimes', 'integer'],
            'name' => ['sometimes', 'string', 'max:255'],
            'slug' => ['sometimes', 'string', 'max:100', 'unique:features,slug,' . $id],
            'description' => ['nullable', 'string', 'max:500'],
            'sort_order' => ['nullable', 'integer'],
            'is_default_enabled' => ['nullable', 'in:0,1'],
            'status' => ['nullable', 'in:0,1'],
        ]);

        $feature = $this->featureService->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Feature updated successfully',
            'data' => $feature,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->featureService->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Feature not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Feature deleted successfully',
        ]);
    }

    public function toggle(Request $request, int $id)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $isEnabled = $request->validate([
            'is_enabled' => ['required', 'boolean'],
        ]);

        $this->tenantService->toggleFeature($tenantId, $id, $isEnabled['is_enabled']);

        return response()->json([
            'success' => true,
            'message' => 'Feature toggled successfully',
        ]);
    }

    public function tenantFeatures(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $features = $this->tenantService->getEnabledFeatures($tenantId);

        return response()->json([
            'success' => true,
            'data' => $features,
        ]);
    }

    public function checkFeature(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;
        $featureSlug = $request->query('feature');

        if (!$featureSlug) {
            return response()->json([
                'success' => false,
                'message' => 'Feature slug is required',
            ], 422);
        }

        $isEnabled = $this->tenantService->isFeatureEnabled($tenantId, $featureSlug);

        return response()->json([
            'success' => true,
            'data' => [
                'feature' => $featureSlug,
                'is_enabled' => $isEnabled,
            ],
        ]);
    }
}