<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('states', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('country_id');
            $table->string('name');
            $table->string('code', 10)->nullable();
            $table->string('timezone')->nullable();
            $table->integer('sort_order')->default(0);
            $table->unsignedTinyInteger('status')->default(1);
            $table->timestamps();

            $table->foreign('country_id')->references('id')->on('countries')->onDelete('cascade');
            $table->index(['country_id', 'code'], 'states_country_code');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('states');
    }
};