<?php

namespace App\Helpers {

    use Illuminate\Support\Facades\Config;
    use InvalidArgumentException;

    /**
     * Application-wide static helpers. Add more methods here as the project grows
     * (formatting, small transforms, etc.). ID obfuscation uses a 32-bit Feistel + HMAC round function.
     */
    final class CommonHelper
    {
        // --- ID obfuscation (Feistel) -------------------------------------------

        private static function idObfuscationRounds(): int
        {
            $r = (int) Config::get('id_obfuscation.rounds', 4);

            return max(1, min(32, $r));
        }

        private static function idObfuscationHmacKey(): string
        {
            $custom = Config::get('id_obfuscation.secret');
            if (is_string($custom) && $custom !== '') {
                return $custom;
            }

            $key = (string) Config::get('app.key');
            if (str_starts_with($key, 'base64:')) {
                $decoded = base64_decode(substr($key, 7), true);
                $key = $decoded !== false ? $decoded : $key;
            }

            return hash('sha256', $key.'|id_obfuscation', true);
        }

        private static function idObfuscationRoundFunction(int $value, int $round): int
        {
            $value &= 0xFFFF;
            $hash = hash_hmac('sha256', $value.'|'.$round, self::idObfuscationHmacKey(), false);

            return (int) hexdec(substr($hash, 0, 8)) & 0xFFFF;
        }

        public static function encryptId(int $id): int
        {
            if (!Config::get('id_obfuscation.enabled', true)) {
                return $id;
            }

            if ($id < 0) {
                throw new InvalidArgumentException('encryptId expects a non-negative integer');
            }

            if ($id > 0xFFFFFFFF) {
                throw new InvalidArgumentException('encryptId only supports 32-bit unsigned ids');
            }

            $left = ($id >> 16) & 0xFFFF;
            $right = $id & 0xFFFF;
            $rounds = self::idObfuscationRounds();

            for ($i = 0; $i < $rounds; $i++) {
                $temp = $right;
                $right = $left ^ (self::idObfuscationRoundFunction($right, $i) & 0xFFFF);
                $left = $temp;
            }

            return (($left & 0xFFFF) << 16) | ($right & 0xFFFF);
        }

        public static function decryptId(int $encrypted): int
        {
            if (!Config::get('id_obfuscation.enabled', true)) {
                return $encrypted;
            }

            $encrypted &= 0xFFFFFFFF;
            $left = ($encrypted >> 16) & 0xFFFF;
            $right = $encrypted & 0xFFFF;
            $rounds = self::idObfuscationRounds();

            for ($i = $rounds - 1; $i >= 0; $i--) {
                $temp = $left;
                $left = $right ^ (self::idObfuscationRoundFunction($left, $i) & 0xFFFF);
                $right = $temp;
            }

            return (($left & 0xFFFF) << 16) | ($right & 0xFFFF);
        }
    }
}

namespace {

    use App\Helpers\CommonHelper;

    if (!function_exists('encrypt_id')) {
        function encrypt_id(int $id): int
        {
            return CommonHelper::encryptId($id);
        }
    }

    if (!function_exists('decrypt_id')) {
        /**
         * @param  int|string  $encrypted  Digit strings from JSON / query strings are accepted.
         */
        function decrypt_id(int|string $encrypted): int
        {
            if (is_string($encrypted)) {
                $encrypted = trim($encrypted);
                if ($encrypted === '' || !ctype_digit($encrypted)) {
                    throw new \InvalidArgumentException('decrypt_id requires an integer or an all-digit string');
                }
                $encrypted = (int) $encrypted;
            }

            $encrypted &= 0xFFFFFFFF;

            return CommonHelper::decryptId($encrypted);
        }
    }
}
