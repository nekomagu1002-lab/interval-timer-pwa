export class PreciseCountdown {
  constructor({ onTick = () => {}, onComplete = () => {}, onStateChange = () => {} } = {}) {
    this.onTick = onTick;
    this.onComplete = onComplete;
    this.onStateChange = onStateChange;
    this.status = "idle";
    this.remainingMs = 0;
    this.endTime = 0;
    this.intervalId = null;
  }

  start(seconds) {
    this.clearTicker();
    this.remainingMs = Math.max(0, Number(seconds) * 1000);
    this.endTime = Date.now() + this.remainingMs;
    this.status = "running";
    this.startTicker();
    this.onStateChange(this.status);
    this.tick();
  }

  pause() {
    if (this.status !== "running") {
      return;
    }

    this.remainingMs = Math.max(0, this.endTime - Date.now());
    this.status = "paused";
    this.clearTicker();
    this.onStateChange(this.status);
    this.emitTick();
  }

  resume() {
    if (this.status !== "paused") {
      return;
    }

    this.endTime = Date.now() + this.remainingMs;
    this.status = "running";
    this.startTicker();
    this.onStateChange(this.status);
    this.tick();
  }

  toggle() {
    if (this.status === "running") {
      this.pause();
    } else if (this.status === "paused") {
      this.resume();
    }
  }

  addSeconds(seconds) {
    const addition = Number(seconds) * 1000;
    this.remainingMs = Math.max(0, this.remainingMs + addition);
    if (this.status === "running") {
      this.endTime += addition;
    }
    this.emitTick();
  }

  stop() {
    this.clearTicker();
    this.status = "idle";
    this.remainingMs = 0;
    this.endTime = 0;
    this.onStateChange(this.status);
    this.emitTick();
  }

  sync() {
    if (this.status === "running") {
      this.tick();
    }
  }

  tick() {
    if (this.status !== "running") {
      return;
    }

    this.remainingMs = Math.max(0, this.endTime - Date.now());
    this.emitTick();

    if (this.remainingMs <= 0) {
      this.clearTicker();
      this.status = "complete";
      this.onStateChange(this.status);
      this.onComplete();
    }
  }

  emitTick() {
    this.onTick({
      milliseconds: this.remainingMs,
      seconds: Math.max(0, Math.ceil(this.remainingMs / 1000)),
      status: this.status,
    });
  }

  startTicker() {
    this.clearTicker();
    this.intervalId = window.setInterval(() => this.tick(), 100);
  }

  clearTicker() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
