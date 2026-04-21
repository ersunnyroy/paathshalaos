<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreUserRequest;
use App\Http\Requests\UpdateUserRequest;
use App\Http\Resources\UserResource;
use App\Models\Role;
use App\Services\UserService;
use Illuminate\Http\Request;

class UserController extends Controller
{
    public function __construct(
        private UserService $userService
    ) {}

    public function index(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $filters = $request->all();
        if ($tenantId && !$request->has('tenant_id')) {
            $filters['tenant_id'] = $tenantId;
        }

        $users = $this->userService->getAll($filters);

        return response()->json([
            'success' => true,
            'data'    => $users,
        ]);
    }

    public function store(StoreUserRequest $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $data              = $request->validated();
        $roleId            = $data['role_id'] ?? null;
        $data['tenant_id'] = $tenantId;

        $user = $this->userService->create($data);

        if ($roleId) {
            $role = Role::where('tenant_id', $tenantId)->find($roleId);
            if ($role) {
                $user->assignRole($role);
            }
        }

        return response()->json([
            'success' => true,
            'message' => 'User created successfully',
            'data'    => new UserResource($user->load('roles')),
        ], 201);
    }

    public function show(int $id)
    {
        $user = $this->userService->findById($id);

        if (!$user) {
            return response()->json([
                'success' => false,
                'message' => 'User not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data'    => $user,
        ]);
    }

    public function update(UpdateUserRequest $request, int $id)
    {
        $user = $this->userService->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'User updated successfully',
            'data'    => $user,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->userService->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'User not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'User deleted successfully',
        ]);
    }
}
