<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\AuthService;
use App\Repositories\Contracts\BranchRepositoryInterface;
use App\Http\Requests\RegisterRequest;
use App\Http\Requests\LoginRequest;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class AuthController extends Controller
{
    public function __construct(
        private AuthService $authService,
        private BranchRepositoryInterface $branchRepository
    ) {}

    public function register(RegisterRequest $request)
    {
        $data = $this->authService->register($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Registration successful',
            'data' => [
                'tenant' => $data['tenant'],
                'user' => [
                    'id' => $data['user']->id,
                    'name' => $data['user']->name,
                    'email' => $data['user']->email,
                ],
                'token' => $data['token'],
            ],
        ], 201);
    }

    public function login(LoginRequest $request)
    {
        $data = $this->authService->login($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Login successful',
            'data' => [
                'user' => $data['user'],
                'tenant' => $data['tenant'] ?? null,
                'branches' => $data['branches'] ?? [],
                'selected_branch' => $data['selected_branch'] ?? null,
                'token' => $data['token'],
            ],
        ]);
    }

    public function branches(Request $request)
    {
        $user = $request->user();
        $tenantId = $user->tenant_id;

        $branches = $this->branchRepository->getAll([
            'tenant_id' => $tenantId,
            'status' => 1,
        ]);

        return response()->json([
            'success' => true,
            'data' => $branches,
        ]);
    }

    public function logout(Request $request)
    {
        $this->authService->logout($request->user());

        return response()->json([
            'success' => true,
            'message' => 'Logout successful',
        ]);
    }

    public function me(Request $request)
    {
        $user = $this->authService->getCurrentUser($request->user()->id);

        return response()->json([
            'success' => true,
            'data' => $user,
        ]);
    }

    public function refresh(Request $request)
    {
        $request->user()->currentAccessToken()->delete();

        $token = $request->user()->createToken('auth-token')->plainTextToken;

        return response()->json([
            'success' => true,
            'data' => [
                'token' => $token,
            ],
        ]);
    }

    public function tenant(Request $request)
    {
        $subdomain = $request->query('subdomain');
        
        if (!$subdomain) {
            return response()->json([
                'success' => false,
                'message' => 'Subdomain is required',
            ], 400);
        }

        $tenant = \App\Models\Tenant::where('subdomain', $subdomain)->first();

        if (!$tenant) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $tenant,
        ]);
    }

    public function forgotPassword(Request $request)
    {
        $data = $request->validate([
            'email' => ['required', 'email'],
        ]);

        $result = $this->authService->forgotPassword($data['email']);

        return response()->json($result);
    }

    public function resetPassword(Request $request)
    {
        $data = $request->validate([
            'email' => ['required', 'email'],
            'token' => ['required', 'string'],
            'password' => ['required', 'string', 'min:6'],
        ]);

        $result = $this->authService->resetPassword(
            $data['email'],
            $data['token'],
            $data['password']
        );

        return response()->json($result);
    }

    public function changePassword(Request $request)
    {
        $data = $request->validate([
            'current_password' => ['required', 'string'],
            'new_password' => ['required', 'string', 'min:6'],
        ]);

        $result = $this->authService->changePassword(
            $request->user()->id,
            $data['current_password'],
            $data['new_password']
        );

        return response()->json($result);
    }
}