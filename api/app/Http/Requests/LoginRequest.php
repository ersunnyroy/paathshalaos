<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class LoginRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'email_or_phone' => ['required', 'string'],
            'password' => ['required', 'string'],
            'tenant_id' => ['nullable', 'integer'],
        ];
    }

    public function messages(): array
    {
        return [
            'email_or_phone.required' => 'Email or phone is required',
            'password.required' => 'Password is required',
        ];
    }
}