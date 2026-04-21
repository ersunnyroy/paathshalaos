<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class ToggleFeatureRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'is_enabled' => ['required', 'boolean'],
        ];
    }

    public function messages(): array
    {
        return [
            'is_enabled.required' => 'Enabled state is required.',
            'is_enabled.boolean'  => 'Enabled state must be true or false.',
        ];
    }
}
