<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\FileService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class FileController extends Controller
{
    public function uploadTenantLogo(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID');

        if (!$tenantId) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant ID required',
            ], 400);
        }

        if (!$request->hasFile('logo')) {
            return response()->json([
                'success' => false,
                'message' => 'Logo file is required',
            ], 400);
        }

        try {
            $file = $request->file('logo');
            $result = FileService::uploadTenantLogo($file, $tenantId);

            return response()->json([
                'success' => true,
                'data' => [
                    'path' => $result['path'],
                    'url' => $result['url'],
                ],
            ]);
        } catch (\Exception $e) {
            Log::error('Logo upload failed', [
                'tenant_id' => $tenantId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ], 422);
        }
    }

    public function uploadTenantFavicon(Request $request)
    {
        $tenantId = $request->header('X-Tenant-ID');

        if (!$tenantId) {
            return response()->json([
                'success' => false,
                'message' => 'Tenant ID required',
            ], 400);
        }

        if (!$request->hasFile('favicon')) {
            return response()->json([
                'success' => false,
                'message' => 'Favicon file is required',
            ], 400);
        }

        try {
            $file = $request->file('favicon');
            $result = FileService::uploadTenantFavicon($file, $tenantId);

            return response()->json([
                'success' => true,
                'data' => [
                    'path' => $result['path'],
                    'url' => $result['url'],
                ],
            ]);
        } catch (\Exception $e) {
            Log::error('Favicon upload failed', [
                'tenant_id' => $tenantId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ], 422);
        }
    }

    public function deleteFile(Request $request)
    {
        $path = $request->query('path');

        if (!$path) {
            return response()->json([
                'success' => false,
                'message' => 'File path is required',
            ], 400);
        }

        try {
            $deleted = FileService::delete($path);

            return response()->json([
                'success' => $deleted,
                'message' => $deleted ? 'File deleted' : 'File not found',
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => $e->getMessage(),
            ], 422);
        }
    }
}