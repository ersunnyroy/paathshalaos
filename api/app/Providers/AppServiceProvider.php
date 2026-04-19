<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use App\Repositories\Contracts\TenantRepositoryInterface;
use App\Repositories\Contracts\BranchRepositoryInterface;
use App\Repositories\Contracts\UserRepositoryInterface;
use App\Repositories\Contracts\RoleRepositoryInterface;
use App\Repositories\Contracts\PermissionRepositoryInterface;
use App\Repositories\Contracts\ModuleRepositoryInterface;
use App\Repositories\Contracts\FeatureRepositoryInterface;
use App\Repositories\Eloquent\TenantRepository;
use App\Repositories\Eloquent\BranchRepository;
use App\Repositories\Eloquent\UserRepository;
use App\Repositories\Eloquent\RoleRepository;
use App\Repositories\Eloquent\PermissionRepository;
use App\Repositories\Eloquent\ModuleRepository;
use App\Repositories\Eloquent\FeatureRepository;
use App\Services\TenantService;
use App\Services\BranchService;
use App\Services\RoleService;
use App\Services\PermissionService;
use App\Services\ModuleService;
use App\Services\FeatureService;
use App\Services\AuthService;
use App\Services\TenantDomainService;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->registerRepositories();
        $this->registerServices();
    }

    public function boot(): void
    {
        //
    }

    protected function registerRepositories(): void
    {
        $this->app->singleton(TenantRepositoryInterface::class, TenantRepository::class);
        $this->app->singleton(BranchRepositoryInterface::class, BranchRepository::class);
        $this->app->singleton(UserRepositoryInterface::class, UserRepository::class);
        $this->app->singleton(RoleRepositoryInterface::class, RoleRepository::class);
        $this->app->singleton(PermissionRepositoryInterface::class, PermissionRepository::class);
        $this->app->singleton(ModuleRepositoryInterface::class, ModuleRepository::class);
        $this->app->singleton(FeatureRepositoryInterface::class, FeatureRepository::class);
    }

    protected function registerServices(): void
    {
        $this->app->singleton(TenantService::class, function ($app) {
            return new TenantService(
                $app->make(TenantRepositoryInterface::class),
                $app->make(ModuleRepositoryInterface::class),
                $app->make(FeatureRepositoryInterface::class)
            );
        });

        $this->app->singleton(BranchService::class, function ($app) {
            return new BranchService(
                $app->make(BranchRepositoryInterface::class)
            );
        });

        $this->app->singleton(RoleService::class, function ($app) {
            return new RoleService(
                $app->make(RoleRepositoryInterface::class),
                $app->make(PermissionRepositoryInterface::class),
                $app->make(UserRepositoryInterface::class)
            );
        });

        $this->app->singleton(PermissionService::class, function ($app) {
            return new PermissionService(
                $app->make(PermissionRepositoryInterface::class)
            );
        });

        $this->app->singleton(ModuleService::class, function ($app) {
            return new ModuleService(
                $app->make(ModuleRepositoryInterface::class)
            );
        });

        $this->app->singleton(FeatureService::class, function ($app) {
            return new FeatureService(
                $app->make(FeatureRepositoryInterface::class)
            );
        });

        $this->app->singleton(AuthService::class, function ($app) {
            return new AuthService(
                $app->make(TenantRepositoryInterface::class),
                $app->make(UserRepositoryInterface::class),
                $app->make(RoleRepositoryInterface::class),
                $app->make(TenantService::class)
            );
        });

        $this->app->singleton(TenantDomainService::class, function ($app) {
            return new TenantDomainService(
                $app->make(TenantRepositoryInterface::class)
            );
        });
    }
}