<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StorePermissionRequest;
use App\Http\Requests\UpdatePermissionRequest;
use App\Services\PermissionService;
use Illuminate\Http\Request;

class PermissionController extends Controller
{
    public function __construct(
        private PermissionService $permissionService
    ) {}

    public function index(Request $request)
    {
        $permissions = $this->permissionService->getAll($request->all());

        return response()->json([
            'success' => true,
            'data'    => $permissions,
        ]);
    }

    public function store(StorePermissionRequest $request)
    {
        $permission = $this->permissionService->create($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Permission created successfully',
            'data'    => $permission,
        ], 201);
    }

    public function show(int $id)
    {
        $permission = $this->permissionService->findById($id);

        if (!$permission) {
            return response()->json([
                'success' => false,
                'message' => 'Permission not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data'    => $permission,
        ]);
    }

    public function update(UpdatePermissionRequest $request, int $id)
    {
        $permission = $this->permissionService->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Permission updated successfully',
            'data'    => $permission,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->permissionService->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Permission not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Permission deleted successfully',
        ]);
    }
}
