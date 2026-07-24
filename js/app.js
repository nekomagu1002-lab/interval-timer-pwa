"use strict";

const STORAGE_KEY = "intervalTimerSettings";
const DEFAULT_SETTINGS = Object.freeze({
  workSeconds: 30,
  restSeconds: 60,
  sets: 3,
  volume: "medium",
  tone: "beep",
});
const VOLUME_LEVELS = Object.freeze({
  mute: 0,
  small: 0.08,
  medium: 0.18,
  large: 0.32,
});
const VOLUME_LABELS = Object.freeze({
  mute: "消音",
  small: "小",
  medium: "中",
  large: "大",
});
const TONE_LABELS = Object.freeze({
  beep: "ビープ",
  alarm: "アラーム",
  bell: "ベル",
});
const LIMITS = Object.freeze({
  workSeconds: { min: 5, max: 3600 },
  restSeconds: { min: 5, max: 3600 },
  sets: { min: 1, max: 99 },
});

const elements = {
  app: document.querySelector("#app"),
  status: document.querySelector("#status-label"),
  time: document.querySelector("#time-display"),
  set: document.querySelector("#set-display"),
  workValue: document.querySelector("#work-value"),
  restValue: document.querySelector("#rest-value"),
  setsValue: document.querySelector("#sets-value"),
  soundSettings: document.querySelector("#sound-settings"),
  soundSummary: document.querySelector("#sound-setting-summary"),
  soundButtons: [...document.querySelectorAll("[data-sound-setting]")],
  previewButton: document.querySelector("#preview-button"),
  wakeLockNotice: document.querySelector("#wake-lock-notice"),
  startButton: document.querySelector("#start-button"),
  pauseButton: document.querySelector("#pause-button"),
  resetButton: document.querySelector("#reset-button"),
  settingButtons: [...document.querySelectorAll("[data-setting]")],
};

const state = {
  settings: loadSettings(),
  phase: "idle",
  pausedPhase: null,
  currentSet: 1,
  remainingMs: 0,
  endTime: 0,
  timerId: null,
  lastCountdownSecond: null,
  audioContext: null,
  wakeLockSentinel: null,
  wakeLockSupported: "wakeLock" in navigator,
  wakeLockFailed: false,
  wakeLockRequestPending: false,
};

const phaseLabels = {
  idle: "待機中",
  work: "運動中",
  rest: "休憩中",
  paused: "一時停止中",
  complete: "完了",
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return {
      workSeconds: normalizeSetting("workSeconds", saved?.workSeconds),
      restSeconds: normalizeSetting("restSeconds", saved?.restSeconds),
      sets: normalizeSetting("sets", saved?.sets),
      volume: normalizeSoundSetting("volume", saved?.volume),
      tone: normalizeSoundSetting("tone", saved?.tone),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeSetting(name, value) {
  const fallback = DEFAULT_SETTINGS[name];
  const numericValue = Number(value);
  const { min, max } = LIMITS[name];

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  const step = name === "sets" ? 1 : 5;
  const steppedValue = Math.round(numericValue / step) * step;
  return Math.min(max, Math.max(min, steppedValue));
}

function normalizeSoundSetting(name, value) {
  const allowedValues = name === "volume" ? VOLUME_LEVELS : TONE_LABELS;
  return Object.prototype.hasOwnProperty.call(allowedValues, value) ? value : DEFAULT_SETTINGS[name];
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function updateSoundSetting(name, value) {
  if (state.phase !== "idle" && state.phase !== "complete") {
    return;
  }

  state.settings[name] = normalizeSoundSetting(name, value);
  saveSettings();
  render();
}

function updateSetting(name, delta) {
  if (state.phase !== "idle" && state.phase !== "complete") {
    return;
  }

  state.settings[name] = normalizeSetting(name, state.settings[name] + delta);
  saveSettings();

  if (state.phase === "complete") {
    resetTimer();
  } else {
    state.remainingMs = state.settings.workSeconds * 1000;
    render();
  }
}

async function startTimer() {
  await unlockAudio();
  saveSettings();
  stopTicker();
  state.currentSet = 1;
  state.pausedPhase = null;
  enterPhase("work", state.settings.workSeconds * 1000);
  void requestWakeLock();
  playPhaseTone("start");
}

function pauseTimer() {
  if (state.phase === "paused") {
    resumeTimer();
    return;
  }

  if (state.phase !== "work" && state.phase !== "rest") {
    return;
  }

  state.remainingMs = Math.max(0, state.endTime - Date.now());
  state.pausedPhase = state.phase;
  state.phase = "paused";
  stopTicker();
  render();
}

async function resumeTimer() {
  await unlockAudio();

  if (state.phase !== "paused" || !state.pausedPhase) {
    return;
  }

  state.phase = state.pausedPhase;
  state.pausedPhase = null;
  state.endTime = Date.now() + state.remainingMs;
  state.lastCountdownSecond = null;
  startTicker();
  tick();
  void requestWakeLock();
}

function resetTimer() {
  stopTicker();
  void releaseWakeLock();
  state.phase = "idle";
  state.pausedPhase = null;
  state.currentSet = 1;
  state.remainingMs = state.settings.workSeconds * 1000;
  state.endTime = 0;
  state.lastCountdownSecond = null;
  render();
}

function enterPhase(phase, durationMs, carryFromEndTime = null) {
  state.phase = phase;
  state.remainingMs = durationMs;
  state.endTime = (carryFromEndTime ?? Date.now()) + durationMs;
  state.lastCountdownSecond = null;
  startTicker();
  tick();
}

function advancePhase() {
  const previousEndTime = state.endTime;

  if (state.phase === "work") {
    if (state.currentSet >= state.settings.sets) {
      completeTimer();
      return;
    }

    enterPhase("rest", state.settings.restSeconds * 1000, previousEndTime);
    playPhaseTone("rest");
    return;
  }

  if (state.phase === "rest") {
    state.currentSet += 1;
    enterPhase("work", state.settings.workSeconds * 1000, previousEndTime);
    playPhaseTone("work");
  }
}

function completeTimer() {
  stopTicker();
  void releaseWakeLock();
  state.phase = "complete";
  state.pausedPhase = null;
  state.currentSet = state.settings.sets;
  state.remainingMs = 0;
  state.endTime = 0;
  state.lastCountdownSecond = null;
  render();
  playPhaseTone("complete");
}

function tick() {
  if (state.phase !== "work" && state.phase !== "rest") {
    return;
  }

  state.remainingMs = Math.max(0, state.endTime - Date.now());

  if (state.remainingMs <= 0) {
    advancePhase();
    return;
  }

  const secondsLeft = Math.ceil(state.remainingMs / 1000);
  if (secondsLeft <= 3 && secondsLeft !== state.lastCountdownSecond) {
    state.lastCountdownSecond = secondsLeft;
    playCountdownTone();
  }

  render();
}

function startTicker() {
  stopTicker();
  state.timerId = window.setInterval(tick, 100);
}

function stopTicker() {
  if (state.timerId !== null) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function formatTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function render() {
  const controlsLocked = state.phase === "work" || state.phase === "rest" || state.phase === "paused";

  elements.app.dataset.phase = state.phase === "paused" ? state.pausedPhase : state.phase;
  elements.status.textContent = phaseLabels[state.phase];
  elements.time.textContent = formatTime(state.remainingMs);
  elements.time.setAttribute("aria-label", `残り${Math.ceil(state.remainingMs / 1000)}秒`);
  elements.set.textContent = `${state.currentSet} / ${state.settings.sets} セット目`;
  elements.workValue.textContent = state.settings.workSeconds;
  elements.restValue.textContent = state.settings.restSeconds;
  elements.setsValue.textContent = state.settings.sets;
  elements.soundSummary.textContent = `${VOLUME_LABELS[state.settings.volume]}・${TONE_LABELS[state.settings.tone]}`;

  elements.startButton.disabled = controlsLocked;
  elements.startButton.textContent = state.phase === "complete" ? "もう一度" : "開始";
  elements.pauseButton.disabled = state.phase !== "work" && state.phase !== "rest" && state.phase !== "paused";
  elements.pauseButton.textContent = state.phase === "paused" ? "再開" : "一時停止";
  elements.settingButtons.forEach((button) => {
    button.disabled = controlsLocked;
  });
  elements.soundButtons.forEach((button) => {
    button.disabled = controlsLocked;
    button.setAttribute(
      "aria-pressed",
      String(state.settings[button.dataset.soundSetting] === button.dataset.value),
    );
  });
  elements.previewButton.disabled = controlsLocked;
  elements.soundSettings.dataset.locked = String(controlsLocked);
  elements.wakeLockNotice.textContent = getWakeLockNotice();
}

function getWakeLockNotice() {
  if (!isTimerActive()) {
    return "画面を開いた状態でご利用ください";
  }

  if (state.wakeLockSupported && !state.wakeLockFailed && state.wakeLockSentinel) {
    return "タイマー中は画面がスリープしないようにしています";
  }

  return "画面ロックを防止できません。画面を開いた状態でご利用ください";
}

function isTimerActive() {
  return state.phase === "work" || state.phase === "rest" || state.phase === "paused";
}

async function requestWakeLock() {
  if (
    !state.wakeLockSupported
    || state.wakeLockSentinel
    || state.wakeLockRequestPending
    || document.hidden
    || !isTimerActive()
  ) {
    return;
  }

  state.wakeLockFailed = false;
  state.wakeLockRequestPending = true;

  try {
    const sentinel = await navigator.wakeLock.request("screen");

    if (document.hidden || !isTimerActive()) {
      await sentinel.release();
      return;
    }

    state.wakeLockSentinel = sentinel;
    sentinel.addEventListener("release", () => {
      if (state.wakeLockSentinel === sentinel) {
        state.wakeLockSentinel = null;
        state.wakeLockFailed = isTimerActive();
        render();
      }
    });
  } catch (error) {
    state.wakeLockSentinel = null;
    state.wakeLockFailed = true;
    console.warn("Screen Wake Lock request failed:", error);
  } finally {
    state.wakeLockRequestPending = false;
    render();
  }
}

async function releaseWakeLock() {
  const sentinel = state.wakeLockSentinel;
  state.wakeLockSentinel = null;
  state.wakeLockFailed = false;

  if (!sentinel) {
    render();
    return;
  }

  try {
    await sentinel.release();
  } catch (error) {
    console.warn("Screen Wake Lock release failed:", error);
  }

  render();
}

async function unlockAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    return;
  }

  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }

  if (state.audioContext.state === "suspended") {
    await state.audioContext.resume();
  }
}

function playTone(frequency, duration, delay = 0, volumeScale = 1, waveType = "sine") {
  if (!state.audioContext || state.audioContext.state !== "running") {
    return;
  }

  const selectedVolume = VOLUME_LEVELS[state.settings.volume];
  const volume = selectedVolume * volumeScale;
  if (volume <= 0) {
    return;
  }

  const startAt = state.audioContext.currentTime + delay;
  const oscillator = state.audioContext.createOscillator();
  const gain = state.audioContext.createGain();

  oscillator.type = waveType;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  oscillator.connect(gain);
  gain.connect(state.audioContext.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function playCountdownTone() {
  playNotification("countdown");
}

function playPhaseTone(type) {
  playNotification(type);
}

function playNotification(type) {
  if (VOLUME_LEVELS[state.settings.volume] === 0) {
    return;
  }

  if (state.settings.tone === "alarm") {
    playAlarmSound(type);
    return;
  }

  if (state.settings.tone === "bell") {
    playBellSound(type);
    return;
  }

  playBeepSound(type);
}

function playBeepSound(type) {
  if (type === "countdown") {
    playTone(660, 0.1, 0, 0.75);
    return;
  }

  if (type === "complete") {
    playTone(523, 0.16, 0, 0.72);
    playTone(659, 0.16, 0.2, 0.78);
    playTone(784, 0.34, 0.4, 0.9);
    return;
  }

  const frequency = type === "rest" ? 440 : 880;
  playTone(frequency, 0.14, 0, 0.8);
  playTone(frequency, 0.14, 0.19, 0.8);
}

function playAlarmSound(type) {
  if (type === "countdown") {
    playTone(920, 0.055, 0, 0.58, "square");
    playTone(650, 0.055, 0.07, 0.52, "square");
    return;
  }

  const firstFrequency = type === "rest" ? 570 : 1040;
  const secondFrequency = type === "rest" ? 390 : 720;
  const repeats = type === "complete" ? 4 : 2;

  for (let index = 0; index < repeats; index += 1) {
    const delay = index * 0.22;
    playTone(firstFrequency, 0.09, delay, 0.52, "square");
    playTone(secondFrequency, 0.09, delay + 0.11, 0.46, "square");
  }

  if (type === "complete") {
    playTone(1240, 0.3, 0.9, 0.56, "square");
  }
}

function playBellSound(type) {
  const baseFrequencies = {
    countdown: 700,
    start: 880,
    work: 880,
    rest: 440,
    complete: 660,
  };
  const baseFrequency = baseFrequencies[type];
  const duration = type === "countdown" ? 0.16 : type === "complete" ? 0.75 : 0.38;

  playBellChord(baseFrequency, duration);

  if (type === "complete") {
    playBellChord(baseFrequency * 1.25, 0.8, 0.32);
    playBellChord(baseFrequency * 1.5, 0.9, 0.66);
  }
}

function playBellChord(baseFrequency, duration, delay = 0) {
  playTone(baseFrequency, duration, delay, 0.58);
  playTone(baseFrequency * 2, duration * 0.78, delay, 0.2);
  playTone(baseFrequency * 3, duration * 0.58, delay, 0.1);
}

elements.settingButtons.forEach((button) => {
  button.addEventListener("click", () => {
    updateSetting(button.dataset.setting, Number(button.dataset.delta));
  });
});

elements.soundButtons.forEach((button) => {
  button.addEventListener("click", () => {
    updateSoundSetting(button.dataset.soundSetting, button.dataset.value);
  });
});

elements.previewButton.addEventListener("click", async () => {
  await unlockAudio();
  playNotification("work");
});

elements.startButton.addEventListener("click", startTimer);
elements.pauseButton.addEventListener("click", pauseTimer);
elements.resetButton.addEventListener("click", resetTimer);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    tick();

    if (isTimerActive()) {
      void requestWakeLock();
    }
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

resetTimer();
