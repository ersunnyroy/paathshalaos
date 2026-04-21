<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateBranchRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        $id = $this->route('branch');

        return [
            'name'      => ['sometimes', 'string', 'max:255'],
            'subdomain' => ['sometimes', 'string', 'max:63', "unique:branches,subdomain,{$id}"],
            'address'   => ['nullable', 'string', 'max:500'],
            'phone'     => ['nullable', 'string', 'max:20'],
            'email'     => ['nullable', 'email'],
            'status'    => ['nullable', 'in:0,1'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.max'         => 'Branch name must not exceed 255 characters.',
            'subdomain.max'    => 'Subdomain must not exceed 63 characters.',
            'subdomain.unique' => 'This subdomain is already taken. Please choose another.',
            'address.max'      => 'Address must not exceed 500 characters.',
            'phone.max'        => 'Phone number must not exceed 20 characters.',
            'email.email'      => 'Please enter a valid email address.',
            'status.in'        => 'Status must be either active (1) or inactive (0).',
        ];
    }
}
