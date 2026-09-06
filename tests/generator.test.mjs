import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DEFAULT_EQUIPMENT, DEFAULT_EXERCISES } from "../js/data.js";
import { generatePlan, replacePlanItem } from "../js/generator.js";

const defaults = { equipment: DEFAULT_EQUIPMENT, exercises: DEFAULT_EXERCISES, workouts: [] };
const primary = ["legs", "chest", "back", "core"];
const ids = (plan) => plan.items.map((item) => item.exerciseId);
const newCount = (plan, previous) => ids(plan).filter((id) => !ids(previous).includes(id)).length;

test("normal and hard cover primary movements regardless of recent group load", () => {
  const workouts = Array.from({ length: 4 }, () => ({
    intensity: "normal", items: primary.map((muscleGroup) => ({ muscleGroup })),
  }));
  for (const intensity of ["normal", "hard"]) {
    for (let nonce = 0; nonce < 100; nonce += 1) {
      const plan = generatePlan({ ...defaults, workouts, intensity, nonce });
      assert.equal(plan.items.length, intensity === "normal" ? 5 : 6);
      for (const group of primary) assert.ok(plan.items.some((item) => item.muscleGroup === group));
      assert.equal(new Set(ids(plan)).size, plan.items.length);
    }
  }
});

test("hard regeneration changes one or two exercises while retaining the rest", () => {
  let previousPlan = generatePlan({ ...defaults, intensity: "hard", nonce: 0 });
  for (let nonce = 1; nonce <= 100; nonce += 1) {
    const plan = generatePlan({ ...defaults, intensity: "hard", nonce, previousPlan });
    assert.ok(newCount(plan, previousPlan) >= 1 && newCount(plan, previousPlan) <= 2);
    for (const group of primary) assert.ok(plan.items.some((item) => item.muscleGroup === group));
    previousPlan = plan;
  }
});

test("normal regeneration changes membership, and hard uses the latest hard history", () => {
  for (let nonce = 1; nonce <= 50; nonce += 1) {
    const previousPlan = generatePlan({ ...defaults, intensity: "normal", nonce });
    const next = generatePlan({ ...defaults, intensity: "normal", nonce, previousPlan });
    assert.ok(newCount(next, previousPlan) >= 1);
  }
  const previous = generatePlan({ ...defaults, intensity: "hard", nonce: 1 });
  const next = generatePlan({ ...defaults, intensity: "hard", nonce: 2, workouts: [previous] });
  assert.ok(newCount(next, previous) >= 1 && newCount(next, previous) <= 2);
});

test("restricted equipment, unavailable groups and exhausted replacements remain valid", () => {
  const equipment = DEFAULT_EQUIPMENT.map((item) => ({ ...item, enabled: item.id === "bodyweight" }));
  const plan = generatePlan({ ...defaults, equipment, intensity: "hard", nonce: 1 });
  assert.ok(plan.items.every((item) => item.equipment.every((id) => id === "bodyweight")));
  const exercises = primary.map((group) => DEFAULT_EXERCISES.find((item) => (
    item.muscleGroup === group && item.intensities.includes("hard")
  )));
  const limited = { ...defaults, exercises, intensity: "hard", nonce: 1 };
  const previousPlan = generatePlan(limited);
  const next = generatePlan({ ...limited, previousPlan });
  assert.equal(next.items.length, 4);
  assert.equal(new Set(ids(next)).size, 4);
  assert.equal(replacePlanItem({ ...defaults, exercises, plan: next, itemIndex: 0 }), null);
  assert.equal(generatePlan({ ...defaults, intensity: "hard", exercises: exercises.map((item) => ({
    ...item, apartmentSafe: false,
  })) }), null);
});

test("light selections and prescriptions match the pre-change generator", async () => {
  // Pin the previous committed implementation so this guards against accidental light-mode drift.
  const source = execFileSync("git", ["show", "71d4857:js/generator.js"], { encoding: "utf8" })
    .replace('"./data.js"', JSON.stringify(new URL("../js/data.js", import.meta.url).href));
  const previous = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const comparable = (plan) => ({
    minutes: plan.estimatedMinutes,
    items: plan.items.map(({ id, ...item }) => item),
  });
  for (let nonce = 0; nonce < 100; nonce += 1) {
    const options = { ...defaults, intensity: "light", nonce };
    assert.deepEqual(comparable(generatePlan(options)), comparable(previous.generatePlan(options)));
  }
});
