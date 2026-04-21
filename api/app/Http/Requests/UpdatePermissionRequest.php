<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdatePermissionRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $id = $this->route('permission');

        return [
            'name'        => ['sometimes', 'string', 'max:255'],
            'slug'        => ['sometimes', 'string', 'max:100', "unique:permissions,slug,{$id}"],
            'description' => ['nullable', 'string', 'max:500'],
            'module'      => ['nullable', 'string', 'max:100'],
            'is_global'   => ['nullable', 'in:0,1'],
            'status'      => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.max'        => 'Permission name must not exceed 255 characters.',
            'slug.max'        => 'Slug must not exceed 100 characters.',
            'slug.unique'     => 'A permission with this slug already exists.',
            'description.max' => 'Description must not exceed 500 characters.',
            'module.max'      => 'Module name must not exceed 100 characters.',
            'is_global.in'    => 'Global flag must be 0 or 1.',
            'status.in'       => 'Status must be either active (1) or inactive (0).',
        ];
    }
}
