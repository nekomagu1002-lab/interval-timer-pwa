import test from "node:test";
import assert from "node:assert/strict";
import { historyRange, selectHistory, historyFile } from "../js/history-export.js";

const now = new Date(2026, 10, 12, 12);
const equipment = [{ id: "dumbbell", name: "ダンベル" }];
const item = { exerciseId: "curl", name: 'カール,"左右"\n交互', muscleGroup: "arms",
  equipment: ["dumbbell", "deleted-equipment"], type: "reps", restSeconds: 60,
  sets: [{ completed: true, weight: 7.5, reps: 10 }, { completed: false, weight: 7.5, reps: 9 },
    { completed: true, weight: 5, reps: 8 }] };
const workout = (date) => ({ id: `workout-${date}`, date, intensity: "normal", completedAt: `${date}T23:00:00Z`, items: [item] });

test("inclusive ranges use calendar days and reject invalid custom dates", () => {
  assert.deepEqual(historyRange({ period: "30" }, now), { start: "2026-10-14", end: "2026-11-12", error: "" });
  assert.equal(historyRange({ period: "90" }, now).start, "2026-08-15");
  for (const [start, end] of [["", ""], ["2026-02-30", "2026-11-12"], ["2026-11-13", "2026-11-12"]]) {
    assert.ok(historyRange({ period: "custom", start, end }, now).error);
  }
  const selection = selectHistory([workout("2026-10-13"), workout("2026-10-14"), workout("2026-11-12"), workout("2026-11-13")], equipment, { period: "30" }, now);
  assert.equal(selection.workoutCount, 2);
  assert.equal(selection.rows.length, 4);
});

test("completed sets retain actual weights, original set numbers, and no source mutations", () => {
  const workouts = [workout("2026-11-12")];
  const original = JSON.stringify(workouts);
  const selection = selectHistory(workouts, equipment, { period: "all" }, now);
  assert.deepEqual(selection.rows.map((row) => [row.setNumber, row.weightKg, row.reps, row.completedSets]), [[1, 7.5, 10, 2], [3, 5, 8, 2]]);
  assert.deepEqual(selection.rows[0].equipment, ["ダンベル", "deleted-equipment"]);
  assert.equal(selection.rows[0].date, "2026-11-12");
  assert.equal(JSON.stringify(workouts), original);
});

test("timed sets use recorded seconds, not planned targets; empty and active workouts are excluded", () => {
  const timed = { ...workout("2026-11-12"), items: [{ ...item, type: "time", targetSeconds: 60,
    sets: [{ completed: true, durationSeconds: 25 }, { completed: true }] }] };
  const selection = selectHistory([timed, { ...timed, completedAt: null }, { ...timed, items: [] }], equipment, { period: "all" }, now);
  assert.equal(selection.workoutCount, 1);
  assert.equal(selection.exerciseCount, 1);
  assert.deepEqual(selection.rows.map((row) => [row.durationSeconds, row.reps]), [[25, null], [null, null]]);
});

test("CSV has BOM, CRLF, escaped cells and formula protection; JSON is not a backup", () => {
  const selection = selectHistory([workout("2026-11-12")], equipment, { period: "custom", start: "2026-09-01", end: "2026-11-12" }, now);
  const csv = historyFile(selection, "csv", now);
  assert.equal(csv.name, "workout-history_2026-09-01_to_2026-11-12.csv");
  assert.deepEqual([...Buffer.from(csv.content).subarray(0, 3)], [239, 187, 191]);
  assert.ok(csv.content.includes('"カール,""左右""\n交互"'));
  assert.ok(csv.content.endsWith("\r\n"));
  selection.rows[0].exerciseName = "=1+1";
  assert.ok(historyFile(selection, "csv", now).content.includes('"\'=1+1"'));
  const json = JSON.parse(historyFile(selection, "json", now).content);
  assert.equal(json.app, "my-training-workout-history");
  assert.equal(json.records[0].exerciseName, "=1+1");
  assert.equal(json.setCount, 2);
  assert.equal(json.data, undefined);
  assert.throws(() => historyFile(selectHistory([], [], { period: "all" }, now), "csv", now));
});
