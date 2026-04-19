<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\ModuleService;
use App\Services\TenantService;
use Illuminate\Http\Request;

class ModuleController extends Controller
{
    public function __construct(
        private ModuleService $moduleService,
        private TenantService $tenantService
    ) {}

    public function index(Request $request)
    {
        $filters = $request->all();
        $modules = $this->moduleService->getAll($filters);

        return response()->json([
            'success' => true,
            'data' => $modules,
        ]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'slug' => ['required', 'string', 'max:100', 'unique:modules,slug'],
            'description' => ['nullable', 'string', 'max:500'],
            'icon' => ['nullable', 'string', 'max:100'],
            'sort_order' => ['nullable', 'integer'],
            'is_core' => ['nullable', 'in:0,1'],
        ]);

        $module = $this->moduleService->create($data);

        return response()->json([
            'success' => true,
            'message' => 'Module created successfully',
            'data' => $module,
        ], 201);
    }

    public function show(int $id)
    {
        $module = $this->moduleService->findById($id);

        if (!$module) {
            return response()->json([
                'success' => false,
                'message' => 'Module not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $module,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'slug' => ['sometimes', 'string', 'max:100', 'unique:modules,slug,' . $id],
            'description' => ['nullable', 'string', 'max:500'],
            'icon' => ['nullable', 'string', 'max:100'],
            'sort_order' => ['nullable', 'integer'],
            'is_core' => ['nullable', 'in:0,1'],
            'status' => ['nullable', 'in:0,1'],
        ]);

        $module = $this->moduleService->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Module updated successfully',
            'data' => $module,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->moduleService->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Module not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Module deleted successfully',
        ]);
    }

    public function toggle(Request $request, int $id)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $isEnabled = $request->validate([
            'is_enabled' => ['required', 'boolean'],
        ]);

        $this->tenantService->toggleModule($tenantId, $id, $isEnabled['is_enabled']);

        return response()->json([
            'success' => true,
            'message' => 'Module toggled successfully',
        ]);
    }

    public function tenantModules(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $modules = $this->tenantService->getEnabledModules($tenantId);

        return response()->json([
            'success' => true,
            'data' => $modules,
        ]);
    }
}