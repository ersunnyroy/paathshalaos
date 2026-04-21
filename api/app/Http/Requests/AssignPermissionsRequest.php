<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class AssignPermissionsRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'permission_ids'   => ['required', 'array'],
            'permission_ids.*' => ['integer', 'exists:permissions,id'],
        ];
    }

    public function messages(): array
    {
        return [
            'permission_ids.required'  => 'At least one permission must be selected.',
            'permission_ids.array'     => 'Permissions must be provided as a list.',
            'permission_ids.*.integer' => 'Each permission ID must be a valid number.',
            'permission_ids.*.exists'  => 'One or more selected permissions do not exist.',
        ];
    }
}
