<?php

return [

    /*
    |--------------------------------------------------------------------------
    | ID obfuscation (Feistel + HMAC round function)
    |--------------------------------------------------------------------------
    |
    | Deterministic 32-bit reversible mapping (App\Helpers\CommonHelper::encryptId).
    | Set ID_OBFUSCATION_SECRET in production; if empty, a key is derived from APP_KEY.
    |
    */

    'enabled' => (bool) env('ID_OBFUSCATION_ENABLED', true),

    'secret' => env('ID_OBFUSCATION_SECRET'),

    'rounds' => (int) env('ID_OBFUSCATION_ROUNDS', 4),

];
