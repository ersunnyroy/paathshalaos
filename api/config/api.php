<?php

return [
    'auth' => [
        'login' => '/api/auth/login',
        'logout' => '/api/auth/logout',
        'register' => '/api/auth/register',
        'me' => '/api/auth/me',
        'refresh' => '/api/auth/refresh',
        'tenant' => '/api/auth/tenant',
    ],

    'branches' => [
        'list' => '/api/branches',
        'create' => '/api/branches',
        'show' => '/api/branches/{id}',
        'update' => '/api/branches/{id}',
        'delete' => '/api/branches/{id}',
    ],

    'users' => [
        'list' => '/api/users',
        'create' => '/api/users',
        'show' => '/api/users/{id}',
        'update' => '/api/users/{id}',
        'delete' => '/api/users/{id}',
    ],

    'roles' => [
        'list' => '/api/roles',
        'create' => '/api/roles',
        'show' => '/api/roles/{id}',
        'update' => '/api/roles/{id}',
        'delete' => '/api/roles/{id}',
        'permissions' => '/api/roles/{id}/permissions',
    ],

    'tenants' => [
        'list' => '/api/tenants',
        'create' => '/api/tenants',
        'show' => '/api/tenants/{id}',
        'update' => '/api/tenants/{id}',
        'delete' => '/api/tenants/{id}',
        'stats' => '/api/tenants/stats',
        'checkSubdomain' => '/api/tenants/check-subdomain',
        'uploadLogo' => '/api/tenants/{id}/logo',
        'uploadFavicon' => '/api/tenants/{id}/favicon',
    ],

    'modules' => [
        'list' => '/api/modules',
        'tenantModules' => '/api/tenant/modules',
    ],

    'features' => [
        'list' => '/api/features',
        'tenantFeatures' => '/api/tenant/features',
        'check' => '/api/check-feature',
    ],

    'references' => [
        'countries' => '/api/references/countries',
        'states' => '/api/references/states',
        'instituteTypes' => '/api/references/institute-types',
        'boards' => '/api/references/boards',
        'mediums' => '/api/references/mediums',
    ],

    'plans' => [
        'list' => '/api/plans',
        'show' => '/api/plans/{id}',
    ],

    'files' => [
        'uploadLogo' => '/api/tenants/{id}/logo',
        'uploadFavicon' => '/api/tenants/{id}/favicon',
    ],
];