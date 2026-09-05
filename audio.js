// Fully procedural sound via the Web Audio API — no audio files to fetch.
// - A continuous engine drone whose pitch/volume track speed & throttle.
// - Short noise-burst "thud" on hard impacts, scaled by impact strength.
// - A filtered noise "screech" that fades in while a tire is sliding.
//
// Browsers require a user gesture before audio can start, so `resume()` is
// called from the existing "Сесть за руль" button click in main.js.

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.engineOsc = null;
    this.engineGain = null;
    this.screechGain = null;
    this.screechFilter = null;
    this.noiseBuffer = null;
    this.ready = false;
    this._pendingVolume = 1;
  }

  resume() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // no Web Audio support — game still works, just silent
    const ctx = new Ctx();
    this.ctx = ctx;

    // Everything routes through this so the HUD mute toggle is one gain
    // change instead of silencing three independent sound paths.
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
    this.masterGain = masterGain;
    this.muted = false;
    this.volume = this._pendingVolume != null ? this._pendingVolume : 1;
    masterGain.gain.value = this.volume;

    // --- shared noise buffer used for screech + impact thuds ---
    const bufLen = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;

    // --- engine drone: a sawtooth run through a lowpass, pitch = f(speed) ---
    const engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 40;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 500;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.0;
    engineOsc.connect(engineFilter).connect(engineGain).connect(masterGain);
    engineOsc.start();
    this.engineOsc = engineOsc;
    this.engineFilter = engineFilter;
    this.engineGain = engineGain;

    // --- continuous screech bed (filtered noise), gain driven per-frame ---
    const screechSrc = ctx.createBufferSource();
    screechSrc.buffer = this.noiseBuffer;
    screechSrc.loop = true;
    const screechFilter = ctx.createBiquadFilter();
    screechFilter.type = 'bandpass';
    screechFilter.frequency.value = 1800;
    screechFilter.Q.value = 0.7;
    const screechGain = ctx.createGain();
    screechGain.gain.value = 0;
    screechSrc.connect(screechFilter).connect(screechGain).connect(masterGain);
    screechSrc.start();
    this.screechGain = screechGain;

    this.ready = true;
  }

  /** Call every frame with 0..~60 m/s speed and 0..1 throttle magnitude. */
  updateEngine(speedMs, throttleMag) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const rpm = Math.min(1, Math.abs(speedMs) / 30) * 0.75 + throttleMag * 0.35;
    const freq = 40 + rpm * 160;
    const vol = 0.05 + Math.min(1, Math.abs(speedMs) / 25) * 0.05 + throttleMag * 0.05;
    this.engineOsc.frequency.setTargetAtTime(freq, now, 0.08);
    this.engineFilter.frequency.setTargetAtTime(300 + rpm * 1800, now, 0.1);
    this.engineGain.gain.setTargetAtTime(vol, now, 0.1);
  }

  /** amount: 0..1, how hard the tires are currently sliding (0 = silent). */
  updateScreech(amount) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.screechGain.gain.setTargetAtTime(amount * 0.16, now, 0.05);
  }

  /** strength: 0..1 impact severity. */
  playImpact(strength = 0.5) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400 + strength * 800;
    const gain = ctx.createGain();
    const vol = 0.15 + strength * 0.5;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    src.connect(filter).connect(gain).connect(this.masterGain);
    src.start();
    src.stop(ctx.currentTime + 0.3);
  }

  /** Toggles master volume; returns the new muted state. Safe before resume(). */
  toggleMute() {
    this.muted = !this.muted;
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** v: 0..1 master volume slider. Safe to call before resume() — the value
   * is remembered and applied once the AudioContext actually exists. */
  setVolume(v) {
    this._pendingVolume = v;
    this.volume = v;
    if (this.ready && !this.muted && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
  }
}
