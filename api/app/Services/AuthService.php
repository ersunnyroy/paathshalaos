<?php

namespace App\Services;

use App\Models\Tenant;
use App\Models\User;
use App\Models\Role;
use App\Repositories\Contracts\TenantRepositoryInterface;
use App\Repositories\Contracts\UserRepositoryInterface;
use App\Repositories\Contracts\RoleRepositoryInterface;
use App\Repositories\Contracts\BranchRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class AuthService
{
    public function __construct(
        private TenantRepositoryInterface $tenantRepository,
        private UserRepositoryInterface $userRepository,
        private RoleRepositoryInterface $roleRepository,
        private BranchRepositoryInterface $branchRepository,
        private TenantService $tenantService,
    ) {}

    public function register(array $data): array
    {
        $subdomain = strtolower($data['subdomain'] ?? str()->slug($data['name']));

        if ($this->tenantRepository->findBySubdomain($subdomain)) {
            throw ValidationException::withMessages([
                'subdomain' => ['This subdomain is already taken'],
            ]);
        }

        $tenantData = [
            'name' => $data['name'],
            'slug' => str()->slug($data['name']),
            'subdomain' => $subdomain,
            'email' => $data['email'],
            'phone' => $data['phone'] ?? null,
            'address' => $data['address'] ?? null,
            'address_line1' => $data['address_line1'] ?? null,
            'city' => $data['city'] ?? null,
            'state' => $data['state'] ?? null,
            'postal_code' => $data['postal_code'] ?? null,
            'status' => 1,
            // ONBOARDING FIELDS
            'institute_type' => $data['institute_type'] ?? 'school',
            'country' => $data['country'] ?? 'IN',
            'timezone' => $data['timezone'] ?? 'Asia/Kolkata',
            'currency' => $data['currency'] ?? 'INR',
            'website' => $data['website'] ?? null,
            'alternate_contact' => $data['alternate_contact'] ?? null,
            'secondary_contact_name' => $data['secondary_contact_name'] ?? null,
            'board' => $data['board'] ?? null,
            'medium' => $data['medium'] ?? null,
            'established_year' => $data['established_year'] ?? null,
            'tax_id' => $data['tax_id'] ?? null,
            'registration_code' => $data['registration_code'] ?? null,
            'student_count' => $data['student_count'] ?? null,
            'branch_count' => 1,
            'facebook' => $data['facebook'] ?? null,
            'twitter' => $data['twitter'] ?? null,
            'instagram' => $data['instagram'] ?? null,
            'linkedin' => $data['linkedin'] ?? null,
        ];

        $tenant = $this->tenantRepository->create($tenantData);

        $this->tenantService->enableDefaultModules($tenant->id);
        $this->tenantService->enableDefaultFeatures($tenant->id);

        $adminRole = $this->createAdminRole($tenant->id);

        $user = $this->userRepository->create([
            'tenant_id' => $tenant->id,
            'name' => $data['admin_name'],
            'email' => $data['email'],
            'phone' => $data['phone'] ?? null,
            'password' => Hash::make($data['password']),
            'status' => 1,
        ]);

        $user->assignRole($adminRole);

        Log::info('Tenant registered', [
            'tenant_id' => $tenant->id,
            'tenant_name' => $tenant->name,
            'user_id' => $user->id,
            'ip' => request()->ip(),
        ]);

        $token = $user->createToken('auth-token')->plainTextToken;

        return [
            'tenant' => $tenant,
            'user' => $user,
            'token' => $token,
        ];
    }

    public function login(array $credentials): array
    {
        $field = filter_var($credentials['email_or_phone'], FILTER_VALIDATE_EMAIL) ? 'email' : 'phone';
        
        $filters = [
            $field => $credentials['email_or_phone'],
        ];
        
        if (isset($credentials['tenant_id'])) {
            $filters['tenant_id'] = $credentials['tenant_id'];
        }

        \Log::info('Login attempt', ['field' => $field, 'email_or_phone' => $credentials['email_or_phone'], 'filters' => $filters]);

        $user = $this->userRepository->getAll($filters)->first();
        
        \Log::info('User found', ['user' => $user ? $user->email : null, 'user_id' => $user?->id]);

        if (!$user) {
            throw ValidationException::withMessages([
                'email_or_phone' => ['Invalid credentials'],
            ]);
        }

        if (!Hash::check($credentials['password'], $user->password)) {
            throw ValidationException::withMessages([
                'email_or_phone' => ['Invalid credentials'],
            ]);
        }

        if (!$user->isActive()) {
            throw ValidationException::withMessages([
                'email_or_phone' => ['Account is inactive'],
            ]);
        }

        $user->tokens()->delete();

        $token = $user->createToken('auth-token')->plainTextToken;

        $tenant = null;
        $branches = [];
        $selectedBranch = null;

        if ($user->tenant_id) {
            $tenant = Tenant::find($user->tenant_id);
            
            $branches = $this->branchRepository->getAll([
                'tenant_id' => $user->tenant_id,
                'status' => 1,
            ])->map(fn($b) => [
                'id' => $b->id,
                'name' => $b->name,
                'branch_key' => $b->branch_key,
                'logo' => $b->logo,
            ])->toArray();

            if ($user->branch_id) {
                $selectedBranch = $this->branchRepository->findById($user->branch_id);
                if ($selectedBranch) {
                    $selectedBranch = [
                        'id' => $selectedBranch->id,
                        'name' => $selectedBranch->name,
                        'branch_key' => $selectedBranch->branch_key,
                        'logo' => $selectedBranch->logo,
                    ];
                }
            } elseif (count($branches) === 1) {
                $selectedBranch = $branches[0];
            }
        }

        Log::info('User logged in', [
            'user_id' => $user->id,
            'tenant_id' => $user->tenant_id,
            'branch_id' => $user->branch_id,
            'ip' => request()->ip(),
        ]);

        return [
            'user' => $user,
            'tenant' => $tenant,
            'branches' => $branches,
            'selected_branch' => $selectedBranch,
            'token' => $token,
        ];
    }

    public function logout(User $user): void
    {
        $user->tokens()->delete();

        Log::info('User logged out', [
            'user_id' => $user->id,
        ]);
    }

    public function getCurrentUser(int $userId): ?User
    {
        return $this->userRepository->findById($userId);
    }

    private function createAdminRole(int $tenantId): Role
    {
        return $this->roleRepository->create([
            'tenant_id' => $tenantId,
            'name' => 'Super Admin',
            'slug' => 'super_admin',
            'description' => 'Full access to all features',
            'is_default' => 0,
            'status' => 1,
        ]);
    }

    public function forgotPassword(string $email): array
    {
        $user = $this->userRepository->getAll(['email' => $email])->first();

        if (!$user) {
            return [
                'success' => false,
                'message' => 'If the email exists, a reset link will be sent',
            ];
        }

        $resetToken = Str::random(64);
        $hashedToken = hash('sha256', $resetToken);

        $this->userRepository->update($user->id, [
            'reset_token' => $hashedToken,
            'reset_expires' => now()->addHours(24),
        ]);

        $tenant = $user->tenant_id ? $this->tenantRepository->findById($user->tenant_id) : null;

        try {
            $app = app(\App\Services\EmailService::class);
            $app->sendFromTemplate('password_reset', [
                'to' => $user->email,
                'to_name' => $user->name,
                'user_name' => $user->name,
                'reset_url' => config('app.frontend_url') . '/auth/reset-password?token=' . $resetToken . '&email=' . urlencode($user->email),
                'school_name' => $tenant?->name ?? 'PaathshalaOS',
            ], $tenant);
        } catch (\Exception $e) {
            Log::warning('Failed to send password reset email', [
                'user_id' => $user->id,
                'error' => $e->getMessage(),
            ]);
        }

        return [
            'success' => true,
            'message' => 'If the email exists, a reset link will be sent',
        ];
    }

    public function resetPassword(string $email, string $token, string $password): array
    {
        $hashedToken = hash('sha256', $token);

        $user = $this->userRepository->getAll([
            'email' => $email,
            'reset_token' => $hashedToken,
        ])->first();

        if (!$user) {
            throw ValidationException::withMessages([
                'token' => ['Invalid or expired reset token'],
            ]);
        }

        if ($user->reset_expires && now()->greaterThan($user->reset_expires)) {
            throw ValidationException::withMessages([
                'token' => ['Reset token has expired'],
            ]);
        }

        $this->userRepository->update($user->id, [
            'password' => Hash::make($password),
            'reset_token' => null,
            'reset_expires' => null,
        ]);

        Log::info('Password reset successfully', [
            'user_id' => $user->id,
        ]);

        return [
            'success' => true,
            'message' => 'Password reset successfully',
        ];
    }

    public function changePassword(int $userId, string $currentPassword, string $newPassword): array
    {
        $user = $this->userRepository->findById($userId);

        if (!$user) {
            throw ValidationException::withMessages([
                'current_password' => ['User not found'],
            ]);
        }

        if (!Hash::check($currentPassword, $user->password)) {
            throw ValidationException::withMessages([
                'current_password' => ['Current password is incorrect'],
            ]);
        }

        $this->userRepository->update($userId, [
            'password' => Hash::make($newPassword),
        ]);

        Log::info('Password changed successfully', [
            'user_id' => $userId,
        ]);

        return [
            'success' => true,
            'message' => 'Password changed successfully',
        ];
    }
}