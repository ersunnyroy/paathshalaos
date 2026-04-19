<?php

namespace App\Services;

use App\Models\Role;
use App\Models\Permission;
use App\Models\User;
use App\Repositories\Contracts\RoleRepositoryInterface;
use App\Repositories\Contracts\PermissionRepositoryInterface;
use App\Repositories\Contracts\UserRepositoryInterface;
use Illuminate\Support\Facades\Log;

class RoleService
{
    public function __construct(
        private RoleRepositoryInterface $roleRepository,
        private PermissionRepositoryInterface $permissionRepository,
        private UserRepositoryInterface $userRepository,
    ) {}

    public function getAllRoles(array $filters = [])
    {
        return $this->roleRepository->getAll($filters);
    }

    public function findRoleById(int $id): ?Role
    {
        return $this->roleRepository->findById($id);
    }

    public function createRole(array $data): Role
    {
        $data['slug'] = str()->slug($data['name']);
        return $this->roleRepository->create($data);
    }

    public function updateRole(int $id, array $data): Role
    {
        if (isset($data['name'])) {
            $data['slug'] = str()->slug($data['name']);
        }
        return $this->roleRepository->update($id, $data);
    }

    public function deleteRole(int $id): bool
    {
        return $this->roleRepository->delete($id);
    }

    public function getRolesByTenantId(int $tenantId)
    {
        return $this->roleRepository->getByTenantId($tenantId);
    }

    public function assignPermissionsToRole(int $roleId, array $permissionIds): Role
    {
        $role = $this->roleRepository->findById($roleId);
        $role->syncPermissions($permissionIds);

        Redis::del("role:{$roleId}:permissions");

        Log::info('Permissions assigned to role', [
            'role_id' => $roleId,
            'permission_count' => count($permissionIds),
        ]);

        return $role;
    }

    public function removePermissionFromRole(int $roleId, int $permissionId): void
    {
        $permission = $this->permissionRepository->findById($permissionId);
        $role = $this->roleRepository->findById($roleId);
        $role->removePermission($permission);

        Redis::del("role:{$roleId}:permissions");
    }

    public function getRolePermissions(int $roleId)
    {
        $role = $this->roleRepository->findById($roleId);
        return $role?->permissions;
    }

    public function assignRoleToUser(int $userId, int $roleId): User
    {
        $user = $this->userRepository->findById($userId);
        $role = $this->roleRepository->findById($roleId);

        if ($user && $role) {
            $user->assignRole($role);

            Redis::del("user:{$userId}:permissions");

            Log::info('Role assigned to user', [
                'user_id' => $userId,
                'role_id' => $roleId,
            ]);
        }

        return $user;
    }

    public function removeRoleFromUser(int $userId, int $roleId): User
    {
        $user = $this->userRepository->findById($userId);
        $role = $this->roleRepository->findById($roleId);

        if ($user && $role) {
            $user->removeRole($role);

            Redis::del("user:{$userId}:permissions");
        }

        return $user;
    }

    public function getUserRoles(int $userId)
    {
        $user = $this->userRepository->findById($userId);
        return $user?->roles;
    }

    public function userHasPermission(int $userId, string $permissionSlug): bool
    {
        $cacheKey = "user:{$userId}:permissions";
        $cached = Redis::get($cacheKey);

        if ($cached) {
            return in_array($permissionSlug, json_decode($cached, true));
        }

        $user = $this->userRepository->findById($userId);

        if (!$user) {
            return false;
        }

        $permissions = [];
        foreach ($user->roles as $role) {
            foreach ($role->permissions as $permission) {
                $permissions[] = $permission->slug;
            }
        }

        $globalPermissions = $this->permissionRepository->getGlobalPermissions();
        foreach ($globalPermissions as $perm) {
            $permissions[] = $perm->slug;
        }

        $permissions = array_unique($permissions);
        Redis::setex($cacheKey, 3600, json_encode($permissions));

        return in_array($permissionSlug, $permissions);
    }

    public function getUserPermissions(int $userId): array
    {
        $cacheKey = "user:{$userId}:permissions";
        $cached = Redis::get($cacheKey);

        if ($cached) {
            return json_decode($cached, true);
        }

        $user = $this->userRepository->findById($userId);

        if (!$user) {
            return [];
        }

        $permissions = [];
        foreach ($user->roles as $role) {
            foreach ($role->permissions as $permission) {
                $permissions[] = $permission->slug;
            }
        }

        $globalPermissions = $this->permissionRepository->getGlobalPermissions();
        foreach ($globalPermissions as $perm) {
            $permissions[] = $perm->slug;
        }

        $permissions = array_unique($permissions);
        Redis::setex($cacheKey, 3600, json_encode($permissions));

        return $permissions;
    }
}