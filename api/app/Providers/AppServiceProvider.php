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
use App\Repositories\Contracts\PlanRepositoryInterface;
use App\Repositories\Contracts\TenantPlanRepositoryInterface;
use App\Repositories\Contracts\TenantModuleRepositoryInterface;
use App\Repositories\Contracts\TenantFeatureRepositoryInterface;
use App\Repositories\Contracts\EmailTemplateRepositoryInterface;
use App\Repositories\Contracts\SmtpSettingsRepositoryInterface;
use App\Repositories\Eloquent\TenantRepository;
use App\Repositories\Eloquent\BranchRepository;
use App\Repositories\Eloquent\UserRepository;
use App\Repositories\Eloquent\RoleRepository;
use App\Repositories\Eloquent\PermissionRepository;
use App\Repositories\Eloquent\ModuleRepository;
use App\Repositories\Eloquent\FeatureRepository;
use App\Repositories\Eloquent\PlanRepository;
use App\Repositories\Eloquent\TenantPlanRepository;
use App\Repositories\Eloquent\TenantModuleRepository;
use App\Repositories\Eloquent\TenantFeatureRepository;
use App\Repositories\Eloquent\EmailTemplateRepository;
use App\Repositories\Eloquent\SmtpSettingsRepository;
use App\Services\TenantService;
use App\Services\BranchService;
use App\Services\RoleService;
use App\Services\PermissionService;
use App\Services\ModuleService;
use App\Services\FeatureService;
use App\Services\AuthService;
use App\Services\TenantDomainService;
use App\Services\PlanService;
use App\Services\EmailService;

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
        $this->app->singleton(PlanRepositoryInterface::class, PlanRepository::class);
        $this->app->singleton(TenantPlanRepositoryInterface::class, TenantPlanRepository::class);
        $this->app->singleton(TenantModuleRepositoryInterface::class, TenantModuleRepository::class);
        $this->app->singleton(TenantFeatureRepositoryInterface::class, TenantFeatureRepository::class);
        $this->app->singleton(EmailTemplateRepositoryInterface::class, EmailTemplateRepository::class);
        $this->app->singleton(SmtpSettingsRepositoryInterface::class, SmtpSettingsRepository::class);
    }

    protected function registerServices(): void
    {
        $this->app->singleton(TenantService::class, function ($app) {
            return new TenantService(
                $app->make(TenantRepositoryInterface::class),
                $app->make(ModuleRepositoryInterface::class),
                $app->make(FeatureRepositoryInterface::class),
                $app->make(TenantModuleRepositoryInterface::class),
                $app->make(TenantFeatureRepositoryInterface::class),
                $app->make(RoleRepositoryInterface::class)
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
                $app->make(BranchRepositoryInterface::class),
                $app->make(TenantService::class)
            );
        });

        $this->app->singleton(TenantDomainService::class, function ($app) {
            return new TenantDomainService(
                $app->make(TenantRepositoryInterface::class)
            );
        });

        $this->app->singleton(PlanService::class, function ($app) {
            return new PlanService(
                $app->make(PlanRepositoryInterface::class),
                $app->make(TenantPlanRepositoryInterface::class),
                $app->make(UserRepositoryInterface::class),
                $app->make(BranchRepositoryInterface::class)
            );
        });

        $this->app->singleton(EmailService::class, function ($app) {
            return new EmailService(
                $app->make(SmtpSettingsRepositoryInterface::class)
            );
        });
    }
}