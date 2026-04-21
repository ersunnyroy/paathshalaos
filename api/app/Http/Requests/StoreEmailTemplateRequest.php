<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreEmailTemplateRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'slug'       => ['required', 'string', 'unique:email_templates,slug'],
            'name'       => ['required', 'string', 'max:255'],
            'subject'    => ['required', 'string', 'max:500'],
            'body'       => ['required', 'string'],
            'variables'  => ['nullable', 'string'],
            'is_default' => ['nullable', 'boolean'],
        ];
    }

    public function messages(): array
    {
        return [
            'slug.required'    => 'Template slug is required.',
            'slug.unique'      => 'A template with this slug already exists.',
            'name.required'    => 'Template name is required.',
            'name.max'         => 'Template name must not exceed 255 characters.',
            'subject.required' => 'Email subject is required.',
            'subject.max'      => 'Subject must not exceed 500 characters.',
            'body.required'    => 'Email body is required.',
            'is_default.boolean' => 'Default flag must be true or false.',
        ];
    }
}
