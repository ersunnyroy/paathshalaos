<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreTenantRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name'           => ['required', 'string', 'max:255'],
            'slug'           => ['required', 'string', 'max:255', 'unique:tenants,slug'],
            'subdomain'      => ['required', 'string', 'max:63', 'unique:tenants,subdomain'],
            'email'          => ['required', 'email'],
            'phone'          => ['nullable', 'string', 'max:20'],
            'address'        => ['nullable', 'string', 'max:500'],
            'address_line1'  => ['nullable', 'string', 'max:500'],
            'city'           => ['nullable', 'string', 'max:100'],
            'state'          => ['nullable', 'string', 'max:100'],
            'postal_code'    => ['nullable', 'string', 'max:20'],
            'logo'             => ['nullable', 'string', 'max:500'],
            'status'           => ['nullable', 'in:0,1'],
            'institute_type'   => ['nullable', 'string', 'max:100'],
            'country'          => ['nullable', 'string', 'max:2'],
            'timezone'         => ['nullable', 'string', 'max:50'],
            'currency'         => ['nullable', 'string', 'max:3'],
            'website'          => ['nullable', 'url', 'max:500'],
            'board'            => ['nullable', 'string', 'max:255'],
            'medium'           => ['nullable', 'string', 'max:255'],
            'established_year' => ['nullable', 'integer', 'min:1800', 'max:' . date('Y')],
            'student_count'    => ['nullable', 'integer', 'min:0'],
            'description'      => ['nullable', 'string', 'max:2000'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.required'      => 'Institution name is required.',
            'name.max'           => 'Institution name must not exceed 255 characters.',
            'slug.required'      => 'URL slug is required.',
            'slug.unique'        => 'This slug is already taken. Please choose another.',
            'subdomain.required' => 'Subdomain is required.',
            'subdomain.max'      => 'Subdomain must not exceed 63 characters.',
            'subdomain.unique'   => 'This subdomain is already taken. Please choose another.',
            'email.required'     => 'Email address is required.',
            'email.email'        => 'Please enter a valid email address.',
            'phone.max'          => 'Phone number must not exceed 20 characters.',
            'address.max'        => 'Address must not exceed 500 characters.',
            'address_line1.max'  => 'Address line 1 must not exceed 500 characters.',
            'city.max'           => 'City name must not exceed 100 characters.',
            'state.max'          => 'State name must not exceed 100 characters.',
            'postal_code.max'    => 'Postal code must not exceed 20 characters.',
            'country.max'        => 'Country code must be a 2-letter ISO code (e.g. IN, US).',
            'timezone.max'       => 'Timezone must not exceed 50 characters.',
            'currency.max'       => 'Currency code must be a 3-letter ISO code (e.g. INR, USD).',
            'status.in'               => 'Status must be either active (1) or inactive (0).',
            'website.url'             => 'Please enter a valid website URL (e.g. https://school.com).',
            'website.max'             => 'Website URL must not exceed 500 characters.',
            'board.max'               => 'Board/affiliation name must not exceed 255 characters.',
            'medium.max'              => 'Medium of instruction must not exceed 255 characters.',
            'established_year.integer' => 'Established year must be a valid year.',
            'established_year.min'    => 'Established year cannot be before 1800.',
            'established_year.max'    => 'Established year cannot be in the future.',
            'student_count.integer'   => 'Student count must be a whole number.',
            'student_count.min'       => 'Student count cannot be negative.',
            'description.max'         => 'Description must not exceed 2000 characters.',
        ];
    }
}
