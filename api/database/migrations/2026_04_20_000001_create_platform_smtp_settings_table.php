<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('smtp_settings', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('tenant_id')->nullable()->unique();
            $table->unsignedTinyInteger('is_platform')->default(0);
            $table->string('host')->nullable();
            $table->string('port')->nullable();
            $table->string('username')->nullable();
            $table->string('password')->nullable();
            $table->string('encryption')->nullable()->default('tls');
            $table->string('from_email')->nullable();
            $table->string('from_name')->nullable();
            $table->timestamps();

            $table->foreign('tenant_id')->references('id')->on('tenants')->onDelete('cascade');

            $table->unique(['tenant_id', 'is_platform']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('smtp_settings');
    }
};