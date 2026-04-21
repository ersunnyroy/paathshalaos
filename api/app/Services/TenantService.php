<?php

namespace App\Services;

use App\Models\Tenant;
use App\Models\Module;
use App\Models\Feature;
use App\Models\User;
use App\Models\Role;
use App\Repositories\Contracts\TenantRepositoryInterface;
use App\Repositories\Contracts\ModuleRepositoryInterface;
use App\Repositories\Contracts\FeatureRepositoryInterface;
use App\Repositories\Contracts\TenantModuleRepositoryInterface;
use App\Repositories\Contracts\TenantFeatureRepositoryInterface;
use App\Repositories\Contracts\RoleRepositoryInterface;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class TenantService
{
    public function __construct(
        private TenantRepositoryInterface $tenantRepository,
        private ModuleRepositoryInterface $moduleRepository,
        private FeatureRepositoryInterface $featureRepository,
        private TenantModuleRepositoryInterface $tenantModuleRepository,
        private TenantFeatureRepositoryInterface $tenantFeatureRepository,
        private RoleRepositoryInterface $roleRepository,
    ) {}

    public function getAll(array $filters = []): \Illuminate\Database\Eloquent\Collection
    {
        return $this->tenantRepository->getAll($filters);
    }

    public function findById(int $id): ?Tenant
    {
        return $this->tenantRepository->findById($id);
    }

    public function findBySubdomain(string $subdomain): ?Tenant
    {
        return $this->tenantRepository->findBySubdomain($subdomain);
    }

    public function create(array $data): Tenant
    {
        return DB::transaction(function () use ($data) {
            $tenant = $this->tenantRepository->create($data);
            $this->createDefaultRolesAndPermissions($tenant);
            $this->createAdminUser($tenant, $data['email']);
            return $tenant;
        });
    }

    private function createAdminUser(Tenant $tenant, string $adminEmail): User
    {
        $randomPassword = Str::random(12);
        $hashedPassword = bcrypt($randomPassword);

        $adminUser = User::create([
            'tenant_id' => $tenant->id,
            'name' => 'Admin',
            'email' => $adminEmail,
            'password' => $hashedPassword,
            'status' => 1,
        ]);

        $adminRole = Role::where('tenant_id', $tenant->id)
            ->where('slug', 'admin')
            ->first();

        if ($adminRole) {
            $adminUser->assignRole($adminRole);
        }

        try {
            EmailService::quickSend(
                'admin_credentials',
                [
                    'school_name'   => $tenant->name,
                    'to'            => $adminEmail,
                    'to_name'       => 'Admin',
                    'email'         => $adminEmail,
                    'password'      => $randomPassword,
                ],
                $tenant,
            );
        } catch (\Exception $e) {
            Log::warning('Failed to send admin credentials email', [
                'tenant_id' => $tenant->id,
                'error'     => $e->getMessage(),
            ]);
        }

        Log::info('Admin user created for new tenant', [
            'tenant_id' => $tenant->id,
            'user_id' => $adminUser->id,
            'email' => $adminEmail,
        ]);

        return $adminUser;
    }

    private function createDefaultRolesAndPermissions(Tenant $tenant): void
    {
        Log::info('Creating roles for tenant', ['tenant_id' => $tenant->id]);
        
        $globalPermissions = DB::table('permissions')
            ->where('is_global', 1)
            ->pluck('id')
            ->toArray();

        $roleData = [
            'admin' => [
                'name' => 'Administrator',
                'description' => 'Full access to all features',
                'permissions' => array_merge($globalPermissions, DB::table('permissions')
                    ->where('is_global', 0)
                    ->pluck('id')
                    ->toArray()),
            ],
            'manager' => [
                'name' => 'Manager',
                'description' => 'Manage specific modules',
                'permissions' => [
                    DB::table('permissions')->where('slug', 'view_dashboard')->first()?->id,
                    DB::table('permissions')->where('slug', 'manage_branches')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_branches')->first()?->id,
                    DB::table('permissions')->where('slug', 'manage_users')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_users')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_admissions')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_academics')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_attendance')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_reports')->first()?->id,
                ],
            ],
            'teacher' => [
                'name' => 'Teacher',
                'description' => 'Teach and manage classes',
                'permissions' => [
                    DB::table('permissions')->where('slug', 'view_dashboard')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_academics')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_attendance')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_examinations')->first()?->id,
                ],
            ],
            'accountant' => [
                'name' => 'Accountant',
                'description' => 'Manage finance and fees',
                'permissions' => [
                    DB::table('permissions')->where('slug', 'view_dashboard')->first()?->id,
                    DB::table('permissions')->where('slug', 'manage_finance')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_finance')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_reports')->first()?->id,
                ],
            ],
            'staff' => [
                'name' => 'Staff',
                'description' => 'Basic staff access',
                'permissions' => [
                    DB::table('permissions')->where('slug', 'view_dashboard')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_admissions')->first()?->id,
                    DB::table('permissions')->where('slug', 'view_attendance')->first()?->id,
                ],
            ],
        ];

        foreach ($roleData as $slug => $data) {
            $role = Role::create([
                'tenant_id' => $tenant->id,
                'name' => $data['name'],
                'slug' => $slug,
                'description' => $data['description'],
                'is_default' => $slug === 'admin' ? 1 : 0,
                'status' => 1,
            ]);

            $permissionIds = array_filter($data['permissions']);
            if (!empty($permissionIds)) {
                $role->permissions()->sync($permissionIds);
            }
        }

        Log::info('Default roles created for new tenant', [
            'tenant_id' => $tenant->id,
            'roles_created' => count($roleData),
        ]);
    }

    private function getAdminCredentialsEmailBody(string $schoolName, string $email, string $password): string
    {
        return <<<HTML
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #0f766e;">Welcome to PaathshalaOS</h2>
            <p>Hello,</p>
            <p>Your admin account for <strong>{$schoolName}</strong> has been created in PaathshalaOS.</p>
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0 0 10px;"><strong>Email:</strong> {$email}</p>
                <p style="margin: 0;"><strong>Temporary Password:</strong> {$password}</p>
            </div>
            <p>Please login and change your password immediately for security reasons.</p>
            <p>Login URL: <a href="#" style="color: #0f766e;">Login</a></p>
            <p style="margin-top: 30px; color: #6b7280; font-size: 12px;">
                This is an automated message. Please do not reply to this email.
            </p>
        </div>
        HTML;
    }

    public function update(int $id, array $data): Tenant
    {
        return $this->tenantRepository->update($id, $data);
    }

    public function delete(int $id): bool
    {
        return $this->tenantRepository->delete($id);
    }

    public function paginate(int $perPage = 15)
    {
        return $this->tenantRepository->paginate($perPage);
    }

    public function enableDefaultModules(int $tenantId): void
    {
        $modules = $this->moduleRepository->getAll(['status' => 1]);
        $moduleIds = [];

        foreach ($modules as $module) {
            $moduleIds[] = $module->id;
        }

        $this->tenantModuleRepository->syncModules($tenantId, $moduleIds);
        Redis::del("tenant:{$tenantId}:modules");
    }

    public function enableDefaultFeatures(int $tenantId): void
    {
        $features = $this->featureRepository->getAll(['status' => 1]);
        $featureIds = [];

        foreach ($features as $feature) {
            $featureIds[] = $feature->id;
        }

        $this->tenantFeatureRepository->syncFeatures($tenantId, $featureIds);
        Redis::del("tenant:{$tenantId}:features");
    }

    public function toggleModule(int $tenantId, int $moduleId, bool $isEnabled): void
    {
        $this->tenantModuleRepository->toggleModule($tenantId, $moduleId, $isEnabled);
        Redis::del("tenant:{$tenantId}:modules");

        Log::info('Module toggled', [
            'tenant_id' => $tenantId,
            'module_id' => $moduleId,
            'is_enabled' => $isEnabled,
        ]);
    }

    public function toggleFeature(int $tenantId, int $featureId, bool $isEnabled): void
    {
        $this->tenantFeatureRepository->toggleFeature($tenantId, $featureId, $isEnabled);
        Redis::del("tenant:{$tenantId}:features");

        Log::info('Feature toggled', [
            'tenant_id' => $tenantId,
            'feature_id' => $featureId,
            'is_enabled' => $isEnabled,
        ]);
    }

    public function isModuleEnabled(int $tenantId, string $moduleSlug): bool
    {
        return $this->tenantModuleRepository->isModuleEnabled($tenantId, $moduleSlug);
    }

    public function isFeatureEnabled(int $tenantId, string $featureSlug): bool
    {
        return $this->tenantFeatureRepository->isFeatureEnabled($tenantId, $featureSlug);
    }

    public function getEnabledModules(int $tenantId): array
    {
        $redisKey = "tenant:{$tenantId}:modules";
        $cached = Redis::get($redisKey);

        if ($cached) {
            return json_decode($cached, true);
        }

        $modules = $this->tenantModuleRepository->getEnabledModules($tenantId);
        Redis::setex($redisKey, 3600, json_encode($modules));

        return $modules;
    }

    public function getEnabledFeatures(int $tenantId): array
    {
        $redisKey = "tenant:{$tenantId}:features";
        $cached = Redis::get($redisKey);

        if ($cached) {
            return json_decode($cached, true);
        }

        $features = $this->tenantFeatureRepository->getEnabledFeatures($tenantId);
        $featuresArray = array_fill_keys($features, true);

        Redis::setex($redisKey, 3600, json_encode($featuresArray));

        return $featuresArray;
    }

    private function getDefaultFeatureStatus(string $featureSlug): bool
    {
        $feature = $this->featureRepository->findBySlug($featureSlug);
        return $feature ? $feature->isDefaultEnabled() : false;
    }
}