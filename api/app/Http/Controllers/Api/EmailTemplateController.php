<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Repositories\Contracts\EmailTemplateRepositoryInterface;
use Illuminate\Http\Request;

class EmailTemplateController extends Controller
{
    public function __construct(
        private EmailTemplateRepositoryInterface $emailTemplateRepository
    ) {}

    public function index(Request $request)
    {
        $filters = $request->all();
        $templates = $this->emailTemplateRepository->getAll($filters);

        return response()->json([
            'success' => true,
            'data' => $templates,
        ]);
    }

    public function show(int $id)
    {
        $template = $this->emailTemplateRepository->findById($id);

        if (!$template) {
            return response()->json([
                'success' => false,
                'message' => 'Template not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $template,
        ]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'slug' => ['required', 'string', 'unique:email_templates,slug'],
            'name' => ['required', 'string'],
            'subject' => ['required', 'string'],
            'body' => ['required', 'string'],
            'variables' => ['nullable', 'string'],
            'is_default' => ['nullable', 'boolean'],
        ]);

        $template = $this->emailTemplateRepository->create($data);

        return response()->json([
            'success' => true,
            'message' => 'Template created successfully',
            'data' => $template,
        ], 201);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string'],
            'subject' => ['sometimes', 'string'],
            'body' => ['sometimes', 'string'],
            'variables' => ['nullable', 'string'],
        ]);

        $template = $this->emailTemplateRepository->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Template updated successfully',
            'data' => $template,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->emailTemplateRepository->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Template not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Template deleted successfully',
        ]);
    }

    public function activate(int $id)
    {
        $this->emailTemplateRepository->activate($id);

        return response()->json([
            'success' => true,
            'message' => 'Template activated',
        ]);
    }

    public function deactivate(int $id)
    {
        $this->emailTemplateRepository->deactivate($id);

        return response()->json([
            'success' => true,
            'message' => 'Template deactivated',
        ]);
    }
}