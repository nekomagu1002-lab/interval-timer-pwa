import {
  DEFAULT_EQUIPMENT,
  DEFAULT_EXERCISES,
  DEFAULT_SETTINGS,
  MASTER_DATA_VERSION,
} from "./data.js";

const DB_NAME = "myTrainingPwa";
const DB_VERSION = 1;
const HOME_PROFILE_MIGRATION_VERSION = 3;
const STORES = ["settings", "equipment", "exercises", "workouts", "appState"];

let databasePromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

export function openDatabase() {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("equipment")) {
        database.createObjectStore("equipment", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("exercises")) {
        const store = database.createObjectStore("exercises", { keyPath: "id" });
        store.createIndex("muscleGroup", "muscleGroup", { unique: false });
      }
      if (!database.objectStoreNames.contains("workouts")) {
        const store = database.createObjectStore("workouts", { keyPath: "id" });
        store.createIndex("completedAt", "completedAt", { unique: false });
      }
      if (!database.objectStoreNames.contains("appState")) {
        database.createObjectStore("appState", { keyPath: "key" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("データベースの更新がブロックされました。")));
  });

  return databasePromise;
}

export function planMasterDataSync(existingSettings, equipment, exercises) {
  const storedVersion = Math.max(0, Number(existingSettings?.seededVersion) || 0);
  const shouldSync = storedVersion < MASTER_DATA_VERSION
    || equipment.length === 0
    || exercises.length === 0;
  const equipmentIds = new Set(equipment.map((item) => item.id));
  const exerciseIds = new Set(exercises.map((item) => item.id));
  const equipmentDefaults = new Map(DEFAULT_EQUIPMENT.map((item) => [item.id, item]));
  const exerciseDefaults = new Map(DEFAULT_EXERCISES.map((item) => [item.id, item]));
  const shouldApplyHomeProfile = storedVersion < HOME_PROFILE_MIGRATION_VERSION;

  const updatedEquipment = shouldApplyHomeProfile
    ? equipment
      .filter((item) => item.builtIn && equipmentDefaults.has(item.id))
      .map((item) => ({ ...item, ...equipmentDefaults.get(item.id), enabled: item.enabled }))
      .filter((item) => JSON.stringify(item) !== JSON.stringify(equipment.find((current) => current.id === item.id)))
    : [];
  const updatedExercises = shouldApplyHomeProfile
    ? exercises
      .map((item) => {
        if (item.builtIn && exerciseDefaults.has(item.id)) {
          return { ...item, ...exerciseDefaults.get(item.id), enabled: item.enabled };
        }
        // Unknown legacy custom exercises are kept, but excluded until their apartment safety is explicit.
        return item.apartmentSafe === undefined ? { ...item, apartmentSafe: false } : item;
      })
      .filter((item) => JSON.stringify(item) !== JSON.stringify(exercises.find((current) => current.id === item.id)))
    : [];

  return {
    settings: {
      id: "preferences",
      ...DEFAULT_SETTINGS,
      ...existingSettings,
      seededVersion: Math.max(storedVersion, MASTER_DATA_VERSION),
    },
    missingEquipment: shouldSync
      ? DEFAULT_EQUIPMENT.filter((item) => !equipmentIds.has(item.id)).map((item) => ({ ...item }))
      : [],
    missingExercises: shouldSync
      ? DEFAULT_EXERCISES.filter((item) => !exerciseIds.has(item.id)).map((item) => ({ ...item }))
      : [],
    updatedEquipment,
    updatedExercises,
  };
}

export async function initializeDatabase() {
  const database = await openDatabase();
  const existingSettings = await getOne("settings", "preferences");

  if (!existingSettings) {
    const transaction = database.transaction(["settings", "equipment", "exercises"], "readwrite");
    transaction.objectStore("settings").put({ id: "preferences", ...DEFAULT_SETTINGS });
    DEFAULT_EQUIPMENT.forEach((item) => transaction.objectStore("equipment").put({ ...item }));
    DEFAULT_EXERCISES.forEach((item) => transaction.objectStore("exercises").put({ ...item }));
    await transactionToPromise(transaction);
    return;
  }

  const [equipment, exercises] = await Promise.all([
    getAll("equipment"),
    getAll("exercises"),
  ]);
  const syncPlan = planMasterDataSync(existingSettings, equipment, exercises);
  const hasMasterDataChanges = [
    syncPlan.missingEquipment,
    syncPlan.missingExercises,
    syncPlan.updatedEquipment,
    syncPlan.updatedExercises,
  ].some((items) => items.length > 0);

  if (!hasMasterDataChanges) {
    await putOne("settings", syncPlan.settings);
    return;
  }

  // Add unknown IDs and apply narrowly versioned profile updates. User ON/OFF and custom fields are preserved.
  const transaction = database.transaction(["settings", "equipment", "exercises"], "readwrite");
  transaction.objectStore("settings").put(syncPlan.settings);
  syncPlan.missingEquipment.forEach((item) => transaction.objectStore("equipment").put(item));
  syncPlan.missingExercises.forEach((item) => transaction.objectStore("exercises").put(item));
  syncPlan.updatedEquipment.forEach((item) => transaction.objectStore("equipment").put(item));
  syncPlan.updatedExercises.forEach((item) => transaction.objectStore("exercises").put(item));
  await transactionToPromise(transaction);
}

export async function getOne(storeName, key) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).get(key));
}

export async function getAll(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).getAll());
}

export async function putOne(storeName, value) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionToPromise(transaction);
  return value;
}

export async function deleteOne(storeName, key) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionToPromise(transaction);
}

export async function loadAppData() {
  const [settings, equipment, exercises, workouts, appState] = await Promise.all([
    getOne("settings", "preferences"),
    getAll("equipment"),
    getAll("exercises"),
    getAll("workouts"),
    getAll("appState"),
  ]);

  return {
    settings: { id: "preferences", ...DEFAULT_SETTINGS, ...settings },
    equipment,
    exercises,
    workouts: workouts.sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
    appState: Object.fromEntries(appState.map((item) => [item.key, item.value])),
  };
}

export async function saveAppState(key, value) {
  if (value === null || value === undefined) {
    await deleteOne("appState", key);
    return;
  }

  await putOne("appState", { key, value });
}

export async function dumpDatabase() {
  const [settings, equipment, exercises, workouts, appState] = await Promise.all(
    STORES.map((storeName) => getAll(storeName)),
  );

  return { settings, equipment, exercises, workouts, appState };
}

export async function replaceDatabase(data) {
  const database = await openDatabase();
  const transaction = database.transaction(STORES, "readwrite");

  STORES.forEach((storeName) => {
    const store = transaction.objectStore(storeName);
    store.clear();
    data[storeName].forEach((value) => store.put(value));
  });

  await transactionToPromise(transaction);
}
