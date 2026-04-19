<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\BranchController;
use App\Http\Controllers\Api\RoleController;
use App\Http\Controllers\Api\PermissionController;
use App\Http\Controllers\Api\ModuleController;
use App\Http\Controllers\Api\FeatureController;
use App\Http\Controllers\Api\ReferenceController;
use App\Http\Controllers\Api\TenantController;
use App\Http\Controllers\Api\UserController;

Route::prefix('references')->group(function () {
    Route::get('/countries', [ReferenceController::class, 'countries']);
    Route::get('/states', [ReferenceController::class, 'states']);
    Route::get('/institute-types', [ReferenceController::class, 'instituteTypes']);
    Route::get('/boards', [ReferenceController::class, 'boards']);
    Route::get('/mediums', [ReferenceController::class, 'mediums']);
});

Route::prefix('auth')->group(function () {
    Route::post('/login', [AuthController::class, 'login']);
    Route::get('/tenant', [AuthController::class, 'tenant']);

    Route::middleware('auth:sanctum')->group(function () {
        Route::get('/me', [AuthController::class, 'me']);
        Route::post('/logout', [AuthController::class, 'logout']);
        Route::post('/refresh', [AuthController::class, 'refresh']);
    });
});

Route::get('/tenants/check-subdomain', [TenantController::class, 'checkSubdomain']);
Route::get('/tenants/check-domain', [TenantController::class, 'checkDomain']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/tenants/stats', [TenantController::class, 'stats']);
    Route::post('/tenants/{id}/toggle-status', [TenantController::class, 'toggleStatus']);
    Route::apiResource('tenants', TenantController::class);

    Route::apiResource('users', UserController::class);

    Route::apiResource('branches', BranchController::class);

    Route::apiResource('roles', RoleController::class);
    Route::post('/roles/{id}/permissions', [RoleController::class, 'assignPermissions']);
    Route::post('/users/assign-role', [RoleController::class, 'assignRoleToUser']);
    Route::post('/users/remove-role', [RoleController::class, 'removeRoleFromUser']);

    Route::apiResource('permissions', PermissionController::class);

    Route::apiResource('modules', ModuleController::class);
    Route::post('/modules/{id}/toggle', [ModuleController::class, 'toggle']);
    Route::get('/tenant/modules', [ModuleController::class, 'tenantModules']);

    Route::apiResource('features', FeatureController::class);
    Route::post('/features/{id}/toggle', [FeatureController::class, 'toggle']);
    Route::get('/tenant/features', [FeatureController::class, 'tenantFeatures']);
    Route::get('/check-feature', [FeatureController::class, 'checkFeature']);
});