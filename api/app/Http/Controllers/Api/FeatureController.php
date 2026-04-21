<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreFeatureRequest;
use App\Http\Requests\UpdateFeatureRequest;
use App\Http\Requests\ToggleFeatureRequest;
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
        $features = $this->featureService->getAll($request->all());

        return response()->json([
            'success' => true,
            'data'    => $features,
        ]);
    }

    public function store(StoreFeatureRequest $request)
    {
        $feature = $this->featureService->create($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Feature created successfully',
            'data'    => $feature,
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
            'data'    => $feature,
        ]);
    }

    public function update(UpdateFeatureRequest $request, int $id)
    {
        $feature = $this->featureService->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Feature updated successfully',
            'data'    => $feature,
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

    public function toggle(ToggleFeatureRequest $request, int $id)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $this->tenantService->toggleFeature($tenantId, $id, $request->validated()['is_enabled']);

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
            'data'    => $features,
        ]);
    }

    public function checkFeature(Request $request)
    {
        $tenantId    = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;
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
            'data'    => [
                'feature'    => $featureSlug,
                'is_enabled' => $isEnabled,
            ],
        ]);
    }
}
