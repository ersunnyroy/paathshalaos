<?php

namespace App\Helpers;

use Illuminate\Support\Facades\Config;
use InvalidArgumentException;

/**
 * Shared helpers. Add more static methods here as the app grows.
 */
class CommonHelper
{
    // --- ID obfuscation (XOR operation) -----------------

    private static function idObfuscationXorKey(): int
    {
        $key = (int) Config::get('id_obfuscation.xor_key', 0x5A3C9E7F);

        return $key;
    }

    public static function encryptId(int $id): int
    {
        if (!self::idObfuscationEnabled()) {
            return $id;
        }

        $key = self::idObfuscationXorKey();

        return $id ^ $key;
    }

    public static function decryptId(int $encrypted): int
    {
        if (!self::idObfuscationEnabled()) {
            return $encrypted;
        }

        $key = self::idObfuscationXorKey();

        return $encrypted ^ $key;
    }

    public static function idObfuscationEnabled(): bool
    {
        return (bool) Config::get('id_obfuscation.enabled', true);
    }

    /**
     * Route / JSON may send an obfuscated PK. Try the value as-is first, then the Feistel-decrypted
     * value (when obfuscation is on). Repositories use this for findById-style lookups.
     *
     * @return list<int>
     */
    public static function primaryKeyCandidatesForLookup(int $id): array
    {
        $id &= 0xFFFFFFFF;
        $candidates = [$id];
        if (self::idObfuscationEnabled()) {
            $candidates[] = self::decryptId($id);
        }

        return array_values(array_unique($candidates));
    }

    /**
     * Recursively replace id / *_id (and *_ids lists) with encrypted integers for JSON responses.
     *
     * @param  array<mixed>|mixed  $data
     */
    public static function obfuscatePayload(mixed $data): mixed
    {
        if (!self::idObfuscationEnabled()) {
            return $data;
        }

        return self::walkPayload($data, true);
    }

    /**
     * Recursively decrypt id / *_id (and *_ids lists) in arrays (query, JSON body).
     *
     * @param  array<mixed>|mixed  $data
     */
    public static function deobfuscatePayload(mixed $data): mixed
    {
        if (!self::idObfuscationEnabled()) {
            return $data;
        }

        return self::walkPayload($data, false);
    }

    /**
     * Decode a single route param, header, or scalar from the client (encrypted int or digit string).
     */
    public static function decodeInboundIdValue(mixed $value): mixed
    {
        if ($value === null || $value === '') {
            return $value;
        }

        if (!self::idObfuscationEnabled()) {
            if (is_int($value)) {
                return $value;
            }
            $s = trim((string) $value);
            if ($s !== '' && ctype_digit($s)) {
                return (int) $s;
            }

            return $value;
        }

        if (is_int($value)) {
            return self::decryptId($value);
        }

        if (!is_string($value) && !is_numeric($value)) {
            return $value;
        }

        $s = trim((string) $value);
        if ($s === '' || !ctype_digit($s)) {
            return $value;
        }

        return self::decryptId(((int) $s) & 0xFFFFFFFF);
    }

    /**
     * @param  array<mixed>|mixed  $data
     */
    private static function walkPayload(mixed $data, bool $encode): mixed
    {
        if ($data === null || !is_array($data)) {
            return $data;
        }

        $out = [];

        foreach ($data as $key => $value) {
            $keyStr = is_string($key) || is_int($key) ? (string) $key : '';

            if (is_array($value)) {
                if ($keyStr !== '' && self::isPluralIdsKey($keyStr) && array_is_list($value)) {
                    $out[$key] = array_map(
                        fn ($item) => self::transformPayloadScalar($item, $encode),
                        $value
                    );
                } else {
                    $out[$key] = self::walkPayload($value, $encode);
                }

                continue;
            }

            if ($keyStr !== '' && self::looksLikeIdKey($keyStr)) {
                $out[$key] = self::transformPayloadScalar($value, $encode);

                continue;
            }

            $out[$key] = $value;
        }

        return $out;
    }

    private static function looksLikeIdKey(string $key): bool
    {
        return $key === 'id' || str_ends_with($key, '_id');
    }

    private static function isPluralIdsKey(string $key): bool
    {
        return str_ends_with($key, '_ids');
    }

    private static function transformPayloadScalar(mixed $value, bool $encode): mixed
    {
        if ($value === null || $value === '') {
            return $value;
        }

        if ($encode) {
            if (is_bool($value)) {
                return $value;
            }

            if (!is_numeric($value)) {
                return $value;
            }

            if (is_float($value) && floor($value) !== $value) {
                return $value;
            }

            $int = (int) $value;

            if ($int <= 0) {
                return $value;
            }

            return self::encryptId($int);
        }

        return self::decodeInboundIdValue($value);
    }
}
