import { INTENSITIES, MUSCLE_GROUPS } from "./data.js";

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDay(date) === value;
}

export function historyRange(options, now = new Date()) {
  if (options.period === "all") return { start: "", end: "", error: "" };
  if (["30", "90"].includes(options.period)) {
    const start = new Date(now);
    start.setDate(start.getDate() - Number(options.period) + 1);
    return { start: localDay(start), end: localDay(now), error: "" };
  }
  if (!validDay(options.start) || !validDay(options.end)) {
    return { error: "開始日と終了日を入力してください。" };
  }
  if (options.start > options.end) return { error: "終了日は開始日以降にしてください。" };
  return { start: options.start, end: options.end, error: "" };
}

function workoutDay(workout) {
  if (validDay(workout.date)) return workout.date;
  const date = new Date(workout.startedAt || workout.completedAt);
  return Number.isNaN(date.getTime()) ? "" : localDay(date);
}

// A row represents an actually completed set, never a planned or unfinished set.
export function selectHistory(workouts, equipment, options, now = new Date()) {
  const range = historyRange(options, now);
  const result = { range, rows: [], workoutCount: 0, exerciseCount: 0 };
  if (range.error) return result;
  const names = new Map(equipment.map((item) => [item.id, item.name]));
  const ordered = workouts.map((workout) => ({ workout, date: workoutDay(workout) }))
    .filter(({ workout, date }) => workout.completedAt && date
      && (!range.start || date >= range.start) && (!range.end || date <= range.end))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const { workout, date } of ordered) {
    let recorded = false;
    for (const [itemIndex, item] of (workout.items || []).entries()) {
      const completed = (item.sets || []).filter((set) => set.completed);
      if (!completed.length) continue;
      recorded = true;
      result.exerciseCount += 1;
      (item.sets || []).forEach((set, index) => {
        if (!set.completed) return;
        result.rows.push({
          workoutId: workout.id, date, intensity: INTENSITIES[workout.intensity]?.label || workout.intensity || "",
          exerciseId: item.exerciseId || "", exerciseNumber: itemIndex + 1, exerciseName: item.name || "",
          muscleGroup: MUSCLE_GROUPS[item.muscleGroup]?.label || item.muscleGroup || "",
          equipment: (item.equipment || []).map((id) => names.get(id) || id),
          type: item.type === "time" ? "時間" : "回数", setNumber: index + 1,
          weightKg: set.weight ?? null, reps: item.type === "time" ? null : (set.reps ?? null),
          durationSeconds: item.type === "time" ? (set.durationSeconds ?? null) : null,
          restSeconds: item.restSeconds ?? null, completedSets: completed.length,
        });
      });
    }
    if (recorded) result.workoutCount += 1;
  }
  return result;
}

const columns = [
  ["実施日", "date"], ["強度", "intensity"], ["種目名", "exerciseName"], ["対象部位", "muscleGroup"],
  ["使用器具", "equipment"], ["記録方式", "type"], ["セット番号", "setNumber"], ["重量(kg)", "weightKg"],
  ["回数", "reps"], ["実施秒数", "durationSeconds"], ["設定休憩時間(秒)", "restSeconds"],
  ["実施セット数", "completedSets"], ["トレーニングID", "workoutId"], ["種目番号", "exerciseNumber"],
];

function csvCell(value) {
  let text = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  // Prevent user-entered names from being interpreted as spreadsheet formulas.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function historyFile(selection, format, now = new Date()) {
  const { range, rows } = selection;
  if (range.error || !rows.length) throw new Error(range.error || "対象の筋トレ記録がありません。");
  const suffix = range.start ? `${range.start}_to_${range.end}` : localDay(now);
  if (format === "csv") return {
    name: `workout-history_${suffix}.csv`, type: "text/csv;charset=utf-8",
    content: "\uFEFF" + [columns.map(([label]) => csvCell(label)).join(","),
      ...rows.map((row) => columns.map(([, key]) => csvCell(row[key])).join(","))].join("\r\n") + "\r\n",
  };
  return {
    name: `workout-history_${suffix}.json`, type: "application/json;charset=utf-8",
    content: JSON.stringify({ app: "my-training-workout-history", schemaVersion: 1,
      exportedAt: now.toISOString(), period: { start: range.start || null, end: range.end || null },
      workoutCount: selection.workoutCount, exerciseCount: selection.exerciseCount, setCount: rows.length,
      records: rows }, null, 2),
  };
}
