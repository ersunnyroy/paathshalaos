<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
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
            'data' => $users,
        ]);
    }

    public function store(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;
        $roleId = $request->input('role_id');

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'unique:users,email'],
            'phone' => ['nullable', 'string', 'max:20', 'unique:users,phone'],
            'password' => ['required', 'string', 'min:8'],
            'status' => ['nullable', 'in:0,1'],
            'role_id' => ['nullable', 'integer'],
        ]);

        $data['tenant_id'] = $tenantId;

        $user = $this->userService->create($data);

        if ($roleId) {
            $role = \App\Models\Role::where('tenant_id', $tenantId)->find($roleId);
            if ($role) {
                $user->assignRole($role);
            }
        }

        return response()->json([
            'success' => true,
            'message' => 'User created successfully',
            'data' => new \App\Http\Resources\UserResource($user->load('roles')),
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
            'data' => $user,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'email' => ['sometimes', 'email', 'unique:users,email,' . $id],
            'phone' => ['nullable', 'string', 'max:20', 'unique:users,phone,' . $id],
            'password' => ['sometimes', 'string', 'min:8'],
            'status' => ['nullable', 'in:0,1'],
        ]);

        $user = $this->userService->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'User updated successfully',
            'data' => $user,
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