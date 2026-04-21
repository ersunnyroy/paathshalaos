<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class AssignRoleToUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'user_id' => ['required', 'integer', 'exists:users,id'],
            'role_id' => ['required', 'integer', 'exists:roles,id'],
        ];
    }

    public function messages(): array
    {
        return [
            'user_id.required' => 'User is required.',
            'user_id.integer'  => 'User ID must be a valid number.',
            'user_id.exists'   => 'The selected user does not exist.',
            'role_id.required' => 'Role is required.',
            'role_id.integer'  => 'Role ID must be a valid number.',
            'role_id.exists'   => 'The selected role does not exist.',
        ];
    }
}
