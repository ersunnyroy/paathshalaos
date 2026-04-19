<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\PermissionService;
use Illuminate\Http\Request;

class PermissionController extends Controller
{
    public function __construct(
        private PermissionService $permissionService
    ) {}

    public function index(Request $request)
    {
        $filters = $request->all();
        $permissions = $this->permissionService->getAll($filters);

        return response()->json([
            'success' => true,
            'data' => $permissions,
        ]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'slug' => ['required', 'string', 'max:100', 'unique:permissions,slug'],
            'description' => ['nullable', 'string', 'max:500'],
            'module' => ['nullable', 'string', 'max:100'],
            'is_global' => ['nullable', 'in:0,1'],
        ]);

        $permission = $this->permissionService->create($data);

        return response()->json([
            'success' => true,
            'message' => 'Permission created successfully',
            'data' => $permission,
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
            'data' => $permission,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'slug' => ['sometimes', 'string', 'max:100', 'unique:permissions,slug,' . $id],
            'description' => ['nullable', 'string', 'max:500'],
            'module' => ['nullable', 'string', 'max:100'],
            'is_global' => ['nullable', 'in:0,1'],
            'status' => ['nullable', 'in:0,1'],
        ]);

        $permission = $this->permissionService->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Permission updated successfully',
            'data' => $permission,
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