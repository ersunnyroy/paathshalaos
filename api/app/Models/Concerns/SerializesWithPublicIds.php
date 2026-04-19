<?php

namespace App\Models\Concerns;

use App\Helpers\CommonHelper;

/**
 * Primary key stays raw for queries; JSON uses obfuscated ids via jsonSerialize().
 */
trait SerializesWithPublicIds
{
    /**
     * Database primary key (plain integer).
     */
    public function getRawId(): int
    {
        $k = $this->getKey();

        return is_int($k) ? $k : (int) $k;
    }

    /**
     * Obfuscated id for URLs / clients (same as JSON "id" when obfuscation is on).
     */
    public function getEncryptedId(): int
    {
        return CommonHelper::encryptId($this->getRawId());
    }

    /**
     * Full array with id / *_id fields obfuscated (nested relations included once).
     */
    public function toPublicArray(): array
    {
        return CommonHelper::obfuscatePayload(parent::toArray());
    }

    /**
     * Used by response()->json() so APIs return obfuscated ids without middleware.
     */
    public function jsonSerialize(): array
    {
        if (CommonHelper::idObfuscationEnabled()) {
            return $this->toPublicArray();
        }

        return parent::toArray();
    }

    /**
     * Resolve {user}, {tenant}, etc. when the route segment is an obfuscated id.
     */
    public function resolveRouteBinding($value, $field = null)
    {
        if (CommonHelper::idObfuscationEnabled() && (is_int($value) || (is_string($value) && ctype_digit(trim((string) $value))))) {
            $v = is_int($value) ? $value : (int) trim((string) $value);
            $value = CommonHelper::decryptId($v & 0xFFFFFFFF);
        }

        return $this->resolveRouteBindingQuery($this, $value, $field)->first();
    }
}
