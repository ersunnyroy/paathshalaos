<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreModuleRequest;
use App\Http\Requests\UpdateModuleRequest;
use App\Http\Requests\ToggleModuleRequest;
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
        $modules = $this->moduleService->getAll($request->all());

        return response()->json([
            'success' => true,
            'data'    => $modules,
        ]);
    }

    public function store(StoreModuleRequest $request)
    {
        $module = $this->moduleService->create($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Module created successfully',
            'data'    => $module,
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
            'data'    => $module,
        ]);
    }

    public function update(UpdateModuleRequest $request, int $id)
    {
        $module = $this->moduleService->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Module updated successfully',
            'data'    => $module,
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

    public function toggle(ToggleModuleRequest $request, int $id)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $this->tenantService->toggleModule($tenantId, $id, $request->validated()['is_enabled']);

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
            'data'    => $modules,
        ]);
    }
}
