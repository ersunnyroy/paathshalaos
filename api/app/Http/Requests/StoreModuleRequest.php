<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreModuleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name'        => ['required', 'string', 'max:255'],
            'slug'        => ['required', 'string', 'max:100', 'unique:modules,slug'],
            'description' => ['nullable', 'string', 'max:500'],
            'icon'        => ['nullable', 'string', 'max:100'],
            'sort_order'  => ['nullable', 'integer', 'min:0'],
            'is_core'     => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.required'  => 'Module name is required.',
            'name.max'       => 'Module name must not exceed 255 characters.',
            'slug.required'  => 'Module slug is required.',
            'slug.max'       => 'Slug must not exceed 100 characters.',
            'slug.unique'    => 'A module with this slug already exists.',
            'description.max'=> 'Description must not exceed 500 characters.',
            'icon.max'       => 'Icon class must not exceed 100 characters.',
            'sort_order.integer' => 'Sort order must be a number.',
            'sort_order.min'     => 'Sort order must be 0 or greater.',
            'is_core.in'     => 'Core flag must be 0 or 1.',
        ];
    }
}
