<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        \DB::statement('SET FOREIGN_KEY_CHECKS=0');

        $this->command->info('Seeding default data...');

        $this->seedSuperAdmin();
        $this->seedModules();
        $this->seedFeatures();
        $this->seedPermissions();

        $this->command->info('Default data seeded successfully!');

        \DB::statement('SET FOREIGN_KEY_CHECKS=1');
    }

    protected function seedSuperAdmin(): void
    {
        $tenant = \App\Models\Tenant::updateOrInsert(
            ['subdomain' => 'paathshala'],
            [
                'name' => 'Paathshala Demo',
                'slug' => 'paathshala',
                'subdomain' => 'paathshala',
                'email' => 'admin@paathshala.com',
                'status' => 1,
                'institute_type' => 'school',
                'created_at' => now(),
                'updated_at' => now(),
            ]
        );
        
        $tenant = \App\Models\Tenant::where('subdomain', 'paathshala')->first();
        
        $existingUser = \App\Models\User::where('email', 'admin@paathshala.com')->first();
        
        if (!$existingUser && $tenant) {
            \App\Models\User::create([
                'name' => 'Super Admin',
                'email' => 'admin@paathshala.com',
                'password' => bcrypt('password'),
                'tenant_id' => $tenant->id,
                'status' => 1,
            ]);
            $this->command->info('Created default tenant and user: admin@paathshala.com / password');
        }
    }

    protected function seedModules(): void
    {
        $modules = [
            ['name' => 'Admissions', 'slug' => 'admissions', 'description' => 'Student admissions and enrollment', 'icon' => 'pi-users', 'sort_order' => 1, 'is_core' => 1, 'status' => 1],
            ['name' => 'Academics', 'slug' => 'academics', 'description' => 'Academic management and courses', 'icon' => 'pi-book', 'sort_order' => 2, 'is_core' => 1, 'status' => 1],
            ['name' => 'Attendance', 'slug' => 'attendance', 'description' => 'Student and staff attendance', 'icon' => 'pi-calendar', 'sort_order' => 3, 'is_core' => 1, 'status' => 1],
            ['name' => 'Examinations', 'slug' => 'examinations', 'description' => 'Exams and assessments', 'icon' => 'pi-file', 'sort_order' => 4, 'is_core' => 1, 'status' => 1],
            ['name' => 'Library', 'slug' => 'library', 'description' => 'Library management', 'icon' => 'pi-bookmark', 'sort_order' => 5, 'is_core' => 0, 'status' => 1],
            ['name' => 'Finance', 'slug' => 'finance', 'description' => 'Fee management and accounts', 'icon' => 'pi-wallet', 'sort_order' => 6, 'is_core' => 1, 'status' => 1],
            ['name' => 'HR', 'slug' => 'hr', 'description' => 'Human resources management', 'icon' => 'pi-id-card', 'sort_order' => 7, 'is_core' => 0, 'status' => 1],
            ['name' => 'Reports', 'slug' => 'reports', 'description' => 'Reports and analytics', 'icon' => 'pi-chart-bar', 'sort_order' => 8, 'is_core' => 0, 'status' => 1],
            ['name' => 'Settings', 'slug' => 'settings', 'description' => 'System settings', 'icon' => 'pi-cog', 'sort_order' => 9, 'is_core' => 1, 'status' => 1],
        ];

        foreach ($modules as $module) {
            DB::table('modules')->updateOrInsert(
                ['slug' => $module['slug']],
                array_merge($module, ['created_at' => now(), 'updated_at' => now()])
            );
        }
    }

    protected function seedFeatures(): void
    {
        $features = [
            ['module' => 'admissions', 'name' => 'Online Registration', 'slug' => 'online_registration', 'description' => 'Allow online student registration', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'admissions', 'name' => 'Document Upload', 'slug' => 'document_upload', 'description' => 'Upload required documents', 'sort_order' => 2, 'is_default_enabled' => 1],
            ['module' => 'admissions', 'name' => 'Application Review', 'slug' => 'application_review', 'description' => 'Review admissions applications', 'sort_order' => 3, 'is_default_enabled' => 1],
            ['module' => 'academics', 'name' => 'Class Management', 'slug' => 'class_management', 'description' => 'Manage classes and sections', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'academics', 'name' => 'Subject Management', 'slug' => 'subject_management', 'description' => 'Manage subjects', 'sort_order' => 2, 'is_default_enabled' => 1],
            ['module' => 'academics', 'name' => 'Timetable', 'slug' => 'timetable', 'description' => 'Class timetable', 'sort_order' => 3, 'is_default_enabled' => 1],
            ['module' => 'attendance', 'name' => 'Daily Attendance', 'slug' => 'daily_attendance', 'description' => 'Mark daily attendance', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'attendance', 'name' => 'Attendance Reports', 'slug' => 'attendance_reports', 'description' => 'Attendance reports', 'sort_order' => 2, 'is_default_enabled' => 0],
            ['module' => 'examinations', 'name' => 'Exam Schedule', 'slug' => 'exam_schedule', 'description' => 'Schedule examinations', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'examinations', 'name' => 'Grade Book', 'slug' => 'grade_book', 'description' => 'Record grades', 'sort_order' => 2, 'is_default_enabled' => 1],
            ['module' => 'examinations', 'name' => 'Result Cards', 'slug' => 'result_cards', 'description' => 'Generate result cards', 'sort_order' => 3, 'is_default_enabled' => 1],
            ['module' => 'library', 'name' => 'Book Catalog', 'slug' => 'book_catalog', 'description' => 'Library book catalog', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'library', 'name' => 'Issue/Return', 'slug' => 'issue_return', 'description' => 'Issue and return books', 'sort_order' => 2, 'is_default_enabled' => 1],
            ['module' => 'finance', 'name' => 'Fee Collection', 'slug' => 'fee_collection', 'description' => 'Collect fees', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'finance', 'name' => 'Invoice Generation', 'slug' => 'invoice_generation', 'description' => 'Generate invoices', 'sort_order' => 2, 'is_default_enabled' => 1],
            ['module' => 'finance', 'name' => 'Payment Gateway', 'slug' => 'payment_gateway', 'description' => 'Online payment integration', 'sort_order' => 3, 'is_default_enabled' => 0],
            ['module' => 'hr', 'name' => 'Employee Management', 'slug' => 'employee_management', 'description' => 'Manage employees', 'sort_order' => 1, 'is_default_enabled' => 1],
            ['module' => 'hr', 'name' => 'Payroll', 'slug' => 'payroll', 'description' => 'Manage payroll', 'sort_order' => 2, 'is_default_enabled' => 0],
            ['module' => 'reports', 'name' => ' Analytics Dashboard', 'slug' => 'analytics_dashboard', 'description' => 'View analytics', 'sort_order' => 1, 'is_default_enabled' => 0],
            ['module' => 'settings', 'name' => 'Tenant Settings', 'slug' => 'tenant_settings', 'description' => 'Tenant configuration', 'sort_order' => 1, 'is_default_enabled' => 1],
        ];

        foreach ($features as $feature) {
            $module = DB::table('modules')->where('slug', $feature['module'])->first();

            if ($module) {
                DB::table('features')->updateOrInsert(
                    ['slug' => $feature['slug']],
                    [
                        'module_id' => $module->id,
                        'name' => $feature['name'],
                        'slug' => $feature['slug'],
                        'description' => $feature['description'],
                        'sort_order' => $feature['sort_order'],
                        'is_default_enabled' => $feature['is_default_enabled'],
                        'status' => 1,
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]
                );
            }
        }
    }

    protected function seedPermissions(): void
    {
        $permissions = [
            ['name' => 'View Dashboard', 'slug' => 'view_dashboard', 'module' => 'dashboard', 'is_global' => 1],
            ['name' => 'Manage Branches', 'slug' => 'manage_branches', 'module' => 'branches', 'is_global' => 0],
            ['name' => 'View Branches', 'slug' => 'view_branches', 'module' => 'branches', 'is_global' => 0],
            ['name' => 'Manage Roles', 'slug' => 'manage_roles', 'module' => 'rbac', 'is_global' => 0],
            ['name' => 'View Roles', 'slug' => 'view_roles', 'module' => 'rbac', 'is_global' => 0],
            ['name' => 'Manage Permissions', 'slug' => 'manage_permissions', 'module' => 'rbac', 'is_global' => 0],
            ['name' => 'Manage Users', 'slug' => 'manage_users', 'module' => 'users', 'is_global' => 0],
            ['name' => 'View Users', 'slug' => 'view_users', 'module' => 'users', 'is_global' => 0],
            ['name' => 'Manage Admissions', 'slug' => 'manage_admissions', 'module' => 'admissions', 'is_global' => 0],
            ['name' => 'View Admissions', 'slug' => 'view_admissions', 'module' => 'admissions', 'is_global' => 0],
            ['name' => 'Manage Academics', 'slug' => 'manage_academics', 'module' => 'academics', 'is_global' => 0],
            ['name' => 'View Academics', 'slug' => 'view_academics', 'module' => 'academics', 'is_global' => 0],
            ['name' => 'Manage Attendance', 'slug' => 'manage_attendance', 'module' => 'attendance', 'is_global' => 0],
            ['name' => 'View Attendance', 'slug' => 'view_attendance', 'module' => 'attendance', 'is_global' => 0],
            ['name' => 'Manage Examinations', 'slug' => 'manage_examinations', 'module' => 'examinations', 'is_global' => 0],
            ['name' => 'View Examinations', 'slug' => 'view_examinations', 'module' => 'examinations', 'is_global' => 0],
            ['name' => 'Manage Library', 'slug' => 'manage_library', 'module' => 'library', 'is_global' => 0],
            ['name' => 'View Library', 'slug' => 'view_library', 'module' => 'library', 'is_global' => 0],
            ['name' => 'Manage Finance', 'slug' => 'manage_finance', 'module' => 'finance', 'is_global' => 0],
            ['name' => 'View Finance', 'slug' => 'view_finance', 'module' => 'finance', 'is_global' => 0],
            ['name' => 'Manage HR', 'slug' => 'manage_hr', 'module' => 'hr', 'is_global' => 0],
            ['name' => 'View HR', 'slug' => 'view_hr', 'module' => 'hr', 'is_global' => 0],
            ['name' => 'Manage Reports', 'slug' => 'manage_reports', 'module' => 'reports', 'is_global' => 0],
            ['name' => 'View Reports', 'slug' => 'view_reports', 'module' => 'reports', 'is_global' => 0],
            ['name' => 'Manage Settings', 'slug' => 'manage_settings', 'module' => 'settings', 'is_global' => 0],
            ['name' => 'View Settings', 'slug' => 'view_settings', 'module' => 'settings', 'is_global' => 0],
        ];

        foreach ($permissions as $permission) {
            DB::table('permissions')->updateOrInsert(
                ['slug' => $permission['slug']],
                [
                    'name' => $permission['name'],
                    'slug' => $permission['slug'],
                    'description' => $permission['name'],
                    'module' => $permission['module'],
                    'is_global' => $permission['is_global'],
                    'status' => 1,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );
        }
    }
}