<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $table->string('tenant_key')->nullable()->unique()->after('id');
            $table->string('favicon')->nullable()->after('logo');
            $table->string('logo_dark')->nullable()->after('logo');
            $table->string('primary_color')->nullable()->change();
        });

        Schema::table('branches', function (Blueprint $table) {
            $table->string('branch_key')->nullable()->unique()->after('id');
            $table->string('logo')->nullable()->after('name');
            $table->string('favicon')->nullable()->after('logo');
        });

        Schema::table('users', function (Blueprint $table) {
            $table->unsignedBigInteger('branch_id')->nullable()->change();
        });
    }

    public function down(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $table->dropColumn(['tenant_key', 'favicon', 'logo_dark']);
        });

        Schema::table('branches', function (Blueprint $table) {
            $table->dropColumn(['branch_key', 'logo', 'favicon']);
        });
    }
};