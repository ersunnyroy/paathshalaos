<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateFeatureRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $id = $this->route('feature');

        return [
            'module_id'          => ['sometimes', 'integer', 'exists:modules,id'],
            'name'               => ['sometimes', 'string', 'max:255'],
            'slug'               => ['sometimes', 'string', 'max:100', "unique:features,slug,{$id}"],
            'description'        => ['nullable', 'string', 'max:500'],
            'sort_order'         => ['nullable', 'integer', 'min:0'],
            'is_default_enabled' => ['nullable', 'in:0,1'],
            'status'             => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'module_id.exists'   => 'The selected module does not exist.',
            'name.max'           => 'Feature name must not exceed 255 characters.',
            'slug.max'           => 'Slug must not exceed 100 characters.',
            'slug.unique'        => 'A feature with this slug already exists.',
            'description.max'    => 'Description must not exceed 500 characters.',
            'sort_order.integer' => 'Sort order must be a number.',
            'sort_order.min'     => 'Sort order must be 0 or greater.',
            'status.in'          => 'Status must be either active (1) or inactive (0).',
        ];
    }
}
