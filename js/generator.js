import { INTENSITIES, MUSCLE_GROUPS, createId } from "./data.js";

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hashNumber(value) {
  let hash = 2166136261;
  const text = String(value);

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 4294967295;
}

function enabledEquipmentIds(equipment) {
  return new Set(equipment.filter((item) => item.enabled).map((item) => item.id));
}

export function isExerciseAvailable(exercise, equipment) {
  const available = enabledEquipmentIds(equipment);
  return exercise.enabled !== false && exercise.equipment.every((id) => available.has(id));
}

export function getExerciseHistory(exerciseId, workouts, limit = 5) {
  const matches = [];

  for (const workout of workouts) {
    const item = workout.items?.find((entry) => entry.exerciseId === exerciseId);
    if (item) {
      matches.push({
        workoutId: workout.id,
        completedAt: workout.completedAt,
        intensity: workout.intensity,
        item,
      });
    }
    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

export function formatSetSummary(item) {
  const completedSets = (item.sets || []).filter((set) => set.completed);
  if (completedSets.length === 0) {
    return "記録なし";
  }

  if (item.type === "time") {
    return completedSets.map((set) => `${set.durationSeconds || item.targetSeconds || 0}秒`).join(" / ");
  }

  const weights = completedSets.map((set) => Number(set.weight) || 0);
  const sameWeight = weights.every((weight) => weight === weights[0]);
  const reps = completedSets.map((set) => set.reps || 0).join(" / ");

  if (sameWeight && weights[0] > 0) {
    return `${formatWeight(weights[0])}kg × ${reps}`;
  }
  if (sameWeight) {
    return `自重 × ${reps}`;
  }

  return completedSets
    .map((set) => `${Number(set.weight) > 0 ? `${formatWeight(set.weight)}kg` : "自重"}×${set.reps || 0}`)
    .join(" / ");
}

function formatWeight(value) {
  return Number.isInteger(Number(value)) ? String(Number(value)) : Number(value).toFixed(1);
}

function recentExercisePenalty(exercise, workouts) {
  let penalty = 0;

  workouts.slice(0, 4).forEach((workout, workoutIndex) => {
    if (workout.items?.some((item) => item.exerciseId === exercise.id)) {
      const freshness = [5, 3, 1.5, 0.5][workoutIndex];
      penalty += exercise.foundation ? freshness * 0.55 : freshness;
    }
  });

  return penalty;
}

function recentGroupLoad(groupId, workouts) {
  return workouts.slice(0, 4).reduce((load, workout, index) => {
    const groupHits = new Set((workout.items || []).map((item) => item.muscleGroup));
    return load + (groupHits.has(groupId) ? [8, 4, 2, 1][index] : 0);
  }, 0);
}

function chooseGroups(candidates, count, workouts, nonce) {
  const availableGroups = Object.keys(MUSCLE_GROUPS).filter((groupId) => (
    candidates.some((exercise) => exercise.muscleGroup === groupId)
  ));

  return availableGroups
    .map((groupId) => ({
      groupId,
      score: recentGroupLoad(groupId, workouts) + hashNumber(`${nonce}-${groupId}`) * 1.25,
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.min(count, availableGroups.length))
    .map((entry) => entry.groupId);
}

function latestCompletedItem(exerciseId, workouts) {
  return getExerciseHistory(exerciseId, workouts, 1)[0]?.item || null;
}

function createPlanItem(exercise, intensity, workouts) {
  const config = INTENSITIES[intensity];
  const previous = latestCompletedItem(exercise.id, workouts);
  const previousSets = (previous?.sets || []).filter((set) => set.completed);
  const lastWeight = previousSets.find((set) => Number(set.weight) > 0)?.weight || 0;
  const sets = Math.min(4, Math.max(2, exercise.defaultSets + config.setAdjustment));
  const lastReps = previousSets.map((set) => Number(set.reps) || 0).filter(Boolean);
  const previousAverage = lastReps.length
    ? Math.round(lastReps.reduce((total, value) => total + value, 0) / lastReps.length)
    : null;
  const targetReps = exercise.type === "reps"
    ? Math.max(1, previousAverage ? Math.min(exercise.defaultReps + 2, previousAverage) : exercise.defaultReps)
    : null;

  return {
    id: createId("plan-item"),
    exerciseId: exercise.id,
    name: exercise.name,
    muscleGroup: exercise.muscleGroup,
    equipment: [...exercise.equipment],
    type: exercise.type,
    targetReps,
    targetSeconds: exercise.type === "time" ? exercise.defaultSeconds : null,
    plannedSets: sets,
    restSeconds: exercise.restSeconds,
    suggestedWeight: Number(lastWeight) || 0,
    previousSummary: previous ? formatSetSummary(previous) : null,
    progressionHint: previous
      ? "前回を基準に、余裕があれば1回だけ上乗せ"
      : "まずはフォームを崩さず基準回数を目安に",
  };
}

function chooseExerciseForGroup(groupId, candidates, workouts, nonce, excludedIds = []) {
  const excluded = new Set(excludedIds);
  return candidates
    .filter((exercise) => exercise.muscleGroup === groupId && !excluded.has(exercise.id))
    .map((exercise) => ({
      exercise,
      score:
        (exercise.foundation ? 4 : 0)
        - recentExercisePenalty(exercise, workouts)
        + hashNumber(`${nonce}-${exercise.id}`) * 2.5,
    }))
    .sort((a, b) => b.score - a.score)[0]?.exercise || null;
}

export function estimatePlanMinutes(items) {
  const seconds = items.reduce((total, item) => {
    const activePerSet = item.type === "time" ? item.targetSeconds : item.targetReps * 3.5;
    const restTotal = Math.max(0, item.plannedSets - 1) * item.restSeconds;
    // Include a small setup/changeover allowance so the estimate reflects real use.
    return total + activePerSet * item.plannedSets + restTotal + 80;
  }, 0);

  return Math.max(1, Math.round(seconds / 60));
}

export function generatePlan({ intensity, equipment, exercises, workouts, nonce = Date.now() }) {
  const config = INTENSITIES[intensity] || INTENSITIES.normal;
  const candidates = exercises.filter((exercise) => (
    isExerciseAvailable(exercise, equipment) && exercise.intensities.includes(config.id)
  ));

  if (candidates.length === 0) {
    return null;
  }

  const groups = chooseGroups(candidates, config.exerciseCount, workouts, nonce);
  const selected = [];

  groups.forEach((groupId) => {
    const exercise = chooseExerciseForGroup(
      groupId,
      candidates,
      workouts,
      nonce,
      selected.map((item) => item.id),
    );
    if (exercise) {
      selected.push(exercise);
    }
  });

  if (selected.length < config.exerciseCount) {
    candidates
      .filter((exercise) => !selected.some((item) => item.id === exercise.id))
      .sort((a, b) => (
        (b.foundation ? 1 : 0) - (a.foundation ? 1 : 0)
        || hashNumber(`${nonce}-${a.id}`) - hashNumber(`${nonce}-${b.id}`)
      ))
      .slice(0, config.exerciseCount - selected.length)
      .forEach((exercise) => selected.push(exercise));
  }

  const items = selected.map((exercise) => createPlanItem(exercise, config.id, workouts));

  return {
    id: createId("plan"),
    date: localDateKey(),
    generatedAt: new Date().toISOString(),
    intensity: config.id,
    nonce,
    estimatedMinutes: estimatePlanMinutes(items),
    items,
  };
}

export function replacePlanItem({ plan, itemIndex, equipment, exercises, workouts }) {
  const current = plan.items[itemIndex];
  if (!current) {
    return null;
  }

  const candidates = exercises.filter((exercise) => (
    isExerciseAvailable(exercise, equipment)
    && exercise.intensities.includes(plan.intensity)
    && exercise.muscleGroup === current.muscleGroup
  ));
  const usedIds = plan.items.map((item) => item.exerciseId);
  const replacement = chooseExerciseForGroup(
    current.muscleGroup,
    candidates,
    workouts,
    `${Date.now()}-${itemIndex}`,
    usedIds,
  );

  if (!replacement) {
    return null;
  }

  // Plan data is JSON-safe. Keep the clone compatible with older Safari versions.
  const nextPlan = JSON.parse(JSON.stringify(plan));
  nextPlan.items[itemIndex] = createPlanItem(replacement, plan.intensity, workouts);
  nextPlan.generatedAt = new Date().toISOString();
  nextPlan.estimatedMinutes = estimatePlanMinutes(nextPlan.items);
  return nextPlan;
}
