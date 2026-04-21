<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateModuleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $id = $this->route('module');

        return [
            'name'        => ['sometimes', 'string', 'max:255'],
            'slug'        => ['sometimes', 'string', 'max:100', "unique:modules,slug,{$id}"],
            'description' => ['nullable', 'string', 'max:500'],
            'icon'        => ['nullable', 'string', 'max:100'],
            'sort_order'  => ['nullable', 'integer', 'min:0'],
            'is_core'     => ['nullable', 'in:0,1'],
            'status'      => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.max'           => 'Module name must not exceed 255 characters.',
            'slug.max'           => 'Slug must not exceed 100 characters.',
            'slug.unique'        => 'A module with this slug already exists.',
            'description.max'    => 'Description must not exceed 500 characters.',
            'icon.max'           => 'Icon class must not exceed 100 characters.',
            'sort_order.integer' => 'Sort order must be a number.',
            'sort_order.min'     => 'Sort order must be 0 or greater.',
            'is_core.in'         => 'Core flag must be 0 or 1.',
            'status.in'          => 'Status must be either active (1) or inactive (0).',
        ];
    }
}
