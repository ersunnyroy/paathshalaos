<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\StoreEmailTemplateRequest;
use App\Http\Requests\UpdateEmailTemplateRequest;
use App\Repositories\Contracts\EmailTemplateRepositoryInterface;
use Illuminate\Http\Request;

class EmailTemplateController extends Controller
{
    public function __construct(
        private EmailTemplateRepositoryInterface $emailTemplateRepository
    ) {}

    public function index(Request $request)
    {
        $templates = $this->emailTemplateRepository->getAll($request->all());

        return response()->json([
            'success' => true,
            'data'    => $templates,
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
            'data'    => $template,
        ]);
    }

    public function store(StoreEmailTemplateRequest $request)
    {
        $template = $this->emailTemplateRepository->create($request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Template created successfully',
            'data'    => $template,
        ], 201);
    }

    public function update(UpdateEmailTemplateRequest $request, int $id)
    {
        $template = $this->emailTemplateRepository->update($id, $request->validated());

        return response()->json([
            'success' => true,
            'message' => 'Template updated successfully',
            'data'    => $template,
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
