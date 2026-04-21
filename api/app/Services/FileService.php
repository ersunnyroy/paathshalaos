<?php

namespace App\Services;

use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Http\UploadedFile;

class FileService
{
    private string $disk = 'local';
    private string $pathPattern;
    private int $maxSizeMb = 2;
    private array $allowedExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

    public function __construct()
    {
        $driver = config('file_paths.default_driver', 'local');
        // Map driver name to a registered disk: 'local' → 'public' so files
        // are web-accessible via /storage; 'minio'/'s3' used directly.
        $this->disk = match ($driver) {
            'minio' => 'minio',
            's3'    => 's3',
            default => 'public',
        };
    }

    public function setConfig(string $pathType): self
    {
        $paths = config('file_paths.paths', []);

        if (isset($paths[$pathType])) {
            $config = $paths[$pathType];
            $this->pathPattern      = $config['path'] ?? '';
            $this->maxSizeMb        = $config['max_size_mb'] ?? 2;
            $this->allowedExtensions = $config['allowed_extensions'] ?? ['jpg', 'jpeg', 'png'];
            // Do NOT override $this->disk from path config — the global driver wins.
        }

        return $this;
    }

    public function upload(UploadedFile $file, array $replacements = []): array
    {
        $extension = $file->getClientOriginalExtension();
        $extension = strtolower($extension);

        if (!in_array($extension, $this->allowedExtensions)) {
            throw new \InvalidArgumentException('File type not allowed. Allowed: ' . implode(', ', $this->allowedExtensions));
        }

        $maxSize = $this->maxSizeMb * 1024 * 1024;
        if ($file->getSize() > $maxSize) {
            throw new \InvalidArgumentException("File size exceeds {$this->maxSizeMb}MB limit");
        }

        $path = $this->buildPath($replacements);
        
        $filename = Str::random(32) . '.' . $extension;
        $fullPath = $path . '/' . $filename;

        $content = file_get_contents($file->getRealPath());
        
        Storage::disk($this->disk)->put($fullPath, $content);

        $url = $this->getUrl($fullPath);

        return [
            'path' => $fullPath,
            'url' => $url,
            'filename' => $filename,
            'size' => $file->getSize(),
            'extension' => $extension,
        ];
    }

    public function delete(string $path): bool
    {
        return Storage::disk($this->disk)->delete($path);
    }

    public function exists(string $path): bool
    {
        return Storage::disk($this->disk)->exists($path);
    }

    public function getUrl(string $path): string
    {
        $cdn = config('file_paths.cdn', []);
        
        if (!empty($cdn['enabled']) && !empty($cdn['url'])) {
            return $cdn['url'] . '/' . $path;
        }

        return Storage::disk($this->disk)->url($path);
    }

    private function buildPath(array $replacements): string
    {
        $path = $this->pathPattern;

        foreach ($replacements as $key => $value) {
            $path = str_replace('{' . $key . '}', $value, $path);
        }

        $path = trim($path, '/');

        return $path;
    }

    public static function uploadTenantLogo(UploadedFile $file, int $tenantId): array
    {
        $service = new self();
        return $service->setConfig('tenant_logo')->upload($file, [
            'tenant_id' => $tenantId,
        ]);
    }

    public static function uploadTenantFavicon(UploadedFile $file, int $tenantId): array
    {
        $service = new self();
        return $service->setConfig('tenant_favicon')->upload($file, [
            'tenant_id' => $tenantId,
        ]);
    }

    public static function uploadBranchLogo(UploadedFile $file, int $tenantId, int $branchId): array
    {
        $service = new self();
        return $service->setConfig('branch_logo')->upload($file, [
            'tenant_id' => $tenantId,
            'branch_id' => $branchId,
        ]);
    }

    public static function uploadUserAvatar(UploadedFile $file, int $tenantId, int $userId): array
    {
        $service = new self();
        return $service->setConfig('user_avatar')->upload($file, [
            'tenant_id' => $tenantId,
            'user_id' => $userId,
        ]);
    }
}