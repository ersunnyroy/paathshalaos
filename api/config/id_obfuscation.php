<?php

return [

    /*
    |--------------------------------------------------------------------------
    | ID obfuscation (XOR operation)
    |--------------------------------------------------------------------------
    |
    | Simple XOR operation for encrypting/decrypting IDs.
    | Set ID_OBFUSCATION_XOR_KEY in production (32-bit integer).
    |
    */

    'enabled' => (bool) env('ID_OBFUSCATION_ENABLED', true),

    'xor_key' => (int) env('ID_OBFUSCATION_XOR_KEY', 0x5A3C9E7F),

];
