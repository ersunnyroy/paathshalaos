<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateEmailTemplateRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name'      => ['sometimes', 'string', 'max:255'],
            'subject'   => ['sometimes', 'string', 'max:500'],
            'body'      => ['sometimes', 'string'],
            'variables' => ['nullable', 'string'],
        ];
    }

    public function messages(): array
    {
        return [
            'name.max'      => 'Template name must not exceed 255 characters.',
            'subject.max'   => 'Subject must not exceed 500 characters.',
        ];
    }
}
