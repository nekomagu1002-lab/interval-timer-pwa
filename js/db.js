import { DEFAULT_EQUIPMENT, DEFAULT_EXERCISES, DEFAULT_SETTINGS } from "./data.js";

const DB_NAME = "myTrainingPwa";
const DB_VERSION = 1;
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

  const mergedSettings = { id: "preferences", ...DEFAULT_SETTINGS, ...existingSettings };
  await putOne("settings", mergedSettings);

  const [equipmentCount, exerciseCount] = await Promise.all([
    countStore("equipment"),
    countStore("exercises"),
  ]);

  if (equipmentCount === 0) {
    await putMany("equipment", DEFAULT_EQUIPMENT.map((item) => ({ ...item })));
  }
  if (exerciseCount === 0) {
    await putMany("exercises", DEFAULT_EXERCISES.map((item) => ({ ...item })));
  }
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

export async function countStore(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestToPromise(transaction.objectStore(storeName).count());
}

export async function putOne(storeName, value) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionToPromise(transaction);
  return value;
}

export async function putMany(storeName, values) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  values.forEach((value) => transaction.objectStore(storeName).put(value));
  await transactionToPromise(transaction);
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
