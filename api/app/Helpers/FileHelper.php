<?php

use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

if (!function_exists('upload_file')) {
    function upload_file($type, $file, array $replacements = []): ?string
    {
        $config = config("file_paths.paths.{$type}");

        if (!$config) {
            throw new \Exception("Unknown file type: {$type}");
        }

        $extension = $file->getClientOriginalExtension();
        $maxSize = ($config['max_size_mb'] ?? 10) * 1024 * 1024;

        if ($file->getSize() > $maxSize) {
            throw new \Exception("File size exceeds {$config['max_size_mb']}MB limit");
        }

        $allowed = $config['allowed_extensions'] ?? [];
        if (!empty($allowed) && !in_array(strtolower($extension), array_map('strtolower', $allowed))) {
            throw new \Exception("File extension not allowed. Allowed: " . implode(', ', $allowed));
        }

        $path = $config['path'];
        foreach ($replacements as $key => $value) {
            $path = str_replace("{{$key}}", (string) $value, $path);
        }

        $path = $path . '.' . $extension;

        $disk = $config['disk'] ?? 'local';
        Storage::disk($disk)->put($path, file_get_contents($file));

        return $path;
    }
}

if (!function_exists('get_file_url')) {
    function get_file_url(string $path, string $disk = 'local'): string
    {
        if ($disk === 'local') {
            return asset('storage/' . $path);
        }

        $cdn = config('file_paths.cdn');
        if ($cdn['enabled'] ?? false) {
            return $cdn['url'] . '/' . $path;
        }

        return Storage::disk($disk)->url($path);
    }
}

if (!function_exists('delete_file')) {
    function delete_file(string $path, string $disk = 'local'): bool
    {
        return Storage::disk($disk)->delete($path);
    }
}