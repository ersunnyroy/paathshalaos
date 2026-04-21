<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreFeatureRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'module_id'          => ['required', 'integer', 'exists:modules,id'],
            'name'               => ['required', 'string', 'max:255'],
            'slug'               => ['required', 'string', 'max:100', 'unique:features,slug'],
            'description'        => ['nullable', 'string', 'max:500'],
            'sort_order'         => ['nullable', 'integer', 'min:0'],
            'is_default_enabled' => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'module_id.required' => 'Module is required.',
            'module_id.integer'  => 'Module ID must be a valid number.',
            'module_id.exists'   => 'The selected module does not exist.',
            'name.required'      => 'Feature name is required.',
            'name.max'           => 'Feature name must not exceed 255 characters.',
            'slug.required'      => 'Feature slug is required.',
            'slug.max'           => 'Slug must not exceed 100 characters.',
            'slug.unique'        => 'A feature with this slug already exists.',
            'description.max'    => 'Description must not exceed 500 characters.',
            'sort_order.integer' => 'Sort order must be a number.',
            'sort_order.min'     => 'Sort order must be 0 or greater.',
        ];
    }
}
