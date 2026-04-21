<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreRoleRequest;
use App\Http\Requests\UpdateRoleRequest;
use App\Http\Requests\AssignPermissionsRequest;
use App\Http\Requests\AssignRoleToUserRequest;
use App\Http\Requests\RemoveRoleFromUserRequest;
use App\Services\RoleService;
use App\Services\PermissionService;
use Illuminate\Http\Request;
use App\Helpers\CommonHelper;
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
            // decrypt by xor before using in the repository
            $filters['tenant_id'] = CommonHelper::decryptId($request->input('tenant_id'));
        } else {
            $filters['tenant_id'] = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;
        }


        $roles = $this->roleService->getAllRoles($filters);
        return response()->json([
            'success' => true,
            'data'    => $roles,
        ]);
    }

    public function store(StoreRoleRequest $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $data               = $request->validated();
        $data['tenant_id']  = $tenantId;

        $role = $this->roleService->createRole($data);

        return response()->json([
            'success' => true,
            'message' => 'Role created successfully',
            'data'    => $role,
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
            'data'    => $role,
        ]);
    }

    public function update(UpdateRoleRequest $request, int $id)
    {
        $role = $this->roleService->updateRole($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Role updated successfully',
            'data'    => $role,
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

    public function permissions(int $id)
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
            'data'    => $this->roleService->getRolePermissions($id),
        ]);
    }

    public function assignPermissions(AssignPermissionsRequest $request, int $id)
    {
        $role = $this->roleService->assignPermissionsToRole($id, $request->validated()['permission_ids']);

        return response()->json([
            'success' => true,
            'message' => 'Permissions assigned successfully',
            'data'    => $role->permissions,
        ]);
    }

    public function assignRoleToUser(AssignRoleToUserRequest $request)
    {
        $data = $request->validated();
        $user = $this->roleService->assignRoleToUser($data['user_id'], $data['role_id']);

        return response()->json([
            'success' => true,
            'message' => 'Role assigned successfully',
            'data'    => $user,
        ]);
    }

    public function removeRoleFromUser(RemoveRoleFromUserRequest $request)
    {
        $data = $request->validated();
        $user = $this->roleService->removeRoleFromUser($data['user_id'], $data['role_id']);

        return response()->json([
            'success' => true,
            'message' => 'Role removed successfully',
            'data'    => $user,
        ]);
    }
}
