<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\RoleService;
use App\Services\PermissionService;
use Illuminate\Http\Request;

class RoleController extends Controller
{
    public function __construct(
        private RoleService $roleService,
        private PermissionService $permissionService
    ) {}

    public function index(Request $request)
    {
        $filters = $request->all();
        
        if ($request->has('tenant_id')) {
            $filters['tenant_id'] = $request->input('tenant_id');
        } else {
            $filters['tenant_id'] = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;
        }

        $roles = $this->roleService->getAllRoles($filters);

        return response()->json([
            'success' => true,
            'data' => $roles,
        ]);
    }

    public function store(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'description' => ['nullable', 'string', 'max:500'],
            'is_default' => ['nullable', 'in:0,1'],
        ]);

        $data['tenant_id'] = $tenantId;

        $role = $this->roleService->createRole($data);

        return response()->json([
            'success' => true,
            'message' => 'Role created successfully',
            'data' => $role,
        ], 201);
    }

    public function show(int $id)
    {
        $role = $this->roleService->findRoleById($id);

        if (!$role) {
            return response()->json([
                'success' => false,
                'message' => 'Role not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $role,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'description' => ['nullable', 'string', 'max:500'],
            'is_default' => ['nullable', 'in:0,1'],
            'status' => ['nullable', 'in:0,1'],
        ]);

        $role = $this->roleService->updateRole($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Role updated successfully',
            'data' => $role,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->roleService->deleteRole($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Role not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Role deleted successfully',
        ]);
    }

    public function permissions(Request $request, int $id)
    {
        $role = $this->roleService->findRoleById($id);

        if (!$role) {
            return response()->json([
                'success' => false,
                'message' => 'Role not found',
            ], 404);
        }

        $permissions = $this->roleService->getRolePermissions($id);

        return response()->json([
            'success' => true,
            'data' => $permissions,
        ]);
    }

    public function assignPermissions(Request $request, int $id)
    {
        $permissionIds = $request->validate([
            'permission_ids' => ['required', 'array'],
            'permission_ids.*' => ['integer'],
        ]);

        $role = $this->roleService->assignPermissionsToRole($id, $permissionIds['permission_ids']);

        return response()->json([
            'success' => true,
            'message' => 'Permissions assigned successfully',
            'data' => $role->permissions,
        ]);
    }

    public function assignRoleToUser(Request $request)
    {
        $data = $request->validate([
            'user_id' => ['required', 'integer'],
            'role_id' => ['required', 'integer'],
        ]);

        $user = $this->roleService->assignRoleToUser($data['user_id'], $data['role_id']);

        return response()->json([
            'success' => true,
            'message' => 'Role assigned successfully',
            'data' => $user,
        ]);
    }

    public function removeRoleFromUser(Request $request)
    {
        $data = $request->validate([
            'user_id' => ['required', 'integer'],
            'role_id' => ['required', 'integer'],
        ]);

        $user = $this->roleService->removeRoleFromUser($data['user_id'], $data['role_id']);

        return response()->json([
            'success' => true,
            'message' => 'Role removed successfully',
            'data' => $user,
        ]);
    }
}