<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tenant_domains', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('tenant_id');
            $table->unsignedBigInteger('branch_id')->nullable();
            $table->string('domain')->unique();
            $table->string('type')->default('subdomain');
            $table->unsignedTinyInteger('is_primary')->default(0);
            $table->unsignedTinyInteger('status')->default(1);
            $table->timestamps();

            $table->foreign('tenant_id')->references('id')->on('tenants')->onDelete('cascade');
            $table->foreign('branch_id')->references('id')->on('branches')->onDelete('set null');
            $table->index(['tenant_id', 'domain'], 'tenant_domains_tenant_domain');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tenant_domains');
    }
};