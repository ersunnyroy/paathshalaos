<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use App\Helpers\CommonHelper;

class UpdateUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $encryptedId = $this->route('user');
        $id = CommonHelper::decryptId($encryptedId);

        return [
            'name'     => ['sometimes', 'string', 'max:255'],
            'email'    => ['sometimes', 'email', "unique:users,email,{$id}"],
            'phone'    => ['nullable', 'string', 'max:20', "unique:users,phone,{$id}"],
            'password' => ['sometimes', 'string', 'min:8'],
            'status'   => ['nullable', 'in:0,1'],
            'role_id'  => ['nullable', 'integer'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.max'      => 'Name must not exceed 255 characters.',
            'email.email'   => 'Please enter a valid email address.',
            'email.unique'  => 'This email address is already registered to another account.',
            'phone.max'     => 'Phone number must not exceed 20 characters.',
            'phone.unique'  => 'This phone number is already registered to another account.',
            'password.min'  => 'Password must be at least 8 characters.',
            'status.in'     => 'Status must be either active (1) or inactive (0).',
        ];
    }
}
