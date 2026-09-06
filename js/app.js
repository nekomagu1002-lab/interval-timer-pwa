import { SoundManager, TONE_LABELS, VOLUME_LABELS } from "./audio.js";
import {
  deleteOne,
  dumpDatabase,
  initializeDatabase,
  loadAppData,
  putOne,
  replaceDatabase,
  saveAppState,
} from "./db.js";
import {
  APP_VERSION,
  DEFAULT_SETTINGS,
  INTENSITIES,
  MUSCLE_GROUPS,
  createId,
  findExercisesUsingEquipment,
} from "./data.js";
import {
  formatSetSummary,
  generatePlan,
  getExerciseHistory,
  isExerciseAvailable,
  replacePlanItem,
} from "./generator.js";
import { PreciseCountdown, formatDuration } from "./timer.js";

const VALID_ROUTES = new Set([
  "home",
  "today",
  "workout",
  "history",
  "exercises",
  "equipment",
  "timer",
  "settings",
]);

const elements = {
  view: document.querySelector("#app-view"),
  todayLabel: document.querySelector("#today-label"),
  sessionTimer: document.querySelector("#session-timer"),
  sessionTimerLabel: document.querySelector("#session-timer-label"),
  sessionTimerValue: document.querySelector("#session-timer-value"),
  toast: document.querySelector("#toast"),
  importFile: document.querySelector("#import-file"),
};

const state = {
  initialized: false,
  route: getRoute(),
  settings: { id: "preferences", ...DEFAULT_SETTINGS },
  equipment: [],
  exercises: [],
  workouts: [],
  draftPlan: null,
  activeWorkout: null,
  exerciseFilter: "all",
  sessionContext: null,
  sessionLastSecond: null,
  interval: {
    phase: "idle",
    pausedPhase: null,
    currentSet: 1,
    lastSecond: null,
  },
  wakeLockSentinel: null,
  wakeLockSupported: "wakeLock" in navigator,
  wakeLockFailed: false,
  wakeLockPending: false,
  toastTimer: null,
};

const sound = new SoundManager(() => state.settings);

const sessionCountdown = new PreciseCountdown({
  onTick: ({ seconds }) => {
    elements.sessionTimerValue.textContent = formatDuration(seconds);
    if (seconds <= 3 && seconds > 0 && seconds !== state.sessionLastSecond) {
      state.sessionLastSecond = seconds;
      sound.play("countdown");
    }
  },
  onComplete: () => handleSessionTimerComplete(),
  onStateChange: () => {
    renderSessionTimer();
    syncWakeLock();
  },
});

const intervalCountdown = new PreciseCountdown({
  onTick: ({ seconds }) => {
    const display = document.querySelector("#interval-time");
    if (display) {
      display.textContent = formatDuration(seconds);
    }
    if (seconds <= 3 && seconds > 0 && seconds !== state.interval.lastSecond) {
      state.interval.lastSecond = seconds;
      sound.play("countdown");
    }
  },
  onComplete: () => advanceInterval(),
  onStateChange: () => syncWakeLock(),
});

function getRoute() {
  const route = window.location.hash.replace(/^#\/?/, "").split("?")[0] || "home";
  return VALID_ROUTES.has(route) ? route : "home";
}

function navigate(route) {
  const safeRoute = VALID_ROUTES.has(route) ? route : "home";
  if (getRoute() === safeRoute) {
    state.route = safeRoute;
    render();
    return;
  }
  window.location.hash = `#/${safeRoute}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value, options = {}) {
  if (!value) {
    return "日時不明";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    weekday: "short",
    ...options,
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatWeight(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function equipmentName(id) {
  return state.equipment.find((item) => item.id === id)?.name || id;
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

async function initialize() {
  try {
    await initializeDatabase();
    const data = await loadAppData();
    state.settings = data.settings;
    state.equipment = data.equipment;
    state.exercises = data.exercises;
    state.workouts = data.workouts;
    state.draftPlan = data.appState.draftPlan || null;
    state.activeWorkout = data.appState.activeWorkout || null;
    state.initialized = true;
    elements.todayLabel.textContent = new Intl.DateTimeFormat("ja-JP", {
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(new Date());
    render();
  } catch (error) {
    console.error("App initialization failed:", error);
    elements.view.innerHTML = `
      <section class="empty-state">
        <span class="empty-state__icon">!</span>
        <h1>データを開けませんでした</h1>
        <p>Safariのプライベートブラウズ設定や空き容量を確認して、ページを再読み込みしてください。</p>
        <button class="primary-button" type="button" data-action="reload">再読み込み</button>
      </section>
    `;
  }
}

function render() {
  if (!state.initialized) {
    return;
  }

  document.querySelectorAll("[data-route]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.route === state.route);
  });

  const views = {
    home: renderHome,
    today: renderToday,
    workout: renderWorkout,
    history: renderHistory,
    exercises: renderExercises,
    equipment: renderEquipment,
    timer: renderIntervalTimer,
    settings: renderSettings,
  };

  elements.view.innerHTML = views[state.route]();
  elements.view.focus({ preventScroll: true });
  renderSessionTimer();
  syncWakeLock();
}

function pageHeader(eyebrow, title, description = "") {
  return `
    <header class="page-header">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1>${escapeHtml(title)}</h1>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
    </header>
  `;
}

function renderHome() {
  const enabledEquipment = state.equipment.filter((item) => item.enabled);
  const lastWorkout = state.workouts[0];
  const recentGroups = [...new Set(
    state.workouts.slice(0, 3).flatMap((workout) => workout.items?.map((item) => item.muscleGroup) || []),
  )].slice(0, 4);

  return `
    <section class="home-view">
      ${state.activeWorkout ? `
        <button class="resume-card" type="button" data-route="workout">
          <span><small>進行中のトレーニング</small><strong>${escapeHtml(INTENSITIES[state.activeWorkout.intensity]?.label || "トレーニング")}</strong></span>
          <span>続きから →</span>
        </button>
      ` : ""}

      ${pageHeader("TODAY'S WORKOUT", "今日はどれくらいやる？", "体調と予定に近いものを選ぶだけで、今日のメニューを作ります。")}

      <div class="intensity-grid">
        ${Object.values(INTENSITIES).map((item) => `
          <button class="intensity-card intensity-card--${item.accent}" type="button" data-action="generate-plan" data-intensity="${item.id}">
            <span class="intensity-card__signal" aria-hidden="true">${item.id === "light" ? "●" : item.id === "normal" ? "●●" : "●●●"}</span>
            <strong>${item.label}</strong>
            <span>${item.durationLabel}</span>
            <small>${item.subtitle}</small>
          </button>
        `).join("")}
      </div>

      <div class="dashboard-grid">
        <article class="summary-card">
          <span class="summary-card__label">使用できる器具</span>
          <strong>${enabledEquipment.length}<small>種類</small></strong>
          <button type="button" data-route="equipment">設定を見る</button>
        </article>
        <article class="summary-card">
          <span class="summary-card__label">前回のトレーニング</span>
          <strong class="summary-card__text">${lastWorkout ? escapeHtml(formatDate(lastWorkout.completedAt)) : "まだ記録なし"}</strong>
          <span>${lastWorkout ? `${lastWorkout.items.length}種目・${INTENSITIES[lastWorkout.intensity]?.label}` : "最初のメニューを作りましょう"}</span>
        </article>
      </div>

      ${recentGroups.length ? `
        <section class="section-block compact-section">
          <div class="section-heading"><div><p class="eyebrow">RECENT</p><h2>最近使った部位</h2></div></div>
          <div class="chip-row">
            ${recentGroups.map((id) => `<span class="muscle-chip" style="--chip-color:${MUSCLE_GROUPS[id]?.color}">${MUSCLE_GROUPS[id]?.label}</span>`).join("")}
          </div>
        </section>
      ` : ""}

      <section class="section-block">
        <div class="section-heading"><div><p class="eyebrow">TOOLS</p><h2>管理とツール</h2></div></div>
        <div class="quick-links">
          <button type="button" data-route="exercises"><span>◆</span><strong>種目</strong><small>${state.exercises.filter((item) => item.enabled).length}件が有効</small></button>
          <button type="button" data-route="equipment"><span>⌁</span><strong>器具</strong><small>使える器具を変更</small></button>
          <button type="button" data-route="timer"><span>◴</span><strong>タイマー</strong><small>HIIT・ストレッチ</small></button>
        </div>
      </section>
    </section>
  `;
}

function renderToday() {
  if (!state.draftPlan) {
    return `
      ${pageHeader("TODAY", "今日のトレーニング")}
      <section class="empty-state">
        <span class="empty-state__icon">▤</span>
        <h2>メニューはまだありません</h2>
        <p>HOMEで今日の運動量を選ぶと、使用できる器具と最近の記録から提案します。</p>
        <button class="primary-button" type="button" data-route="home">運動量を選ぶ</button>
      </section>
    `;
  }

  const config = INTENSITIES[state.draftPlan.intensity];
  return `
    <section>
      <div class="plan-hero">
        <div>
          <p class="eyebrow">TODAY'S PLAN</p>
          <div class="plan-hero__title"><h1>${config.label}メニュー</h1><span>${state.draftPlan.estimatedMinutes}分目安</span></div>
          <p>${state.draftPlan.items.length}種目。直近の部位と種目を避けつつ、基本種目は継続しています。</p>
        </div>
        <button class="icon-button" type="button" data-action="regenerate-plan" aria-label="メニューを再生成">↻</button>
      </div>

      <ol class="plan-list">
        ${state.draftPlan.items.map((item, index) => renderPlanItem(item, index)).join("")}
      </ol>

      <div class="sticky-action">
        <button class="primary-button primary-button--large" type="button" data-action="start-workout">
          トレーニングを開始 <span>→</span>
        </button>
      </div>
    </section>
  `;
}

function renderPlanItem(item, index) {
  const group = MUSCLE_GROUPS[item.muscleGroup];
  const target = item.type === "time" ? `${item.targetSeconds}秒` : `${item.targetReps}回`;
  return `
    <li class="plan-item">
      <span class="plan-item__number">${String(index + 1).padStart(2, "0")}</span>
      <div class="plan-item__main">
        <div class="plan-item__title">
          <span class="muscle-dot" style="--dot-color:${group.color}"></span>
          <div><small>${group.label}</small><h2>${escapeHtml(item.name)}</h2></div>
        </div>
        <div class="plan-item__prescription">
          <strong>${item.plannedSets}</strong><span>セット</span><i>×</i><strong>${target}</strong><span>休憩 ${item.restSeconds}秒</span>
        </div>
        <p class="plan-item__equipment">${item.equipment.map(equipmentName).map(escapeHtml).join("・")}</p>
        <p class="plan-item__history">${item.previousSummary ? `前回 ${escapeHtml(item.previousSummary)}` : "初回の種目"}</p>
      </div>
      <button class="swap-button" type="button" data-action="replace-exercise" data-index="${index}">入替</button>
    </li>
  `;
}

function renderWorkout() {
  if (!state.activeWorkout) {
    return `
      ${pageHeader("WORKOUT", "トレーニング実行")}
      <section class="empty-state"><span class="empty-state__icon">▶</span><h2>進行中のトレーニングはありません</h2><p>今日のメニューを作成して開始してください。</p><button class="primary-button" type="button" data-route="today">今日のメニューへ</button></section>
    `;
  }

  const workout = state.activeWorkout;
  const index = Math.min(workout.currentExerciseIndex || 0, workout.items.length - 1);
  const item = workout.items[index];
  const group = MUSCLE_GROUPS[item.muscleGroup];
  const histories = getExerciseHistory(item.exerciseId, state.workouts, 3);
  const completed = workout.items.reduce((total, entry) => total + entry.sets.filter((set) => set.completed).length, 0);
  const total = workout.items.reduce((sum, entry) => sum + entry.sets.length, 0);

  return `
    <section class="workout-view">
      <header class="workout-progress">
        <div><span>${index + 1} / ${workout.items.length} 種目</span><strong>${completed} / ${total} セット完了</strong></div>
        <div class="progress-track"><span style="width:${total ? (completed / total) * 100 : 0}%"></span></div>
      </header>

      <article class="current-exercise" style="--group-color:${group.color}">
        <span class="muscle-chip">${group.label}</span>
        <h1>${escapeHtml(item.name)}</h1>
        <p>${item.type === "time" ? `${item.targetSeconds}秒キープ` : `${item.targetReps}回を目安`} ・ セット間休憩 ${item.restSeconds}秒</p>
        <small>${escapeHtml(item.progressionHint)}</small>
      </article>

      ${histories.length ? `
        <details class="previous-records">
          <summary>直近の記録を見る <span>${escapeHtml(formatSetSummary(histories[0].item))}</span></summary>
          <div>${histories.map((history, historyIndex) => `<p><span>${historyIndex === 0 ? "前回" : `${historyIndex + 1}回前`}・${formatDate(history.completedAt)}</span><strong>${escapeHtml(formatSetSummary(history.item))}</strong></p>`).join("")}</div>
        </details>
      ` : `<p class="first-record-note">この種目は初回です。無理のない値から始めましょう。</p>`}

      ${item.type === "reps" ? renderWeightShortcuts(item, index) : ""}

      <div class="set-list">
        ${item.sets.map((set, setIndex) => renderSetRow(item, index, set, setIndex)).join("")}
      </div>

      <div class="exercise-navigation">
        <button type="button" data-action="change-exercise-index" data-delta="-1" ${index === 0 ? "disabled" : ""}>← 前の種目</button>
        <button type="button" data-action="change-exercise-index" data-delta="1" ${index === workout.items.length - 1 ? "disabled" : ""}>次の種目 →</button>
      </div>

      <button class="finish-button" type="button" data-action="finish-workout">トレーニングを終了して保存</button>
    </section>
  `;
}

function renderWeightShortcuts(item, itemIndex) {
  const choices = new Map();
  const addChoice = (value, label, kind = "common") => {
    const weight = Number(value);
    if (!(weight > 0)) {
      return;
    }
    const key = String(weight);
    const existing = choices.get(key);
    choices.set(key, {
      weight,
      kind: existing?.kind === "previous" ? "previous" : kind,
      labels: [...(existing?.labels || []), label],
    });
  };

  addChoice(item.previousWeight, "前回", "previous");
  (item.commonWeights || []).forEach((weight) => addChoice(weight, "よく使う"));
  (item.highLoadWeights || []).forEach((weight) => addChoice(weight, "高負荷", "high"));

  if (choices.size === 0) {
    return "";
  }

  return `
    <div class="weight-shortcuts" aria-label="重量の候補">
      <span>重量をまとめて入力</span>
      <div>${[...choices.values()].map((choice) => `
        <button type="button" class="weight-shortcut weight-shortcut--${choice.kind}" data-action="apply-weight-preset" data-item-index="${itemIndex}" data-weight="${choice.weight}">
          <small>${choice.labels.join("・")}</small><strong>${formatWeight(choice.weight)}kg</strong>
        </button>
      `).join("")}</div>
    </div>
  `;
}

function renderSetRow(item, itemIndex, set, setIndex) {
  if (item.type === "time") {
    const timerActive = state.sessionContext?.kind === "work"
      && state.sessionContext.itemIndex === itemIndex
      && state.sessionContext.setIndex === setIndex;
    return `
      <article class="set-row ${set.completed ? "is-complete" : ""}">
        <span class="set-row__number">${setIndex + 1}</span>
        <div class="set-row__time"><strong>${set.durationSeconds || item.targetSeconds}</strong><span>秒</span></div>
        <button class="set-timer-button" type="button" data-action="start-set-timer" data-item-index="${itemIndex}" data-set-index="${setIndex}" ${set.completed || timerActive ? "disabled" : ""}>${timerActive ? "計測中" : "タイマー開始"}</button>
        <button class="complete-set-button ${set.completed ? "is-complete" : ""}" type="button" data-action="toggle-set-complete" data-item-index="${itemIndex}" data-set-index="${setIndex}">${set.completed ? "✓ 完了" : "完了"}</button>
      </article>
    `;
  }

  const weightStep = Number(item.weightRange?.step) || 0.5;
  return `
    <article class="set-row ${set.completed ? "is-complete" : ""}">
      <span class="set-row__number">${setIndex + 1}</span>
      <div class="record-stepper">
        <span>重量</span>
        <div><button type="button" data-action="adjust-record" data-item-index="${itemIndex}" data-set-index="${setIndex}" data-field="weight" data-delta="-${weightStep}" ${set.completed ? "disabled" : ""}>−</button><strong>${formatWeight(set.weight)}</strong><small>kg</small><button type="button" data-action="adjust-record" data-item-index="${itemIndex}" data-set-index="${setIndex}" data-field="weight" data-delta="${weightStep}" ${set.completed ? "disabled" : ""}>＋</button></div>
      </div>
      <div class="record-stepper">
        <span>回数</span>
        <div><button type="button" data-action="adjust-record" data-item-index="${itemIndex}" data-set-index="${setIndex}" data-field="reps" data-delta="-1" ${set.completed ? "disabled" : ""}>−</button><strong>${set.reps}</strong><small>回</small><button type="button" data-action="adjust-record" data-item-index="${itemIndex}" data-set-index="${setIndex}" data-field="reps" data-delta="1" ${set.completed ? "disabled" : ""}>＋</button></div>
      </div>
      <button class="complete-set-button ${set.completed ? "is-complete" : ""}" type="button" data-action="toggle-set-complete" data-item-index="${itemIndex}" data-set-index="${setIndex}">${set.completed ? "✓" : "完了"}</button>
    </article>
  `;
}

function renderHistory() {
  return `
    <section>
      ${pageHeader("HISTORY", "トレーニング履歴", "端末内に保存した記録です。新しいものから表示します。")}
      ${state.workouts.length ? `
        <div class="history-list">
          ${state.workouts.map((workout) => {
            const totalSets = workout.items.reduce((sum, item) => sum + item.sets.filter((set) => set.completed).length, 0);
            return `
              <details class="history-card">
                <summary>
                  <span class="history-card__date"><strong>${formatDate(workout.completedAt)}</strong><small>${formatTime(workout.completedAt)}</small></span>
                  <span class="intensity-badge intensity-badge--${workout.intensity}">${INTENSITIES[workout.intensity]?.label || "記録"}</span>
                  <span class="history-card__summary">${workout.items.length}種目・${totalSets}セット</span>
                  <span class="history-card__chevron">⌄</span>
                </summary>
                <div class="history-card__body">
                  ${workout.items.map((item) => `
                    <div><span><i style="background:${MUSCLE_GROUPS[item.muscleGroup]?.color}"></i>${escapeHtml(item.name)}</span><strong>${escapeHtml(formatSetSummary(item))}</strong></div>
                  `).join("")}
                </div>
              </details>
            `;
          }).join("")}
        </div>
      ` : `<section class="empty-state"><span class="empty-state__icon">◷</span><h2>履歴はまだありません</h2><p>トレーニングを終了すると、重量・回数・セットがここへ保存されます。</p><button class="primary-button" type="button" data-route="home">今日のメニューを作る</button></section>`}
    </section>
  `;
}

function renderExercises() {
  const filtered = state.exercises.filter((exercise) => (
    state.exerciseFilter === "all" || exercise.muscleGroup === state.exerciseFilter
  ));
  return `
    <section>
      ${pageHeader("EXERCISES", "種目", "提案に使う種目をON/OFFできます。自分用の種目も追加できます。")}
      <div class="filter-scroll">
        <button class="filter-chip ${state.exerciseFilter === "all" ? "is-active" : ""}" type="button" data-action="filter-exercises" data-group="all">すべて</button>
        ${Object.entries(MUSCLE_GROUPS).map(([id, group]) => `<button class="filter-chip ${state.exerciseFilter === id ? "is-active" : ""}" type="button" data-action="filter-exercises" data-group="${id}">${group.label}</button>`).join("")}
      </div>
      <div class="catalog-list">
        ${filtered.map((exercise) => {
          const histories = getExerciseHistory(exercise.id, state.workouts, 5);
          return `
            <article class="catalog-card ${exercise.enabled ? "" : "is-disabled"}">
              <span class="muscle-dot" style="--dot-color:${MUSCLE_GROUPS[exercise.muscleGroup]?.color}"></span>
              <div><small>${MUSCLE_GROUPS[exercise.muscleGroup]?.label}・${exercise.type === "time" ? `${exercise.defaultSeconds}秒` : `${exercise.defaultReps}回`}・${exercise.defaultSets}セット</small><h2>${escapeHtml(exercise.name)}</h2><p>${exercise.equipment.map(equipmentName).map(escapeHtml).join("・")} / 休憩${exercise.restSeconds}秒 / ${(exercise.intensities || []).map((id) => INTENSITIES[id]?.label).filter(Boolean).join("・")} / ${exercise.apartmentSafe === true ? "集合住宅OK" : "提案対象外"}</p></div>
              <button class="toggle-button ${exercise.enabled ? "is-on" : ""}" type="button" data-action="toggle-exercise" data-id="${escapeHtml(exercise.id)}" aria-pressed="${exercise.enabled}">${exercise.enabled ? "ON" : "OFF"}</button>
              ${exercise.builtIn ? "" : `<button class="delete-button" type="button" data-action="delete-exercise" data-id="${escapeHtml(exercise.id)}" aria-label="${escapeHtml(exercise.name)}を削除">×</button>`}
              ${histories.length ? `
                <details class="catalog-history">
                  <summary>直近${histories.length}回の記録</summary>
                  <div>${histories.map(({ completedAt, item }) => `<p><span>${formatDate(completedAt)}</span><strong>${escapeHtml(formatSetSummary(item))}</strong></p>`).join("")}</div>
                </details>
              ` : ""}
            </article>
          `;
        }).join("")}
      </div>
      ${renderExerciseForm()}
    </section>
  `;
}

function renderExerciseForm() {
  const hasBodyweight = state.equipment.some((item) => item.id === "bodyweight");
  return `
    <details class="add-panel">
      <summary>＋ 自分用の種目を追加</summary>
      <form id="exercise-form" class="form-grid">
        <label class="field field--wide"><span>種目名</span><input name="name" required maxlength="40" placeholder="例：ブルガリアンスクワット"></label>
        <label class="field"><span>対象部位</span><select name="muscleGroup">${Object.entries(MUSCLE_GROUPS).map(([id, group]) => `<option value="${id}">${group.label}</option>`).join("")}</select></label>
        <label class="field"><span>種類</span><select name="type"><option value="reps">回数</option><option value="time">時間</option></select></label>
        <fieldset class="choice-field field--wide" data-choice-group="equipment">
          <legend>必要器具 <small>複数選択可</small></legend>
          <div class="choice-grid">
            ${state.equipment.map((item, index) => `
              <label class="choice-chip">
                <input type="checkbox" name="equipment" value="${escapeHtml(item.id)}" ${(item.id === "bodyweight" || (!hasBodyweight && index === 0)) ? "checked" : ""}>
                <span>${escapeHtml(item.name)}</span>
              </label>
            `).join("")}
          </div>
          <p class="choice-error" data-choice-error="equipment" role="alert" hidden>必要器具を1つ以上選択してください。</p>
        </fieldset>
        <fieldset class="choice-field field--wide" data-choice-group="intensities">
          <legend>対応強度 <small>複数選択可</small></legend>
          <div class="choice-grid choice-grid--three">
            ${Object.values(INTENSITIES).map((item) => `
              <label class="choice-chip choice-chip--${item.accent}">
                <input type="checkbox" name="intensities" value="${item.id}" checked>
                <span>${item.label}</span>
              </label>
            `).join("")}
          </div>
          <p class="choice-error" data-choice-error="intensities" role="alert" hidden>対応強度を1つ以上選択してください。</p>
        </fieldset>
        <label class="choice-chip field--wide safety-choice">
          <input type="checkbox" name="apartmentSafe" checked>
          <span>集合住宅で静かに実施できる種目</span>
        </label>
        <label class="field"><span>基準回数／秒</span><input name="target" type="number" inputmode="numeric" min="1" max="999" value="10" required></label>
        <label class="field"><span>標準セット</span><input name="sets" type="number" inputmode="numeric" min="2" max="4" value="3" required></label>
        <label class="field"><span>休憩（秒）</span><input name="rest" type="number" inputmode="numeric" min="0" max="600" step="5" value="60" required></label>
        <button class="primary-button field--wide" type="submit">種目を追加</button>
      </form>
    </details>
  `;
}

function renderEquipment() {
  return `
    <section>
      ${pageHeader("EQUIPMENT", "使用器具", "ONになっている器具だけで、今日のメニューを作ります。")}
      <div class="equipment-list">
        ${state.equipment.map((item) => `
          <article class="equipment-card ${item.enabled ? "is-enabled" : ""}">
            <span class="equipment-card__icon">${item.id === "bodyweight" ? "人" : "＋"}</span>
            <div><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.description ? `${item.description}・${item.enabled ? "使用中" : "現在OFF"}` : (item.enabled ? "メニュー生成に使用" : "現在は使用しない"))}</p></div>
            <button class="switch" type="button" data-action="toggle-equipment" data-id="${escapeHtml(item.id)}" aria-pressed="${item.enabled}"><span></span></button>
            ${item.builtIn ? "" : `<button class="delete-button" type="button" data-action="delete-equipment" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)}を削除">×</button>`}
          </article>
        `).join("")}
      </div>
      <form id="equipment-form" class="inline-form">
        <label class="field"><span>器具を追加</span><input name="name" required maxlength="30" placeholder="例：ケトルベル"></label>
        <button class="secondary-button" type="submit">追加</button>
      </form>
      <p class="helper-text">追加した器具は削除できます。既定の器具はOFFにして候補から外せます。</p>
    </section>
  `;
}

function renderIntervalTimer() {
  const phaseLabels = { idle: "待機中", work: "運動中", rest: "休憩中", paused: "一時停止中", complete: "完了" };
  const displaySeconds = state.interval.phase === "idle"
    ? state.settings.intervalWorkSeconds
    : state.interval.phase === "complete"
      ? 0
      : Math.ceil(intervalCountdown.remainingMs / 1000);
  const locked = ["work", "rest", "paused"].includes(state.interval.phase);
  return `
    <section class="timer-view" data-phase="${state.interval.phase === "paused" ? state.interval.pausedPhase : state.interval.phase}">
      ${pageHeader("INTERVAL TIMER", "インターバルタイマー", "HIIT、プランク、ストレッチなどに。")}
      <article class="interval-display">
        <span id="interval-status">${phaseLabels[state.interval.phase]}</span>
        <strong id="interval-time">${formatDuration(displaySeconds)}</strong>
        <p>${state.interval.currentSet} / ${state.settings.intervalSets} セット目</p>
      </article>
      <div class="timer-settings">
        ${renderTimerSetting("運動", "intervalWorkSeconds", state.settings.intervalWorkSeconds, 5, "秒", locked)}
        ${renderTimerSetting("休憩", "intervalRestSeconds", state.settings.intervalRestSeconds, 5, "秒", locked)}
        ${renderTimerSetting("セット", "intervalSets", state.settings.intervalSets, 1, "回", locked)}
      </div>
      <div class="timer-controls">
        <button class="primary-button" type="button" data-action="interval-start" ${locked ? "disabled" : ""}>${state.interval.phase === "complete" ? "もう一度" : "開始"}</button>
        <button class="secondary-button" type="button" data-action="interval-toggle" ${locked ? "" : "disabled"}>${state.interval.phase === "paused" ? "再開" : "一時停止"}</button>
        <button class="text-button" type="button" data-action="interval-reset">リセット</button>
      </div>
      <button class="sound-link" type="button" data-route="settings">音量 ${VOLUME_LABELS[state.settings.volume]} ・ ${TONE_LABELS[state.settings.tone]} <span>設定 →</span></button>
      <p class="wake-note" id="wake-note">${wakeLockMessage()}</p>
    </section>
  `;
}

function renderTimerSetting(label, key, value, step, unit, locked) {
  return `
    <div><span><strong>${label}</strong><small>${unit}</small></span><div><button type="button" data-action="adjust-interval-setting" data-key="${key}" data-delta="-${step}" ${locked ? "disabled" : ""}>−</button><output>${value}</output><button type="button" data-action="adjust-interval-setting" data-key="${key}" data-delta="${step}" ${locked ? "disabled" : ""}>＋</button></div></div>
  `;
}

function renderSettings() {
  const soundLocked = ["work", "rest", "paused"].includes(state.interval.phase)
    || ["running", "paused"].includes(sessionCountdown.status);
  return `
    <section>
      ${pageHeader("SETTINGS", "設定", "通知音と端末内データを管理します。")}
      <section class="settings-card">
        <div class="settings-card__heading"><div><p class="eyebrow">SOUND</p><h2>通知音</h2></div><button class="preview-sound" type="button" data-action="preview-sound" ${soundLocked ? "disabled" : ""}>試聴</button></div>
        <div class="option-group"><span>音量</span><div class="segmented segmented--four">${Object.entries(VOLUME_LABELS).map(([id, label]) => `<button type="button" data-action="set-sound" data-key="volume" data-value="${id}" class="${state.settings.volume === id ? "is-selected" : ""}" ${soundLocked ? "disabled" : ""}>${label}</button>`).join("")}</div></div>
        <div class="option-group"><span>音色</span><div class="segmented segmented--three">${Object.entries(TONE_LABELS).map(([id, label]) => `<button type="button" data-action="set-sound" data-key="tone" data-value="${id}" class="${state.settings.tone === id ? "is-selected" : ""}" ${soundLocked ? "disabled" : ""}>${label}</button>`).join("")}</div></div>
        <p class="helper-text">${soundLocked ? "タイマー動作中は音設定を変更できません。" : "実際の音量はiPhone本体のメディア音量にも影響されます。"}</p>
      </section>

      <section class="settings-card">
        <div class="settings-card__heading"><div><p class="eyebrow">MY DATA</p><h2>バックアップ</h2></div></div>
        <p>器具、種目、設定、履歴、進行中の内容をひとつのJSONファイルに保存できます。</p>
        <div class="settings-actions"><button class="secondary-button" type="button" data-action="export-data">JSONを書き出す</button><button class="secondary-button" type="button" data-action="choose-import">JSONを読み込む</button></div>
        <p class="helper-text">インポートすると、現在の端末内データをバックアップ内容で置き換えます。</p>
      </section>

      <section class="settings-card settings-links">
        <button type="button" data-route="equipment"><span>使用器具</span><strong>${state.equipment.filter((item) => item.enabled).length}種類が有効 →</strong></button>
        <button type="button" data-route="exercises"><span>種目マスター</span><strong>${state.exercises.filter((item) => item.enabled).length}種目が有効 →</strong></button>
      </section>

      <section class="about-card">
        <div><strong>筋トレ支援PWA</strong><span>v${APP_VERSION}</span></div>
        <p>データはこの端末内のIndexedDBにだけ保存されます。アカウントや外部APIは使用しません。</p>
        <p>${state.wakeLockSupported ? "画面スリープ防止に対応しています。" : "この環境では画面スリープ防止を利用できません。"}</p>
      </section>
    </section>
  `;
}

async function createPlan(intensity) {
  const plan = generatePlan({
    intensity,
    previousPlan: state.draftPlan,
    equipment: state.equipment,
    exercises: state.exercises,
    workouts: state.workouts,
    nonce: Date.now(),
  });

  if (!plan) {
    showToast("使用できる種目がありません。器具と種目の設定を確認してください。 ");
    return;
  }

  state.draftPlan = plan;
  await saveAppState("draftPlan", plan);
  navigate("today");
}

async function regeneratePlan() {
  if (!state.draftPlan) {
    return;
  }
  await createPlan(state.draftPlan.intensity);
}

async function replaceExercise(index) {
  const plan = replacePlanItem({
    plan: state.draftPlan,
    itemIndex: index,
    equipment: state.equipment,
    exercises: state.exercises,
    workouts: state.workouts,
  });

  if (!plan) {
    showToast("同じ部位で交換できる種目がありません。 ");
    return;
  }

  state.draftPlan = plan;
  await saveAppState("draftPlan", plan);
  render();
  showToast("種目を入れ替えました");
}

async function startWorkout() {
  if (!state.draftPlan || state.draftPlan.items.length === 0) {
    return;
  }
  if (state.activeWorkout && !window.confirm("進行中のトレーニングを破棄して、このメニューを開始しますか？")) {
    return;
  }
  await sound.unlock();
  state.activeWorkout = {
    id: createId("workout"),
    date: localDateKey(),
    intensity: state.draftPlan.intensity,
    startedAt: new Date().toISOString(),
    completedAt: null,
    currentExerciseIndex: 0,
    items: state.draftPlan.items.map((item) => ({
      ...item,
      sets: Array.from({ length: item.plannedSets }, () => ({
        weight: Number(item.suggestedWeight) || 0,
        reps: item.type === "reps" ? item.targetReps : null,
        durationSeconds: item.type === "time" ? item.targetSeconds : null,
        completed: false,
      })),
    })),
  };
  await saveActiveWorkout();
  sound.play("start");
  navigate("workout");
}

async function saveActiveWorkout() {
  await saveAppState("activeWorkout", state.activeWorkout);
}

async function adjustRecord(button) {
  const item = state.activeWorkout?.items[Number(button.dataset.itemIndex)];
  const set = item?.sets[Number(button.dataset.setIndex)];
  if (!set || set.completed) {
    return;
  }
  const field = button.dataset.field;
  const delta = Number(button.dataset.delta);
  const nextValue = Math.max(0, (Number(set[field]) || 0) + delta);
  set[field] = field === "weight" ? Math.round(nextValue * 2) / 2 : Math.round(nextValue);
  await saveActiveWorkout();
  render();
}

async function applyWeightPreset(button) {
  const item = state.activeWorkout?.items[Number(button.dataset.itemIndex)];
  const weight = Number(button.dataset.weight);
  if (!item || !(weight > 0)) {
    return;
  }
  item.sets.forEach((set) => {
    if (!set.completed) {
      set.weight = weight;
    }
  });
  await saveActiveWorkout();
  render();
  showToast(`${formatWeight(weight)}kgを未完了セットに入力しました`);
}

async function toggleSetComplete(button) {
  const itemIndex = Number(button.dataset.itemIndex);
  const setIndex = Number(button.dataset.setIndex);
  const item = state.activeWorkout?.items[itemIndex];
  const set = item?.sets[setIndex];
  if (!set) {
    return;
  }

  await sound.unlock();
  set.completed = !set.completed;
  await saveActiveWorkout();

  if (set.completed) {
    const timingThisSet = state.sessionContext?.kind === "work"
      && state.sessionContext.itemIndex === itemIndex
      && state.sessionContext.setIndex === setIndex;
    if (timingThisSet) {
      stopSessionTimer();
    }
    const shouldRest = setIndex < item.sets.length - 1 && item.restSeconds > 0;
    sound.play(shouldRest ? "rest" : "work");
    if (shouldRest) {
      startSessionTimer("rest", item.restSeconds, { itemIndex, setIndex });
    }
  } else if (state.sessionContext?.itemIndex === itemIndex && state.sessionContext?.setIndex === setIndex) {
    stopSessionTimer();
  }
  render();
}

async function startTimedSet(button) {
  const itemIndex = Number(button.dataset.itemIndex);
  const setIndex = Number(button.dataset.setIndex);
  const item = state.activeWorkout?.items[itemIndex];
  const set = item?.sets[setIndex];
  if (!item || !set || set.completed) {
    return;
  }
  await sound.unlock();
  sound.play("work");
  startSessionTimer("work", set.durationSeconds || item.targetSeconds, { itemIndex, setIndex });
  render();
}

function startSessionTimer(kind, seconds, context = {}) {
  // `kind` must win when reusing a completed work-timer context for its rest phase.
  state.sessionContext = { ...context, kind };
  state.sessionLastSecond = null;
  sessionCountdown.start(seconds);
  renderSessionTimer();
}

function stopSessionTimer() {
  sessionCountdown.stop();
  state.sessionContext = null;
  state.sessionLastSecond = null;
  renderSessionTimer();
}

async function handleSessionTimerComplete() {
  const context = state.sessionContext;
  state.sessionContext = null;
  state.sessionLastSecond = null;

  if (context?.kind === "work") {
    const item = state.activeWorkout?.items[context.itemIndex];
    const set = item?.sets[context.setIndex];
    if (set) {
      set.completed = true;
      await saveActiveWorkout();
      if (context.setIndex < item.sets.length - 1 && item.restSeconds > 0) {
        sound.play("rest");
        startSessionTimer("rest", item.restSeconds, context);
      } else {
        sound.play("work");
        showToast("セット完了。次へ進めます");
      }
    }
  } else if (context?.kind === "rest") {
    sound.play("work");
    showToast("休憩終了。次のセットです");
  }

  render();
}

function renderSessionTimer() {
  const context = state.sessionContext;
  const active = context && ["running", "paused"].includes(sessionCountdown.status);
  elements.sessionTimer.hidden = !active;
  if (!active) {
    return;
  }
  elements.sessionTimer.dataset.kind = context.kind;
  elements.sessionTimerLabel.textContent = context.kind === "work" ? "セット計測" : "セット間休憩";
  elements.sessionTimerValue.textContent = formatDuration(Math.ceil(sessionCountdown.remainingMs / 1000));
  const toggle = elements.sessionTimer.querySelector('[data-action="session-timer-toggle"]');
  toggle.textContent = sessionCountdown.status === "paused" ? "再開" : "一時停止";
}

async function finishWorkout() {
  if (!state.activeWorkout) {
    return;
  }
  const completedSets = state.activeWorkout.items.flatMap((item) => item.sets).filter((set) => set.completed).length;
  if (completedSets === 0) {
    if (!window.confirm("完了したセットがありません。記録せずに終了しますか？")) {
      return;
    }
    stopSessionTimer();
    state.activeWorkout = null;
    state.draftPlan = null;
    await Promise.all([
      saveAppState("activeWorkout", null),
      saveAppState("draftPlan", null),
    ]);
    navigate("home");
    showToast("トレーニングを終了しました");
    return;
  }

  if (!window.confirm("現在の記録を保存してトレーニングを終了しますか？")) {
    return;
  }

  stopSessionTimer();
  const workout = {
    ...state.activeWorkout,
    completedAt: new Date().toISOString(),
    items: state.activeWorkout.items.filter((item) => item.sets.some((set) => set.completed)),
  };
  await putOne("workouts", workout);
  state.workouts = [workout, ...state.workouts];
  state.activeWorkout = null;
  state.draftPlan = null;
  await Promise.all([
    saveAppState("activeWorkout", null),
    saveAppState("draftPlan", null),
  ]);
  sound.play("complete");
  navigate("history");
  showToast("トレーニングを保存しました");
}

async function toggleEquipment(id) {
  const item = state.equipment.find((entry) => entry.id === id);
  if (!item) {
    return;
  }
  item.enabled = !item.enabled;
  await putOne("equipment", item);
  render();
}

async function addEquipment(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  if (!name) {
    return;
  }
  const item = { id: createId("equipment"), name, enabled: true, builtIn: false };
  state.equipment.push(item);
  await putOne("equipment", item);
  form.reset();
  render();
  showToast("器具を追加しました");
}

async function removeEquipment(id) {
  const item = state.equipment.find((entry) => entry.id === id);
  if (!item || item.builtIn) {
    return;
  }
  const references = findExercisesUsingEquipment(state.exercises, id);
  if (references.length > 0) {
    const names = references.slice(0, 5).map((exercise) => `・${exercise.name}`).join("\n");
    const remainder = references.length > 5 ? `\nほか${references.length - 5}件` : "";
    window.alert(`「${item.name}」は次の種目で使用されているため削除できません。\n\n${names}${remainder}\n\n先に参照している自作種目を削除してください。`);
    return;
  }
  if (!window.confirm(`「${item.name}」を削除しますか？`)) {
    return;
  }
  state.equipment = state.equipment.filter((entry) => entry.id !== id);
  await deleteOne("equipment", id);
  render();
}

async function toggleExercise(id) {
  const exercise = state.exercises.find((item) => item.id === id);
  if (!exercise) {
    return;
  }
  exercise.enabled = !exercise.enabled;
  await putOne("exercises", exercise);
  render();
}

async function addExercise(form) {
  const data = new FormData(form);
  const type = String(data.get("type"));
  const target = Math.max(1, Number(data.get("target")) || 10);
  const validEquipmentIds = new Set(state.equipment.map((item) => item.id));
  const equipment = data.getAll("equipment").map(String).filter((id) => validEquipmentIds.has(id));
  const intensities = data.getAll("intensities").map(String).filter((id) => INTENSITIES[id]);

  if (equipment.length === 0 || intensities.length === 0) {
    const missingGroup = equipment.length === 0 ? "equipment" : "intensities";
    const error = form.querySelector(`[data-choice-error="${missingGroup}"]`);
    if (error) {
      error.hidden = false;
    }
    form.querySelector(`input[name="${missingGroup}"]`)?.focus();
    return;
  }

  const exercise = {
    id: createId("exercise"),
    name: String(data.get("name") || "").trim(),
    muscleGroup: String(data.get("muscleGroup")),
    equipment,
    type,
    defaultReps: type === "reps" ? target : null,
    defaultSeconds: type === "time" ? target : null,
    defaultSets: Math.min(4, Math.max(2, Number(data.get("sets")) || 3)),
    restSeconds: Math.min(600, Math.max(0, Number(data.get("rest")) || 0)),
    intensities,
    apartmentSafe: data.has("apartmentSafe"),
    foundation: false,
    enabled: true,
    builtIn: false,
  };
  if (!exercise.name) {
    return;
  }
  state.exercises.push(exercise);
  await putOne("exercises", exercise);
  render();
  showToast("種目を追加しました");
}

async function removeExercise(id) {
  const exercise = state.exercises.find((item) => item.id === id);
  if (!exercise || exercise.builtIn || !window.confirm(`「${exercise.name}」を削除しますか？`)) {
    return;
  }
  state.exercises = state.exercises.filter((item) => item.id !== id);
  await deleteOne("exercises", id);
  render();
}

async function saveSettings() {
  await putOne("settings", state.settings);
}

async function setSound(button) {
  const { key, value } = button.dataset;
  state.settings[key] = value;
  await saveSettings();
  render();
}

async function previewSound() {
  await sound.unlock();
  sound.play("work");
}

async function exportData() {
  const data = await dumpDatabase();
  const payload = {
    app: "my-training-pwa",
    schemaVersion: 1,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `my-training-backup-${localDateKey()}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("バックアップを書き出しました");
}

function validateImport(payload) {
  const data = payload?.data;
  return payload?.app === "my-training-pwa"
    && payload?.schemaVersion === 1
    && data
    && ["settings", "equipment", "exercises", "workouts", "appState"].every((key) => Array.isArray(data[key]));
}

async function importData(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (!validateImport(payload)) {
      throw new Error("対応していないバックアップ形式です。");
    }
    if (!window.confirm("現在の端末内データを、このバックアップ内容で置き換えますか？")) {
      return;
    }
    await replaceDatabase(payload.data);
    window.location.reload();
  } catch (error) {
    console.warn("Data import failed:", error);
    showToast(error.message || "バックアップを読み込めませんでした");
  } finally {
    elements.importFile.value = "";
  }
}

async function adjustIntervalSetting(button) {
  const key = button.dataset.key;
  const delta = Number(button.dataset.delta);
  const limits = key === "intervalSets" ? [1, 99] : [5, 3600];
  state.settings[key] = Math.min(limits[1], Math.max(limits[0], state.settings[key] + delta));
  await saveSettings();
  render();
}

async function startInterval() {
  await sound.unlock();
  state.interval.currentSet = 1;
  state.interval.phase = "work";
  state.interval.pausedPhase = null;
  state.interval.lastSecond = null;
  intervalCountdown.start(state.settings.intervalWorkSeconds);
  sound.play("start");
  render();
}

function toggleInterval() {
  if (state.interval.phase === "paused") {
    state.interval.phase = state.interval.pausedPhase;
    state.interval.pausedPhase = null;
    intervalCountdown.resume();
  } else if (["work", "rest"].includes(state.interval.phase)) {
    state.interval.pausedPhase = state.interval.phase;
    state.interval.phase = "paused";
    intervalCountdown.pause();
  }
  render();
}

function resetInterval() {
  intervalCountdown.stop();
  state.interval.phase = "idle";
  state.interval.pausedPhase = null;
  state.interval.currentSet = 1;
  state.interval.lastSecond = null;
  render();
}

function advanceInterval() {
  if (state.interval.phase === "work") {
    if (state.interval.currentSet >= state.settings.intervalSets) {
      state.interval.phase = "complete";
      sound.play("complete");
      render();
      return;
    }
    state.interval.phase = "rest";
    state.interval.lastSecond = null;
    intervalCountdown.start(state.settings.intervalRestSeconds);
    sound.play("rest");
  } else if (state.interval.phase === "rest") {
    state.interval.currentSet += 1;
    state.interval.phase = "work";
    state.interval.lastSecond = null;
    intervalCountdown.start(state.settings.intervalWorkSeconds);
    sound.play("work");
  }
  render();
}

function needsWakeLock() {
  const workoutOpen = Boolean(state.activeWorkout && state.route === "workout");
  const sessionTimerActive = ["running", "paused"].includes(sessionCountdown.status);
  const intervalActive = ["work", "rest", "paused"].includes(state.interval.phase);
  return workoutOpen || sessionTimerActive || intervalActive;
}

async function requestWakeLock() {
  if (!state.wakeLockSupported || state.wakeLockSentinel || state.wakeLockPending || state.wakeLockFailed || document.hidden || !needsWakeLock()) {
    return;
  }
  state.wakeLockPending = true;
  state.wakeLockFailed = false;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (document.hidden || !needsWakeLock()) {
      await sentinel.release();
      return;
    }
    state.wakeLockSentinel = sentinel;
    sentinel.addEventListener("release", () => {
      if (state.wakeLockSentinel === sentinel) {
        state.wakeLockSentinel = null;
        state.wakeLockFailed = needsWakeLock();
        updateWakeNote();
      }
    });
  } catch (error) {
    state.wakeLockFailed = true;
    console.warn("Screen Wake Lock request failed:", error);
  } finally {
    state.wakeLockPending = false;
    updateWakeNote();
  }
}

async function releaseWakeLock() {
  const sentinel = state.wakeLockSentinel;
  state.wakeLockSentinel = null;
  state.wakeLockFailed = false;
  if (sentinel) {
    try {
      await sentinel.release();
    } catch (error) {
      console.warn("Screen Wake Lock release failed:", error);
    }
  }
  updateWakeNote();
}

function syncWakeLock() {
  if (needsWakeLock()) {
    void requestWakeLock();
  } else {
    void releaseWakeLock();
  }
}

function wakeLockMessage() {
  if (!needsWakeLock()) {
    return "画面を開いた状態でご利用ください";
  }
  if (state.wakeLockSentinel) {
    return "トレーニング中は画面がスリープしないようにしています";
  }
  return "画面ロックを防止できません。画面を開いた状態でご利用ください";
}

function updateWakeNote() {
  const note = document.querySelector("#wake-note");
  if (note) {
    note.textContent = wakeLockMessage();
  }
}

document.addEventListener("click", async (event) => {
  const routeButton = event.target.closest("[data-route]");
  if (routeButton) {
    navigate(routeButton.dataset.route);
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) {
    return;
  }

  const action = button.dataset.action;
  const actions = {
    "generate-plan": () => createPlan(button.dataset.intensity),
    "regenerate-plan": regeneratePlan,
    "replace-exercise": () => replaceExercise(Number(button.dataset.index)),
    "start-workout": startWorkout,
    "adjust-record": () => adjustRecord(button),
    "apply-weight-preset": () => applyWeightPreset(button),
    "toggle-set-complete": () => toggleSetComplete(button),
    "start-set-timer": () => startTimedSet(button),
    "change-exercise-index": async () => {
      const next = Math.min(
        state.activeWorkout.items.length - 1,
        Math.max(0, state.activeWorkout.currentExerciseIndex + Number(button.dataset.delta)),
      );
      state.activeWorkout.currentExerciseIndex = next;
      await saveActiveWorkout();
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    "finish-workout": finishWorkout,
    "session-timer-toggle": async () => {
      await sound.unlock();
      sessionCountdown.toggle();
      renderSessionTimer();
    },
    "session-timer-add": () => sessionCountdown.addSeconds(15),
    "session-timer-skip": () => {
      sessionCountdown.stop();
      return handleSessionTimerComplete();
    },
    "toggle-equipment": () => toggleEquipment(button.dataset.id),
    "delete-equipment": () => removeEquipment(button.dataset.id),
    "toggle-exercise": () => toggleExercise(button.dataset.id),
    "delete-exercise": () => removeExercise(button.dataset.id),
    "filter-exercises": () => {
      state.exerciseFilter = button.dataset.group;
      render();
    },
    "set-sound": () => setSound(button),
    "preview-sound": previewSound,
    "export-data": exportData,
    "choose-import": () => elements.importFile.click(),
    "adjust-interval-setting": () => adjustIntervalSetting(button),
    "interval-start": startInterval,
    "interval-toggle": toggleInterval,
    "interval-reset": resetInterval,
    reload: () => window.location.reload(),
  };

  if (actions[action]) {
    await actions[action]();
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "equipment-form") {
    await addEquipment(event.target);
  } else if (event.target.id === "exercise-form") {
    await addExercise(event.target);
  }
});

document.addEventListener("change", (event) => {
  const input = event.target.closest('#exercise-form input[type="checkbox"]');
  if (!input) {
    return;
  }
  const error = input.form?.querySelector(`[data-choice-error="${input.name}"]`);
  if (error) {
    error.hidden = true;
  }
});

elements.importFile.addEventListener("change", () => {
  const [file] = elements.importFile.files;
  if (file) {
    void importData(file);
  }
});

window.addEventListener("hashchange", () => {
  state.route = getRoute();
  render();
  window.scrollTo({ top: 0 });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    sessionCountdown.sync();
    intervalCountdown.sync();
    // A visibility transition is the right time to retry a lock rejected earlier.
    state.wakeLockFailed = false;
    syncWakeLock();
  }
});

window.addEventListener("pagehide", () => {
  void releaseWakeLock();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service Worker registration failed:", error);
    });
  });
}

void initialize();
