<?php

namespace App\Models;

use App\Models\Concerns\SerializesWithPublicIds;
use Illuminate\Database\Eloquent\Model;

class BaseModel extends Model
{
    use SerializesWithPublicIds;
}
