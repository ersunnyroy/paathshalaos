<?php

return [
    /*
    |--------------------------------------------------------------------------
    | File Storage Configuration
    |--------------------------------------------------------------------------
    |
    | Configure storage paths for different file types.
    | Use placeholders: {tenant_id}, {branch_id}, {user_id}, {module}, {date}
    |
    */

    'disks' => [
        'local' => [
            'driver' => 'local',
            'root' => storage_path('app'),
        ],

        'minio' => [
            'driver' => 's3',
            'key' => env('MINIO_KEY'),
            'secret' => env('MINIO_SECRET'),
            'region' => env('MINIO_REGION', 'us-east-1'),
            'bucket' => env('MINIO_BUCKET'),
            'endpoint' => env('MINIO_ENDPOINT', 'http://localhost:9000'),
            'use_path_style_endpoint' => true,
        ],

        's3' => [
            'driver' => 's3',
            'key' => env('AWS_ACCESS_KEY_ID'),
            'secret' => env('AWS_SECRET_ACCESS_KEY'),
            'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
            'bucket' => env('AWS_BUCKET'),
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Path Patterns by Module
    |--------------------------------------------------------------------------
    */
    'paths' => [
        'tenant_logo' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/logo',
            'max_size_mb' => 2,
            'allowed_extensions' => ['jpg', 'jpeg', 'png', 'svg', 'webp'],
        ],

        'tenant_favicon' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/favicon',
            'max_size_mb' => 1,
            'allowed_extensions' => ['ico', 'png', 'svg'],
        ],

        'branch_logo' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/branches/{branch_id}/logo',
            'max_size_mb' => 2,
            'allowed_extensions' => ['jpg', 'jpeg', 'png', 'svg'],
        ],

        'user_avatar' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/users/{user_id}/avatar',
            'max_size_mb' => 5,
            'allowed_extensions' => ['jpg', 'jpeg', 'png', 'webp'],
        ],

        'student_photo' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/students/{student_id}/photo',
            'max_size_mb' => 5,
            'allowed_extensions' => ['jpg', 'jpeg', 'png'],
        ],

        'document' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/documents/{module}',
            'max_size_mb' => 50,
            'allowed_extensions' => ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'png'],
        ],

        'admission_document' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/admissions/{application_id}',
            'max_size_mb' => 20,
            'allowed_extensions' => ['pdf', 'jpg', 'jpeg', 'png'],
        ],

        'exam_paper' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/exams/{exam_id}',
            'max_size_mb' => 10,
            'allowed_extensions' => ['pdf'],
        ],

        'library_book_cover' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/library/{book_id}/cover',
            'max_size_mb' => 5,
            'allowed_extensions' => ['jpg', 'jpeg', 'png', 'webp'],
        ],

        'fee_receipt' => [
            'disk' => 'local',
            'path' => 'tenants/{tenant_id}/receipts/{receipt_id}',
            'max_size_mb' => 5,
            'allowed_extensions' => ['pdf'],
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Default Storage Driver
    |--------------------------------------------------------------------------
    */
    'default_driver' => env('FILE_STORAGE_DRIVER', 'local'),

    /*
    |--------------------------------------------------------------------------
    | CDN Configuration (for production)
    |--------------------------------------------------------------------------
    */
    'cdn' => [
        'enabled' => env('CDN_ENABLED', false),
        'url' => env('CDN_URL'),
    ],
];