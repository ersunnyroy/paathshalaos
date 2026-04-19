<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('roles', function ($table) {
            $table->unique(['tenant_id', 'slug'], 'roles_tenant_slug_composite_unique');
        });
    }

    public function down(): void
    {
        Schema::table('roles', function ($table) {
            $table->dropUnique('roles_tenant_slug_composite_unique');
        });
    }
};