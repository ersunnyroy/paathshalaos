<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Repositories\Contracts\PlanRepositoryInterface;
use Illuminate\Http\Request;

class PlanController extends Controller
{
    public function __construct(
        private PlanRepositoryInterface $planRepository
    ) {}

    public function index(Request $request)
    {
        $plans = $this->planRepository->getActivePlans();

        return response()->json([
            'success' => true,
            'data' => $plans,
        ]);
    }

    public function show(int $id)
    {
        $plan = $this->planRepository->findById($id);

        if (!$plan) {
            return response()->json([
                'success' => false,
                'message' => 'Plan not found',
            ], 404);
        }

        return response()->json([
            'success' => true,
            'data' => $plan,
        ]);
    }
}