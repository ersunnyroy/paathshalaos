<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $table->string('institute_type')->default('school')->after('name');
            $table->string('country', 2)->default('IN')->after('institute_type');
            $table->string('timezone')->default('Asia/Kolkata')->after('country');
            $table->string('currency', 3)->default('INR')->after('timezone');
            $table->string('address_line1')->nullable()->after('address');
            $table->string('city')->nullable()->after('address_line1');
            $table->string('state')->nullable()->after('city');
            $table->string('postal_code')->nullable()->after('state');
            $table->string('website')->nullable()->after('primary_color');
            $table->string('alternate_contact')->nullable()->after('phone');
            $table->string('secondary_contact_name')->nullable()->after('alternate_contact');
            $table->string('board')->nullable()->after('secondary_contact_name');
            $table->string('medium')->nullable()->after('board');
            $table->year('established_year')->nullable()->after('medium');
            $table->string('tax_id')->nullable()->after('established_year');
            $table->string('registration_code')->nullable()->after('tax_id');
            $table->integer('student_count')->nullable()->after('registration_code');
            $table->integer('branch_count')->default(1)->after('student_count');
            $table->string('facebook')->nullable()->after('branch_count');
            $table->string('twitter')->nullable()->after('facebook');
            $table->string('instagram')->nullable()->after('twitter');
            $table->string('linkedin')->nullable()->after('instagram');
        });
    }

    public function down(): void
    {
        Schema::table('tenants', function (Blueprint $table) {
            $columns = [
                'institute_type', 'country', 'timezone', 'currency',
                'address_line1', 'city', 'state', 'postal_code',
                'website', 'alternate_contact', 'secondary_contact_name',
                'board', 'medium', 'established_year', 'tax_id',
                'registration_code', 'student_count', 'branch_count',
                'facebook', 'twitter', 'instagram', 'linkedin'
            ];
            foreach ($columns as $col) {
                $table->dropColumn($col);
            }
        });
    }
};