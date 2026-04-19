<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\BranchService;
use Illuminate\Http\Request;

class BranchController extends Controller
{
    public function __construct(
        private BranchService $branchService
    ) {}

    public function index(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $filters = $request->all();
        if ($tenantId && !$request->has('tenant_id')) {
            $filters['tenant_id'] = $tenantId;
        }

        $branches = $this->branchService->getAll($filters);

        return response()->json([
            'success' => true,
            'data' => $branches,
        ]);
    }

    public function store(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID') ?? $request->user()?->tenant_id;

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'subdomain' => ['nullable', 'string', 'max:63', 'unique:branches,subdomain'],
            'address' => ['nullable', 'string', 'max:500'],
            'phone' => ['nullable', 'string', 'max:20'],
            'email' => ['nullable', 'email'],
        ]);

        $data['tenant_id'] = $tenantId;

        $branch = $this->branchService->create($data);

        return response()->json([
            'success' => true,
            'message' => 'Branch created successfully',
            'data' => $branch,
        ], 201);
    }

    public function show(int $id)
    {
        $branch = $this->branchService->findById($id);

        if (!$branch) {
            return response()->json([
                'success' => false,
                'message' => 'Branch not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $branch,
        ]);
    }

    public function update(Request $request, int $id)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'subdomain' => ['sometimes', 'string', 'max:63', 'unique:branches,subdomain,' . $id],
            'address' => ['nullable', 'string', 'max:500'],
            'phone' => ['nullable', 'string', 'max:20'],
            'email' => ['nullable', 'email'],
            'status' => ['nullable', 'in:0,1'],
        ]);

        $branch = $this->branchService->update($id, $data);

        return response()->json([
            'success' => true,
            'message' => 'Branch updated successfully',
            'data' => $branch,
        ]);
    }

    public function destroy(int $id)
    {
        $deleted = $this->branchService->delete($id);

        if (!$deleted) {
            return response()->json([
                'success' => false,
                'message' => 'Branch not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'message' => 'Branch deleted successfully',
        ]);
    }
}