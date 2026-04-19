<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Models\Role;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Hash;

class CreateSuperAdmin extends Command
{
    protected $signature = 'superadmin:create {name} {email} {password}';
    protected $description = 'Create a global super admin user';

    public function handle()
    {
        $name = $this->argument('name');
        $email = $this->argument('email');
        $password = $this->argument('password');

        $user = User::create([
            'tenant_id' => null,
            'name' => $name,
            'email' => $email,
            'password' => Hash::make($password),
            'status' => 1,
        ]);

        $role = Role::create([
            'tenant_id' => null,
            'name' => 'Global Super Admin',
            'slug' => 'global_super_admin',
            'description' => 'System-wide super admin',
            'is_default' => 0,
            'status' => 1,
        ]);

        $user->roles()->attach($role->id, ['assigned_by' => null]);

        $this->info("Super admin created successfully!");
        $this->info("Email: $email");
        $this->info("Token: " . $user->createToken('superadmin')->plainTextToken);
    }
}