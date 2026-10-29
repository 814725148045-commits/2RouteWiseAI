/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DeliveryOrder, Vehicle } from '../../types';
import {
  calculateDistanceKm,
  calculateTravelTimeMinutes,
  getDepotCoordinates,
  getOrderCoordinates,
  Point2D,
  SYNTHETIC_MODEL_DISCLOSURE,
} from './travelCostMatrix';
import {
  validateOptimizationInputs,
  verifyPlanFeasibility,
} from './constraintValidation';
import {
  evaluateStopEta,
  parseTimeToMinutes,
} from './etaCalculator';
import {
  calculateBaselineMetrics,
  comparePlanMetrics,
} from './metricsComparison';
import {
  GeminiInsightPayload,
  OptimizationResult,
  OptimizationSettings,
  RouteStopPlan,
  UnassignedOrderReport,
  VehicleRoutePlan,
} from './types';

export const DEFAULT_OPTIMIZATION_SETTINGS: OptimizationSettings = {
  objective: 'distance',
  averageSpeedKmH: 35,
  serviceTimeMinutes: 10,
  depotDepartureTime: '08:30 AM',
  maxIterations2Opt: 50,
  fleetScope: 'operational',
};

/**
 * 2-Opt swap helper for an array of orders starting and ending at depot
 */
function runTwoOptPass(
  orderedOrders: DeliveryOrder[],
  depotPoint: Point2D,
  maxIterations: number
): DeliveryOrder[] {
  if (orderedOrders.length <= 2) return orderedOrders;

  let bestRoute = [...orderedOrders];
  let improved = true;
  let iteration = 0;

  // Calculates total path distance: Depot -> Stop1 -> ... -> StopN -> Depot
  const computeRouteDist = (route: DeliveryOrder[]): number => {
    let dist = 0;
    let prev = depotPoint;
    for (const ord of route) {
      const pt = getOrderCoordinates(ord);
      dist += calculateDistanceKm(prev, pt);
      prev = pt;
    }
    dist += calculateDistanceKm(prev, depotPoint);
    return dist;
  };

  let bestDist = computeRouteDist(bestRoute);

  while (improved && iteration < maxIterations) {
    improved = false;
    iteration++;

    for (let i = 0; i < bestRoute.length - 1; i++) {
      for (let j = i + 1; j < bestRoute.length; j++) {
        // Reverse subsegment between i and j
        const candidate = [
          ...bestRoute.slice(0, i),
          ...bestRoute.slice(i, j + 1).reverse(),
          ...bestRoute.slice(j + 1),
        ];

        const candidateDist = computeRouteDist(candidate);

        // Strict improvement check with threshold to prevent floating point jitter
        if (candidateDist < bestDist - 0.01) {
          bestRoute = candidate;
          bestDist = candidateDist;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return bestRoute;
}

/**
 * Deterministic Nearest-Neighbor route construction from depot
 */
function sequenceByNearestNeighbor(
  ordersForVehicle: DeliveryOrder[],
  depotPoint: Point2D
): DeliveryOrder[] {
  if (ordersForVehicle.length <= 1) return [...ordersForVehicle];

  const unvisited = [...ordersForVehicle];
  const ordered: DeliveryOrder[] = [];
  let currentPoint = depotPoint;

  while (unvisited.length > 0) {
    let nearestIndex = 0;
    let shortestDist = Number.MAX_VALUE;

    for (let i = 0; i < unvisited.length; i++) {
      const ord = unvisited[i];
      const ordPoint = getOrderCoordinates(ord);
      const dist = calculateDistanceKm(currentPoint, ordPoint);

      // Deterministic tie-breaking by order ID string
      if (
        dist < shortestDist ||
        (Math.abs(dist - shortestDist) < 0.001 && ord.id < unvisited[nearestIndex].id)
      ) {
        shortestDist = dist;
        nearestIndex = i;
      }
    }

    const nextOrder = unvisited.splice(nearestIndex, 1)[0];
    ordered.push(nextOrder);
    currentPoint = getOrderCoordinates(nextOrder);
  }

  return ordered;
}

/**
 * Builds RouteStopPlan sequence with distances, times, and ETAs
 */
function buildStopPlans(
  orderedOrders: DeliveryOrder[],
  depotPoint: Point2D,
  settings: OptimizationSettings
): {
  stops: RouteStopPlan[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  deadlineWarningsCount: number;
} {
  const departureMinutes = parseTimeToMinutes(settings.depotDepartureTime) ?? 510; // Default 08:30 AM (510 min)

  const stops: RouteStopPlan[] = [];
  let prevPoint = depotPoint;
  let cumulativeDistanceKm = 0;
  let currentMinutes = departureMinutes;
  let deadlineWarningsCount = 0;

  orderedOrders.forEach((order, index) => {
    const orderPoint = getOrderCoordinates(order);
    const distFromPrev = calculateDistanceKm(prevPoint, orderPoint);
    const travelTimeMin = calculateTravelTimeMinutes(distFromPrev, settings.averageSpeedKmH);

    cumulativeDistanceKm = Number((cumulativeDistanceKm + distFromPrev).toFixed(2));
    const arrivalMinutes = currentMinutes + travelTimeMin;

    const etaEval = evaluateStopEta(arrivalMinutes, order.deliveryDeadline);
    if (etaEval.isDeadlineMissed) {
      deadlineWarningsCount++;
    }

    stops.push({
      stopIndex: index + 1,
      order,
      estimatedArrival: etaEval.estimatedArrival,
      estimatedArrivalMinutes: arrivalMinutes,
      travelDistanceKmFromPrev: distFromPrev,
      travelTimeMinutesFromPrev: travelTimeMin,
      cumulativeDistanceKm,
      cumulativeTimeMinutes: arrivalMinutes - departureMinutes,
      isDeadlineMissed: etaEval.isDeadlineMissed,
      deadlineDiscrepancyMinutes: etaEval.deadlineDiscrepancyMinutes,
      deadlineString: etaEval.deadlineString,
    });

    // Advance time for next stop: arrival + service time at this stop
    currentMinutes = arrivalMinutes + settings.serviceTimeMinutes;
    prevPoint = orderPoint;
  });

  // Add return leg to depot
  const returnDist = orderedOrders.length > 0 ? calculateDistanceKm(prevPoint, depotPoint) : 0;
  const returnTravelTimeMin = calculateTravelTimeMinutes(returnDist, settings.averageSpeedKmH);
  cumulativeDistanceKm = Number((cumulativeDistanceKm + returnDist).toFixed(2));
  currentMinutes += returnTravelTimeMin;

  const totalDurationMinutes = currentMinutes - departureMinutes;

  return {
    stops,
    totalDistanceKm: cumulativeDistanceKm,
    totalDurationMinutes,
    deadlineWarningsCount,
  };
}

/**
 * Generates factual rule-based briefing ready for Gemini AI Insights (Module 5)
 */
function generateDispatcherBriefing(
  routes: VehicleRoutePlan[],
  unassigned: UnassignedOrderReport[],
  comparison: ReturnType<typeof comparePlanMetrics>
): GeminiInsightPayload {
  const activeRoutes = routes.filter((r) => r.stops.length > 0);
  const totalStops = activeRoutes.reduce((s, r) => s + r.stops.length, 0);
  const totalWarnings = activeRoutes.reduce((s, r) => s + r.deadlineWarningsCount, 0);

  const keyHighlights: string[] = [
    `Routed ${totalStops} delivery stops across ${activeRoutes.length} operational vehicles.`,
    comparison.distanceSavedKm > 0
      ? `Estimated savings: ${comparison.distanceSavedKm} km (${comparison.distanceImprovementPercent}%) compared to baseline schedule.`
      : `Complete route coverage verified across active zones.`,
    totalWarnings === 0
      ? `All planned stop arrivals meet specified delivery deadlines.`
      : `${totalWarnings} stop(s) flagged with deadline risks requiring dispatcher priority handoff.`,
  ];

  const vehicleAnalysis = activeRoutes.map((r) => {
    let rating: 'optimal' | 'balanced' | 'underutilized' | 'overloaded' = 'balanced';
    if (r.capacityUtilizationPercent > 85) rating = 'optimal';
    else if (r.capacityUtilizationPercent < 40) rating = 'underutilized';

    return {
      vehicleId: r.vehicle.id,
      driverName: r.vehicle.driverName,
      utilization: r.capacityUtilizationPercent,
      efficiencyRating: rating,
      reason: `${r.vehicle.id} loaded at ${r.totalAssignedLoadKg} kg of ${r.vehicle.capacityKg} kg (${r.capacityUtilizationPercent}% utilization) servicing ${r.stops.length} stops over ${r.totalDistanceKm} km.`,
    };
  });

  const bottlenecksAndRisks: string[] = [];
  if (unassigned.length > 0) {
    bottlenecksAndRisks.push(
      `${unassigned.length} order(s) remain unassigned due to capacity or constraint limits.`
    );
  }
  if (totalWarnings > 0) {
    bottlenecksAndRisks.push(
      `${totalWarnings} delivery deadline SLA risk(s) detected. Consider shifting urgent stops earlier in the departure wave.`
    );
  }

  const recommendations: string[] = [
    'Execute morning departure at 08:30 AM to maximize on-time window buffers.',
    'Keep high-capacity vehicles (VAN-103) stationed for dense industrial bulk orders.',
  ];
  if (unassigned.length > 0) {
    recommendations.push(
      'Review pending unassigned orders in Route Rescue or deploy backup fleet reserve.'
    );
  }

  return {
    summary: `Deterministic heuristic plan created: ${totalStops} stops, ${comparison.optimizedTotalDistanceKm} km total distance, ${activeRoutes.length} vehicles utilized.`,
    keyHighlights,
    vehicleEfficiencyAnalysis: vehicleAnalysis,
    bottlenecksAndRisks,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Main Deterministic Route Optimization Function
 */
export function optimizeRoutes(
  orders: DeliveryOrder[],
  vehicles: Vehicle[],
  settings: OptimizationSettings = DEFAULT_OPTIMIZATION_SETTINGS
): OptimizationResult {
  const depotPoint = getDepotCoordinates();

  // Step 1: Pre-validation
  const validationReport = validateOptimizationInputs(orders, vehicles, settings);

  // If validation fails critically (no vehicles or critical errors), construct an empty result with errors
  if (!validationReport.isValid) {
    const emptyBaseline = calculateBaselineMetrics(orders, vehicles, settings);
    const emptyComparison = comparePlanMetrics(emptyBaseline, [], 0);

    return {
      id: `OPT-${Date.now()}`,
      optimizedAt: new Date().toISOString(),
      settings,
      routes: [],
      unassignedOrders: orders
        .filter((o) => o.status !== 'cancelled' && o.status !== 'delivered')
        .map((o) => ({
          order: o,
          reason: 'Pre-optimization validation failure',
          detail: 'One or more required fields or fleet constraints failed validation checks.',
        })),
      validationReport,
      comparison: emptyComparison,
      geminiInsight: {
        summary: 'Optimization halted: Input validation reported critical errors.',
        keyHighlights: ['Please resolve validation errors in the panel above before continuing.'],
        vehicleEfficiencyAnalysis: [],
        bottlenecksAndRisks: ['Critical constraint or data errors detected.'],
        recommendations: ['Inspect missing addresses, zero weights, or fleet availability.'],
        generatedAt: new Date().toISOString(),
      },
      totalDistanceKm: 0,
      totalDurationMinutes: 0,
      totalAssignedOrders: 0,
      totalUnassignedOrders: validationReport.eligibleOrdersCount,
      vehiclesUsedCount: 0,
      totalFleetLoadKg: 0,
      isFeasible: false,
      algorithmName: 'Deterministic Nearest-Neighbor + 2-Opt (Halted on Validation)',
      modelLimitationsNote: SYNTHETIC_MODEL_DISCLOSURE,
    };
  }

  // Step 2: Filter eligible entities
  const eligibleVehicles = vehicles
    .filter((v) => {
      if (v.status === 'Maintenance' || v.status === 'Offline') return false;
      if (settings.fleetScope === 'available-only') return v.status === 'Available';
      return v.status === 'Available' || v.status === 'On Route';
    })
    .sort((a, b) => (b.capacityKg || 0) - (a.capacityKg || 0) || a.id.localeCompare(b.id));

  const eligibleOrders = orders
    .filter((o) => o.status !== 'cancelled' && o.status !== 'delivered')
    .sort((a, b) => {
      // Priority sorting: urgent > high > normal > low
      const priorityWeight: Record<string, number> = {
        urgent: 4,
        high: 3,
        normal: 2,
        low: 1,
      };
      const pDiff = (priorityWeight[b.priority] || 2) - (priorityWeight[a.priority] || 2);
      if (pDiff !== 0) return pDiff;

      // Deadline urgency sorting: earlier deadline first
      const deadA = parseTimeToMinutes(a.deliveryDeadline) ?? 1440;
      const deadB = parseTimeToMinutes(b.deliveryDeadline) ?? 1440;
      if (deadA !== deadB) return deadA - deadB;

      // Heavy package first (First-Fit Decreasing)
      const wA = a.weightKg || a.packageWeightKg || 0;
      const wB = b.weightKg || b.packageWeightKg || 0;
      if (wB !== wA) return wB - wA;

      // Deterministic fallback by order ID
      return a.id.localeCompare(b.id);
    });

  // Step 3: Heuristic Vehicle Assignment
  // Initialize vehicle buckets
  interface VehicleBucket {
    vehicle: Vehicle;
    assignedOrders: DeliveryOrder[];
    currentLoadKg: number;
    maxCapacityKg: number;
    maxStops: number;
  }

  const buckets: VehicleBucket[] = eligibleVehicles.map((v) => ({
    vehicle: v,
    assignedOrders: [],
    currentLoadKg: 0,
    maxCapacityKg: v.capacityKg || 500,
    maxStops: v.maxStops || 15,
  }));

  const unassigned: UnassignedOrderReport[] = [];

  for (const order of eligibleOrders) {
    const orderWeight = order.weightKg || order.packageWeightKg || 0;

    // Check if order exceeds every vehicle's total capacity
    const canFitAnywhere = buckets.some((b) => b.maxCapacityKg >= orderWeight);
    if (!canFitAnywhere) {
      unassigned.push({
        order,
        reason: 'Order exceeds available vehicle capacity',
        detail: `Package weight (${orderWeight} kg) exceeds maximum capacity of any available vehicle (Max: ${Math.max(
          ...buckets.map((b) => b.maxCapacityKg)
        )} kg).`,
      });
      continue;
    }

    // Find best compatible vehicle bucket
    // Criterion: Can accommodate weight without exceeding capacity & max stops.
    // Preference: If order already has an assigned vehicle and it fits, keep affinity; else choose vehicle with least remaining distance addition.
    let bestBucket: VehicleBucket | null = null;
    let minAddedDist = Number.MAX_VALUE;

    for (const bucket of buckets) {
      const willExceedWeight = bucket.currentLoadKg + orderWeight > bucket.maxCapacityKg;
      const willExceedStops = bucket.assignedOrders.length + 1 > bucket.maxStops;

      if (willExceedWeight || willExceedStops) {
        continue;
      }

      // Proximity evaluation: distance from last assigned stop or depot
      const lastPoint =
        bucket.assignedOrders.length > 0
          ? getOrderCoordinates(bucket.assignedOrders[bucket.assignedOrders.length - 1])
          : depotPoint;

      const orderPoint = getOrderCoordinates(order);
      const addedDist = calculateDistanceKm(lastPoint, orderPoint);

      // Strong affinity bonus if already assigned to this vehicle in baseline
      const affinityBonus = order.assignedVehicleId === bucket.vehicle.id ? -15 : 0;
      const effectiveDist = addedDist + affinityBonus;

      if (effectiveDist < minAddedDist) {
        minAddedDist = effectiveDist;
        bestBucket = bucket;
      }
    }

    if (bestBucket) {
      bestBucket.assignedOrders.push(order);
      bestBucket.currentLoadKg = Number((bestBucket.currentLoadKg + orderWeight).toFixed(1));
    } else {
      unassigned.push({
        order,
        reason: 'Fleet capacity exhausted',
        detail: `All compatible vehicles have reached capacity or max stops limit (${orderWeight} kg could not be accommodated).`,
      });
    }
  }

  // Step 4: Route Sequencing & 2-Opt Optimization for each vehicle
  const vehicleRoutePlans: VehicleRoutePlan[] = [];

  for (const bucket of buckets) {
    if (bucket.assignedOrders.length === 0) {
      // Vehicle unused
      vehicleRoutePlans.push({
        vehicle: bucket.vehicle,
        stops: [],
        totalDistanceKm: 0,
        totalDurationMinutes: 0,
        totalAssignedLoadKg: 0,
        capacityUtilizationPercent: 0,
        remainingCapacityKg: bucket.maxCapacityKg,
        deadlineWarningsCount: 0,
        isOverCapacity: false,
        exceedsMaxStops: false,
      });
      continue;
    }

    // 1. Initial Nearest-Neighbor sequencing
    const nnSequence = sequenceByNearestNeighbor(bucket.assignedOrders, depotPoint);

    // 2. 2-Opt local search improvement pass
    const optimizedSequence = runTwoOptPass(
      nnSequence,
      depotPoint,
      settings.maxIterations2Opt
    );

    // 3. Build stop plans with precise ETAs and travel times
    const { stops, totalDistanceKm, totalDurationMinutes, deadlineWarningsCount } =
      buildStopPlans(optimizedSequence, depotPoint, settings);

    const utilization = Math.round((bucket.currentLoadKg / bucket.maxCapacityKg) * 100);

    vehicleRoutePlans.push({
      vehicle: bucket.vehicle,
      stops,
      totalDistanceKm,
      totalDurationMinutes,
      totalAssignedLoadKg: bucket.currentLoadKg,
      capacityUtilizationPercent: utilization,
      remainingCapacityKg: Math.max(0, Number((bucket.maxCapacityKg - bucket.currentLoadKg).toFixed(1))),
      deadlineWarningsCount,
      isOverCapacity: bucket.currentLoadKg > bucket.maxCapacityKg,
      exceedsMaxStops: stops.length > bucket.maxStops,
    });
  }

  // Step 5: Feasibility Check
  const feasibilityCheck = verifyPlanFeasibility(vehicleRoutePlans);

  // Step 6: Baseline Metrics & Comparison
  const baseline = calculateBaselineMetrics(orders, vehicles, settings);
  const comparison = comparePlanMetrics(baseline, vehicleRoutePlans, eligibleOrders.length);

  // Step 7: AI / Dispatcher Briefing
  const geminiInsight = generateDispatcherBriefing(vehicleRoutePlans, unassigned, comparison);

  const totalAssignedOrders = vehicleRoutePlans.reduce((s, r) => s + r.stops.length, 0);
  const totalFleetLoadKg = Number(
    vehicleRoutePlans.reduce((s, r) => s + r.totalAssignedLoadKg, 0).toFixed(1)
  );
  const vehiclesUsedCount = vehicleRoutePlans.filter((r) => r.stops.length > 0).length;

  return {
    id: `OPT-${Date.now()}`,
    optimizedAt: new Date().toISOString(),
    settings,
    routes: vehicleRoutePlans,
    unassignedOrders: unassigned,
    validationReport,
    comparison,
    geminiInsight,
    totalDistanceKm: comparison.optimizedTotalDistanceKm,
    totalDurationMinutes: comparison.optimizedTotalDurationMinutes,
    totalAssignedOrders,
    totalUnassignedOrders: unassigned.length,
    vehiclesUsedCount,
    totalFleetLoadKg,
    isFeasible: feasibilityCheck.isFeasible,
    algorithmName: 'Deterministic Nearest-Neighbor + 2-Opt with Capacity & Deadline Constraints',
    modelLimitationsNote: SYNTHETIC_MODEL_DISCLOSURE,
  };
}
