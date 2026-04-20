<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('plans', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug')->unique();
            $table->text('description')->nullable();
            $table->decimal('price', 10, 2)->default(0);
            $table->integer('max_students')->default(0);
            $table->integer('max_teachers')->default(0);
            $table->integer('max_branches')->default(1);
            $table->integer('max_storage_mb')->default(500);
            $table->unsignedTinyInteger('is_default')->default(0);
            $table->unsignedTinyInteger('is_trial')->default(0);
            $table->integer('trial_days')->default(0);
            $table->string('billing_cycle')->default('monthly');
            $table->unsignedTinyInteger('status')->default(1);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('plans');
    }
};