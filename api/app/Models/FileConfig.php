<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class FileConfig extends Model
{
    protected $fillable = [
        'name',
        'key',
        'driver',
        'base_path',
        'bucket',
        'region',
        'access_key',
        'secret_key',
        'endpoint',
        'is_default',
        'is_active',
    ];

    protected $casts = [
        'is_default' => 'boolean',
        'is_active' => 'boolean',
    ];

    protected $hidden = [
        'access_key',
        'secret_key',
    ];

    public function pathConfigs()
    {
        return $this->hasMany(FilePathConfig::class);
    }

    public function isActive(): bool
    {
        return (bool) $this->is_active;
    }

    public static function getDefaultDriver(): string
    {
        $config = static::where('is_default', 1)->where('is_active', 1)->first();
        return $config?->driver ?? 'local';
    }
}

class FilePathConfig extends Model
{
    protected $fillable = [
        'file_config_id',
        'module',
        'path_pattern',
        'max_size_mb',
        'allowed_extensions',
        'is_active',
    ];

    protected $casts = [
        'allowed_extensions' => 'array',
        'is_active' => 'boolean',
    ];

    public function fileConfig()
    {
        return $this->belongsTo(FileConfig::class);
    }

    public function getPath(array $replacements = []): string
    {
        $path = $this->path_pattern;
        
        foreach ($replacements as $key => $value) {
            $path = str_replace("{{$key}}", (string) $value, $path);
        }
        
        return $path;
    }

    public function isExtensionAllowed(string $extension): bool
    {
        $allowed = $this->allowed_extensions ?? [];
        return empty($allowed) || in_array(strtolower($extension), array_map('strtolower', $allowed));
    }

    public function isSizeAllowed(int $bytes): bool
    {
        $maxBytes = ($this->max_size_mb ?? 10) * 1024 * 1024;
        return $bytes <= $maxBytes;
    }
}