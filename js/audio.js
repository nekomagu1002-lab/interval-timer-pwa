export const VOLUME_LEVELS = Object.freeze({
  mute: 0,
  small: 0.08,
  medium: 0.18,
  large: 0.32,
});

export const VOLUME_LABELS = Object.freeze({
  mute: "消音",
  small: "小",
  medium: "中",
  large: "大",
});

export const TONE_LABELS = Object.freeze({
  beep: "ビープ",
  alarm: "アラーム",
  bell: "ベル",
});

export class SoundManager {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.context = null;
  }

  async unlock() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return false;
    }

    try {
      if (!this.context) {
        this.context = new AudioContext();
      }

      if (this.context.state === "suspended") {
        await this.context.resume();
      }

      return this.context.state === "running";
    } catch (error) {
      console.warn("Audio could not be enabled:", error);
      return false;
    }
  }

  play(type) {
    const settings = this.getSettings();
    if (!this.context || this.context.state !== "running" || VOLUME_LEVELS[settings.volume] === 0) {
      return;
    }

    if (settings.tone === "alarm") {
      this.playAlarm(type);
      return;
    }
    if (settings.tone === "bell") {
      this.playBell(type);
      return;
    }
    this.playBeep(type);
  }

  tone(frequency, duration, delay = 0, volumeScale = 1, waveType = "sine") {
    const settings = this.getSettings();
    const volume = (VOLUME_LEVELS[settings.volume] || 0) * volumeScale;
    if (!this.context || this.context.state !== "running" || volume <= 0) {
      return;
    }

    const startAt = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = waveType;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.03);
  }

  playBeep(type) {
    if (type === "countdown") {
      this.tone(660, 0.1, 0, 0.75);
      return;
    }
    if (type === "complete") {
      this.tone(523, 0.16, 0, 0.72);
      this.tone(659, 0.16, 0.2, 0.78);
      this.tone(784, 0.34, 0.4, 0.9);
      return;
    }

    const frequency = type === "rest" ? 440 : 880;
    this.tone(frequency, 0.14, 0, 0.8);
    this.tone(frequency, 0.14, 0.19, 0.8);
  }

  playAlarm(type) {
    if (type === "countdown") {
      this.tone(920, 0.055, 0, 0.58, "square");
      this.tone(650, 0.055, 0.07, 0.52, "square");
      return;
    }

    const first = type === "rest" ? 570 : 1040;
    const second = type === "rest" ? 390 : 720;
    const repeats = type === "complete" ? 4 : 2;

    for (let index = 0; index < repeats; index += 1) {
      const delay = index * 0.22;
      this.tone(first, 0.09, delay, 0.52, "square");
      this.tone(second, 0.09, delay + 0.11, 0.46, "square");
    }
    if (type === "complete") {
      this.tone(1240, 0.3, 0.9, 0.56, "square");
    }
  }

  playBell(type) {
    const base = {
      countdown: 700,
      start: 880,
      work: 880,
      rest: 440,
      complete: 660,
    }[type] || 700;
    const duration = type === "countdown" ? 0.16 : type === "complete" ? 0.75 : 0.38;
    this.bellChord(base, duration);

    if (type === "complete") {
      this.bellChord(base * 1.25, 0.8, 0.32);
      this.bellChord(base * 1.5, 0.9, 0.66);
    }
  }

  bellChord(base, duration, delay = 0) {
    this.tone(base, duration, delay, 0.58);
    this.tone(base * 2, duration * 0.78, delay, 0.2);
    this.tone(base * 3, duration * 0.58, delay, 0.1);
  }
}
