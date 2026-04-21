<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('roles', function ($table) {
            // Drop the global slug-only unique — slugs like 'admin' must be unique
            // per tenant, not globally. The composite (tenant_id, slug) unique handles this.
            $slugOnly = DB::select("SHOW INDEX FROM roles WHERE Key_name = 'roles_slug_unique'");
            if (!empty($slugOnly)) {
                $table->dropUnique('roles_slug_unique');
            }

            // Clean up duplicate composite index left from earlier migrations.
            $dupe = DB::select("SHOW INDEX FROM roles WHERE Key_name = 'roles_tenant_slug_unique'");
            if (!empty($dupe)) {
                $table->dropUnique('roles_tenant_slug_unique');
            }
        });
    }

    public function down(): void
    {
        Schema::table('roles', function ($table) {
            $table->unique('slug', 'roles_slug_unique');
        });
    }
};
