<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class ReferenceDataSeeder extends Seeder
{
    public function run(): void
    {
        $this->seedCountries();
        $this->seedStates();
        $this->seedInstituteTypes();
        $this->seedBoards();
        $this->seedMediums();

        $this->command->info('Reference data seeded successfully!');
    }

    protected function seedCountries(): void
    {
        $countries = [
            ['India', 'IN', 'INR', '₹', 'Asia/Kolkata', '🇮🇳', 1],
            ['United States', 'US', 'USD', '$', 'America/New_York', '🇺🇸', 2],
            ['United Kingdom', 'GB', 'GBP', '£', 'Europe/London', '🇬🇧', 3],
            ['Australia', 'AU', 'AUD', '$', 'Australia/Sydney', '🇦🇺', 4],
            ['Canada', 'CA', 'CAD', '$', 'America/Toronto', '🇨🇦', 5],
            ['UAE', 'AE', 'AED', 'د.إ', 'Asia/Dubai', '🇦🇪', 6],
            ['Saudi Arabia', 'SA', 'SAR', '﷼', 'Asia/Riyadh', '🇸🇦', 7],
            ['Singapore', 'SG', 'SGD', '$', 'Asia/Singapore', '🇸🇬', 8],
            ['Nepal', 'NP', 'NPR', '₨', 'Asia/Kathmandu', '🇳🇵', 9],
            ['Bangladesh', 'BD', 'BDT', '৳', 'Asia/Dhaka', '🇧🇩', 10],
            ['Sri Lanka', 'LK', 'LKR', '₨', 'Asia/Colombo', '🇱🇰', 11],
            ['Pakistan', 'PK', 'PKR', '₨', 'Asia/Karachi', '🇵🇰', 12],
            ['Malaysia', 'MY', 'MYR', 'RM', 'Asia/Kuala_Lumpur', '🇲🇾', 13],
            ['Philippines', 'PH', 'PHP', '₱', 'Asia/Manila', '🇵🇭', 14],
            ['Indonesia', 'ID', 'IDR', 'Rp', 'Asia/Jakarta', '🇮🇩', 15],
            ['Thailand', 'TH', 'THB', '฿', 'Asia/Bangkok', '🇹🇭', 16],
            ['Vietnam', 'VN', 'VND', '₫', 'Asia/Ho_Chi_Minh', '🇻🇳', 17],
            ['China', 'CN', 'CNY', '¥', 'Asia/Shanghai', '🇨🇳', 18],
            ['Japan', 'JP', 'JPY', '¥', 'Asia/Tokyo', '🇯🇵', 19],
            ['South Korea', 'KR', 'KRW', '₩', 'Asia/Seoul', '🇰🇷', 20],
        ];

        foreach ($countries as [$name, $code, $currency, $symbol, $timezone, $flag, $order]) {
            DB::table('countries')->updateOrInsert(
                ['code' => $code],
                [
                    'name' => $name,
                    'currency' => $currency,
                    'currency_symbol' => $symbol,
                    'timezone' => $timezone,
                    'flag' => $flag,
                    'sort_order' => $order,
                    'status' => 1,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );
        }
    }

    protected function seedStates(): void
    {
        $indiaId = DB::table('countries')->where('code', 'IN')->first()?->id;

        if (!$indiaId) return;

        $indianStates = [
            ['Andhra Pradesh', 'AP', 'Asia/Kolkata'],
            ['Arunachal Pradesh', 'AR', 'Asia/Kolkata'],
            ['Assam', 'AS', 'Asia/Kolkata'],
            ['Bihar', 'BR', 'Asia/Kolkata'],
            ['Chhattisgarh', 'CG', 'Asia/Kolkata'],
            ['Goa', 'GA', 'Asia/Kolkata'],
            ['Gujarat', 'GJ', 'Asia/Kolkata'],
            ['Haryana', 'HR', 'Asia/Kolkata'],
            ['Himachal Pradesh', 'HP', 'Asia/Kolkata'],
            ['Jharkhand', 'JH', 'Asia/Kolkata'],
            ['Karnataka', 'KA', 'Asia/Kolkata'],
            ['Kerala', 'KL', 'Asia/Kolkata'],
            ['Madhya Pradesh', 'MP', 'Asia/Kolkata'],
            ['Maharashtra', 'MH', 'Asia/Kolkata'],
            ['Manipur', 'MN', 'Asia/Kolkata'],
            ['Meghalaya', 'ML', 'Asia/Kolkata'],
            ['Mizoram', 'MZ', 'Asia/Kolkata'],
            ['Nagaland', 'NL', 'Asia/Kolkata'],
            ['Odisha', 'OR', 'Asia/Kolkata'],
            ['Punjab', 'PB', 'Asia/Kolkata'],
            ['Rajasthan', 'RJ', 'Asia/Kolkata'],
            ['Sikkim', 'SK', 'Asia/Kolkata'],
            ['Tamil Nadu', 'TN', 'Asia/Kolkata'],
            ['Telangana', 'TG', 'Asia/Kolkata'],
            ['Tripura', 'TR', 'Asia/Kolkata'],
            ['Uttar Pradesh', 'UP', 'Asia/Kolkata'],
            ['Uttarakhand', 'UT', 'Asia/Kolkata'],
            ['West Bengal', 'WB', 'Asia/Kolkata'],
            ['Delhi', 'DL', 'Asia/Kolkata'],
            ['Jammu & Kashmir', 'JK', 'Asia/Kolkata'],
            ['Ladakh', 'LA', 'Asia/Kolkata'],
            ['Puducherry', 'PY', 'Asia/Kolkata'],
        ];

        foreach ($indianStates as [$name, $code, $timezone]) {
            DB::table('states')->updateOrInsert(
                ['country_id' => $indiaId, 'code' => $code],
                [
                    'name' => $name,
                    'code' => $code,
                    'timezone' => $timezone,
                    'status' => 1,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );
        }
    }

    protected function seedInstituteTypes(): void
    {
        $types = [
            ['School', 'school', 'k12', 1],
            ['College', 'college', 'higher_ed', 2],
            ['University', 'university', 'higher_ed', 3],
            ['Coaching Center', 'coaching', 'training', 4],
            ['Polytechnic', 'polytechnic', 'technical', 5],
            ['International School', 'international_school', 'k12', 6],
            ['Boarding School', 'boarding_school', 'k12', 7],
            ['Online Institute', 'online', 'digital', 8],
            ['Vocational Training', 'vocational', 'training', 9],
            ['Other', 'other', 'other', 10],
        ];

        foreach ($types as [$name, $slug, $category, $order]) {
            DB::table('institute_types')->updateOrInsert(
                ['slug' => $slug],
                [
                    'name' => $name,
                    'slug' => $slug,
                    'category' => $category,
                    'sort_order' => $order,
                    'is_active' => 1,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );
        }
    }

    protected function seedBoards(): void
    {
        $indiaId = DB::table('countries')->where('code', 'IN')->first()?->id;
        if (!$indiaId) return;

        $boards = [
            ['CBSE', 'cbse', 'CBSE', $indiaId, 1],
            ['ICSE', 'icse', 'ICSE', $indiaId, 2],
            ['CISCE', 'cisce', 'ICSE', $indiaId, 3],
            ['State Board', 'state', 'State', $indiaId, 4],
            ['IB', 'ib', 'IB', $indiaId, 5],
            ['Cambridge International', 'cambridge', 'CIE', $indiaId, 6],
            ['NIOS', 'nios', 'NIOS', $indiaId, 7],
            ['WBBSE', 'wbbse', 'WBBSE', $indiaId, 8],
            ['BSEB', 'bseb', 'BSEB', $indiaId, 9],
            ['UP Board', 'up_board', 'UPMSP', $indiaId, 10],
            ['RBSE', 'rbse', 'RBSE', $indiaId, 11],
            ['MP Board', 'mp_board', 'MPBSE', $indiaId, 12],
            ['Maharashtra Board', 'maharashtra_board', 'MSBSHSE', $indiaId, 13],
            ['Karnataka Board', 'karnataka_board', 'KTBS', $indiaId, 14],
            ['Other', 'other', 'Other', null, 15],
        ];

        foreach ($boards as [$name, $slug, $code, $countryId, $order]) {
            DB::table('boards')->updateOrInsert(
                ['slug' => $slug],
                [
                    'name' => $name,
                    'slug' => $slug,
                    'code' => $code,
                    'country_id' => $countryId,
                    'sort_order' => $order,
                    'is_active' => 1,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );
        }
    }

    protected function seedMediums(): void
    {
        $mediums = [
            ['English', 'english', 1],
            ['Hindi', 'hindi', 2],
            ['Bilingual (English + Hindi)', 'bilingual', 3],
            ['Regional Language', 'regional', 4],
            ['Telugu', 'telugu', 5],
            ['Tamil', 'tamil', 6],
            ['Kannada', 'kannada', 7],
            ['Malayalam', 'malayalam', 8],
            ['Marathi', 'marathi', 9],
            ['Gujarati', 'gujarati', 10],
            ['Bengali', 'bengali', 11],
            ['Odia', 'odia', 12],
            ['Other', 'other', 13],
        ];

        foreach ($mediums as [$name, $slug, $order]) {
            DB::table('mediums')->updateOrInsert(
                ['slug' => $slug],
                [
                    'name' => $name,
                    'slug' => $slug,
                    'sort_order' => $order,
                    'is_active' => 1,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]
            );
        }
    }
}