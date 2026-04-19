<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Country;
use App\Models\State;
use App\Models\InstituteType;
use App\Models\Board;
use App\Models\Medium;
use Illuminate\Http\Request;

class ReferenceController extends Controller
{
    public function countries(Request $request)
    {
        $countries = Country::where('status', 1)
            ->orderBy('sort_order')
            ->get(['id', 'name', 'code', 'currency', 'currency_symbol', 'timezone', 'flag']);

        return response()->json([
            'success' => true,
            'data' => $countries,
        ]);
    }

    public function states(Request $request)
    {
        $countryId = $request->query('country_id');

        $states = State::when($countryId, fn($q) => $q->where('country_id', $countryId))
            ->where('status', 1)
            ->orderBy('name')
            ->get(['id', 'country_id', 'name', 'code', 'timezone']);

        return response()->json([
            'success' => true,
            'data' => $states,
        ]);
    }

    public function instituteTypes()
    {
        $types = InstituteType::where('is_active', 1)
            ->orderBy('sort_order')
            ->get(['id', 'name', 'slug', 'category']);

        return response()->json([
            'success' => true,
            'data' => $types,
        ]);
    }

    public function boards(Request $request)
    {
        $countryId = $request->query('country_id');

        $boards = Board::where('is_active', 1)
            ->when($countryId, fn($q) => $q->where('country_id', $countryId)->orWhere('country_id', null))
            ->orderBy('name')
            ->get(['id', 'country_id', 'name', 'slug', 'code']);

        return response()->json([
            'success' => true,
            'data' => $boards,
        ]);
    }

    public function mediums()
    {
        $mediums = Medium::where('is_active', 1)
            ->orderBy('sort_order')
            ->get(['id', 'name', 'slug']);

        return response()->json([
            'success' => true,
            'data' => $mediums,
        ]);
    }
}