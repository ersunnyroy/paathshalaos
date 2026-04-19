<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class FileConfigSeeder extends Seeder
{
    public function run(): void
    {
        $localConfigId = DB::table('file_configs')->insertGetId([
            'name' => 'Local Storage',
            'key' => 'local',
            'driver' => 'local',
            'base_path' => 'storage/app',
            'is_default' => 1,
            'is_active' => 1,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        DB::table('file_configs')->insertGetId([
            'name' => 'MinIO (Local Dev)',
            'key' => 'minio',
            'driver' => 's3',
            'base_path' => 'paathshala-os',
            'bucket' => 'paathshala-os',
            'region' => 'us-east-1',
            'endpoint' => 'http://localhost:9000',
            'is_default' => 0,
            'is_active' => 1,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        DB::table('file_configs')->insertGetId([
            'name' => 'AWS S3 (Production)',
            'key' => 's3',
            'driver' => 's3',
            'base_path' => 'paathshala-os',
            'bucket' => '',
            'region' => 'us-east-1',
            'is_default' => 0,
            'is_active' => 1,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $pathConfigs = [
            ['tenant_logo', 'logos', '{tenant_id}/logo', 2, ['jpg', 'jpeg', 'png', 'svg', 'webp']],
            ['tenant_favicon', 'favicon', '{tenant_id}/favicon', 1, ['ico', 'png', 'svg']],
            ['branch_logo', 'logos', '{tenant_id}/branches/{branch_id}/logo', 2, ['jpg', 'jpeg', 'png', 'svg']],
            ['user_avatar', 'avatars', '{tenant_id}/users/{user_id}/avatar', 5, ['jpg', 'jpeg', 'png', 'webp']],
            ['student_photo', 'photos', '{tenant_id}/students/{student_id}/photo', 5, ['jpg', 'jpeg', 'png']],
            ['document_upload', 'documents', '{tenant_id}/documents/{module}/{document_id}', 50, ['pdf', 'doc', 'docx', 'xls', 'xlsx']],
            ['admission_document', 'admissions', '{tenant_id}/admissions/{application_id}', 20, ['pdf', 'jpg', 'jpeg', 'png']],
            ['exam_paper', 'exams', '{tenant_id}/exams/{exam_id}', 10, ['pdf']],
            ['library_book_cover', 'library', '{tenant_id}/books/{book_id}/cover', 5, ['jpg', 'jpeg', 'png', 'webp']],
            ['fee_receipt', 'finance', '{tenant_id}/receipts/{receipt_id}', 5, ['pdf']],
        ];

        foreach ($pathConfigs as [$module, $pathPattern, $maxSize, $extensions]) {
            DB::table('file_path_configs')->insertGetId([
                'file_config_id' => $localConfigId,
                'module' => $module,
                'path_pattern' => $pathPattern,
                'max_size_mb' => $maxSize,
                'allowed_extensions' => json_encode($extensions),
                'is_active' => 1,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        $this->command->info('File configs seeded successfully!');
    }
}