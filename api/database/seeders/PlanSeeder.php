<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use App\Models\Plan;
use App\Models\Feature;

class PlanSeeder extends Seeder
{
    public function run(): void
    {
        $starter = Plan::updateOrCreate(
            ['slug' => 'starter'],
            [
                'name' => 'Starter',
                'slug' => 'starter',
                'description' => 'Perfect for small schools starting their digital journey',
                'price' => 999,
                'max_students' => 300,
                'max_teachers' => 20,
                'max_branches' => 1,
                'max_storage_mb' => 500,
                'is_default' => 1,
                'is_trial' => 1,
                'trial_days' => 14,
                'billing_cycle' => 'monthly',
                'status' => 1,
            ]
        );

        $growth = Plan::updateOrCreate(
            ['slug' => 'growth'],
            [
                'name' => 'Growth',
                'slug' => 'growth',
                'description' => 'For growing institutions with multiple branches',
                'price' => 2999,
                'max_students' => 800,
                'max_teachers' => 50,
                'max_branches' => 3,
                'max_storage_mb' => 2000,
                'is_default' => 0,
                'is_trial' => 1,
                'trial_days' => 14,
                'billing_cycle' => 'monthly',
                'status' => 1,
            ]
        );

        $pro = Plan::updateOrCreate(
            ['slug' => 'pro'],
            [
                'name' => 'Pro',
                'slug' => 'pro',
                'description' => 'Enterprise solution with all features',
                'price' => 7999,
                'max_students' => 2000,
                'max_teachers' => 150,
                'max_branches' => 10,
                'max_storage_mb' => 10000,
                'is_default' => 0,
                'is_trial' => 0,
                'trial_days' => 0,
                'billing_cycle' => 'monthly',
                'status' => 1,
            ]
        );

        $features = Feature::where('status', 1)->get();

        foreach ($features as $feature) {
            $starter->features()->syncWithoutDetaching([
                $feature->id => ['is_enabled' => 1, 'allow_override' => 0]
            ]);
            $growth->features()->syncWithoutDetaching([
                $feature->id => ['is_enabled' => 1, 'allow_override' => 1]
            ]);
            $pro->features()->syncWithoutDetaching([
                $feature->id => ['is_enabled' => 1, 'allow_override' => 1]
            ]);
        }

        $this->command->info('Created 3 plans: Starter, Growth, Pro');
    }
}