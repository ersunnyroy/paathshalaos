<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $id = $this->route('user');

        return [
            'name'     => ['sometimes', 'string', 'max:255'],
            'email'    => ['sometimes', 'email', "unique:users,email,{$id}"],
            'phone'    => ['nullable', 'string', 'max:20', "unique:users,phone,{$id}"],
            'password' => ['sometimes', 'string', 'min:8'],
            'status'   => ['nullable', 'in:0,1'],
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
