<?php

namespace App\Services;

use App\Models\Tenant;
use App\Models\User;
use App\Models\Role;
use App\Repositories\Contracts\TenantRepositoryInterface;
use App\Repositories\Contracts\UserRepositoryInterface;
use App\Repositories\Contracts\RoleRepositoryInterface;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class AuthService
{
    public function __construct(
        private TenantRepositoryInterface $tenantRepository,
        private UserRepositoryInterface $userRepository,
        private RoleRepositoryInterface $roleRepository,
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

        $user = $this->userRepository->getAll($filters)->first();

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

        Log::info('User logged in', [
            'user_id' => $user->id,
            'tenant_id' => $user->tenant_id,
            'ip' => request()->ip(),
        ]);

        return [
            'user' => $user,
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
}