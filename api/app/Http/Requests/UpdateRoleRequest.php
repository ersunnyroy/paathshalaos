<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateRoleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name'        => ['sometimes', 'string', 'max:255'],
            'description' => ['nullable', 'string', 'max:500'],
            'is_default'  => ['nullable', 'in:0,1'],
            'status'      => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.max'        => 'Role name must not exceed 255 characters.',
            'description.max' => 'Description must not exceed 500 characters.',
            'is_default.in'   => 'Default flag must be 0 or 1.',
            'status.in'       => 'Status must be either active (1) or inactive (0).',
        ];
    }
}
