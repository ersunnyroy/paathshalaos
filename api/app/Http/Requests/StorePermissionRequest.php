<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StorePermissionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name'        => ['required', 'string', 'max:255'],
            'slug'        => ['required', 'string', 'max:100', 'unique:permissions,slug'],
            'description' => ['nullable', 'string', 'max:500'],
            'module'      => ['nullable', 'string', 'max:100'],
            'is_global'   => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.required'   => 'Permission name is required.',
            'name.max'        => 'Permission name must not exceed 255 characters.',
            'slug.required'   => 'Permission slug is required.',
            'slug.max'        => 'Slug must not exceed 100 characters.',
            'slug.unique'     => 'A permission with this slug already exists.',
            'description.max' => 'Description must not exceed 500 characters.',
            'module.max'      => 'Module name must not exceed 100 characters.',
            'is_global.in'    => 'Global flag must be 0 or 1.',
        ];
    }
}
