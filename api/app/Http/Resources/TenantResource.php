<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class TenantResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id'                     => $this->id,
            'name'                   => $this->name,
            'slug'                   => $this->slug,
            'subdomain'              => $this->subdomain,
            'email'                  => $this->email,
            'phone'                  => $this->phone,
            'address'                => $this->address,
            'address_line1'          => $this->address_line1,
            'city'                   => $this->city,
            'state'                  => $this->state,
            'postal_code'            => $this->postal_code,
            'logo'                   => $this->logo,
            'logo_url'               => $this->logo_url,
            'favicon_url'            => $this->favicon_url,
            'primary_color'          => $this->primary_color,
            'secondary_color'        => $this->secondary_color,
            'status'                 => $this->status,
            'institute_type'         => $this->institute_type,
            'country'                => $this->country,
            'timezone'               => $this->timezone,
            'currency'               => $this->currency,
            'website'                => $this->website,
            'board'                  => $this->board,
            'medium'                 => $this->medium,
            'established_year'       => $this->established_year,
            'student_count'          => $this->student_count,
            'description'            => $this->description,
            'facebook'               => $this->facebook,
            'twitter'                => $this->twitter,
            'instagram'              => $this->instagram,
            'linkedin'               => $this->linkedin,
            'created_at'             => $this->created_at?->toIso8601String(),
            'updated_at'             => $this->updated_at?->toIso8601String(),
        ];
    }
}