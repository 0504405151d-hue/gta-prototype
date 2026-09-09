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

    // --- engine drone: pitch = f(speed) ---
    // Used to be a single raw sawtooth through a lowpass. A lone sawtooth is
    // a harsh, harmonic-heavy waveform — it reads as a whiny buzz rather
    // than an engine note, and that's exactly the kind of sound that gets
    // "annoying" over a long play session since it's playing continuously.
    // Blending in a quieter detuned triangle (a much simpler waveform, few
    // harmonics) fills out a rounder "purr" underneath the sawtooth's growl
    // without losing the growl entirely, and a lower filter Q avoids an
    // extra resonant spike right at the cutoff that would otherwise add its
    // own buzziness on top.
    const engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 40;
    const engineOsc2 = ctx.createOscillator();
    engineOsc2.type = 'triangle';
    engineOsc2.frequency.value = 40.4; // tiny detune for thickness, not enough to beat audibly
    const engineGain2 = ctx.createGain();
    engineGain2.gain.value = 0.45; // triangle sits under the sawtooth, not equal to it
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 500;
    engineFilter.Q.value = 0.5; // was the default (~1) — smoother roll-off, no resonant peak
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.0;
    engineOsc.connect(engineFilter);
    engineOsc2.connect(engineGain2).connect(engineFilter);
    engineFilter.connect(engineGain).connect(masterGain);
    engineOsc.start();
    engineOsc2.start();
    this.engineOsc = engineOsc;
    this.engineOsc2 = engineOsc2;
    this.engineFilter = engineFilter;
    this.engineGain = engineGain;

    // --- continuous screech bed (filtered noise), gain driven per-frame ---
    const screechSrc = ctx.createBufferSource();
    screechSrc.buffer = this.noiseBuffer;
    screechSrc.loop = true;
    const screechFilter = ctx.createBiquadFilter();
    screechFilter.type = 'bandpass';
    screechFilter.frequency.value = 1500; // was 1800 — a little less shrill/piercing
    screechFilter.Q.value = 0.5; // was 0.7 — less resonant, smoother squeal instead of a sharp whistle
    const screechTone = ctx.createBiquadFilter();
    screechTone.type = 'lowpass';
    screechTone.frequency.value = 3200; // rounds off the very top so it reads as a tire squeal, not hiss
    const screechGain = ctx.createGain();
    screechGain.gain.value = 0;
    screechSrc.connect(screechFilter).connect(screechTone).connect(screechGain).connect(masterGain);
    screechSrc.start();
    this.screechGain = screechGain;

    this.ready = true;
    this._startCityAmbience();
  }

  /**
   * Round 12 ("ближе к GTA Сан Андреас" — атмосфера города): up to now the
   * only sounds in the whole game were things the PLAYER'S OWN car directly
   * caused (engine/screech/impact) plus the radio — the city itself was
   * completely silent underneath all of that, which is a big part of why a
   * GTA-style city reads as "alive" even standing still. Two purely ambient,
   * fully procedural (no audio files, matching this file's own convention)
   * layers, both routed through masterGain so mute/volume still cover them:
   * a constant, very quiet low-passed noise bed standing in for distant
   * traffic hum, and randomly-timed short one-shots (a distant horn honk,
   * rarely a distant siren) so the background isn't perfectly static either.
   * Neither one is tied to anything in the world — no real traffic car
   * actually "owns" a honk — this is atmosphere, not a simulation of it.
   */
  _startCityAmbience() {
    const ctx = this.ctx;
    const hum = ctx.createBufferSource();
    hum.buffer = this.noiseBuffer;
    hum.loop = true;
    hum.playbackRate.value = 0.5;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 220; // dull, distant rumble — nowhere near the engine's own frequency range
    humFilter.Q.value = 0.4;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.02; // barely-there bed, not a competing layer under the engine/radio
    hum.connect(humFilter).connect(humGain).connect(this.masterGain);
    hum.start();
    this._ambienceHumGain = humGain;

    this._scheduleAmbienceEvent();
  }

  _scheduleAmbienceEvent() {
    if (!this.ready) return;
    // 12-35s between events — frequent enough to notice, spaced out enough
    // that it never reads as a loop.
    const delay = 12000 + Math.random() * 23000;
    this._ambienceTimer = setTimeout(() => {
      if (!this.ready) return;
      if (Math.random() < 0.15) this._playDistantSiren();
      else this._playDistantHonk();
      this._scheduleAmbienceEvent();
    }, delay);
  }

  /** A short, quiet two-tone honk, pitched/panned randomly so a run of them
   * never sounds like the exact same car honking on a loop. */
  _playDistantHonk() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const baseFreq = 320 + Math.random() * 140;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.03);
    gain.gain.setValueAtTime(0.045, now + 0.22);
    gain.gain.linearRampToValueAtTime(0, now + 0.32);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200; // distant — no crisp top end
    gain.connect(filter).connect(this.masterGain);
    [baseFreq, baseFreq * 1.2].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.35);
    });
  }

  /** A rare, slow, low-volume siren warble — pure atmosphere, no actual
   * police/emergency behavior anywhere in the game reacts to it. */
  _playDistantSiren() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.035, now + 0.5);
    const duration = 3.5 + Math.random() * 2;
    gain.gain.setValueAtTime(0.035, now + duration - 0.5);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    osc.connect(filter).connect(gain).connect(this.masterGain);
    // Slow warble between two pitches — the classic wail shape, just quiet
    // and filtered enough to read as blocks away rather than on top of you.
    const steps = Math.round(duration / 0.9);
    for (let i = 0; i <= steps; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? 600 : 850, now + i * 0.9);
    }
    osc.start(now);
    osc.stop(now + duration + 0.1);
  }

  /** Call every frame with 0..~60 m/s speed and 0..1 throttle magnitude. */
  updateEngine(speedMs, throttleMag) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const rpm = Math.min(1, Math.abs(speedMs) / 30) * 0.75 + throttleMag * 0.35;
    const freq = 40 + rpm * 160;
    const vol = 0.05 + Math.min(1, Math.abs(speedMs) / 25) * 0.05 + throttleMag * 0.05;
    this.engineOsc.frequency.setTargetAtTime(freq, now, 0.08);
    this.engineOsc2.frequency.setTargetAtTime(freq * 1.01, now, 0.08);
    // Ceiling lowered from 300+rpm*1800 — keeps the loudest, buzziest upper
    // harmonics a bit more contained at high rpm instead of opening all the
    // way up into harsh territory.
    this.engineFilter.frequency.setTargetAtTime(280 + rpm * 1400, now, 0.1);
    this.engineGain.gain.setTargetAtTime(vol, now, 0.1);
  }

  /** amount: 0..1, how hard the tires are currently sliding (0 = silent). */
  updateScreech(amount) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.screechGain.gain.setTargetAtTime(amount * 0.12, now, 0.05); // was 0.16 — quieter ceiling, less piercing during a hard drift
  }

  /** strength: 0..1 impact severity. */
  playImpact(strength = 0.5) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Repeated impacts in quick succession — scraping the side of the car
    // along a wall is the common case — used to each play at full,
    // near-identical volume and tone: a rapid machine-gun of identical
    // "thunks" is exactly the kind of sound that reads as grating rather
    // than as one continuous scrape. Track how recently the last impact
    // fired and duck each subsequent one further (recovering once hits stop
    // for ~0.6s) so a sustained scrape fades into a softer texture instead
    // of hammering at full strength the whole time.
    const sinceLast = this._lastImpactTime != null ? now - this._lastImpactTime : 999;
    this._lastImpactTime = now;
    this._repeatFatigue = sinceLast > 0.6 ? 0 : Math.min(0.75, (this._repeatFatigue || 0) + 0.22);
    const fatigueMul = 1 - this._repeatFatigue;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    // Small per-hit pitch variation so a burst of repeated impacts doesn't
    // sound like the exact same sample looping, which reads as mechanical.
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320 + strength * 550; // was 400 + strength*800 — darker/thuddier, less sharp "clack"
    filter.Q.value = 0.5;
    const gain = ctx.createGain();
    const vol = (0.11 + strength * 0.35) * fatigueMul; // ceiling lowered from 0.15 + strength*0.5
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    src.connect(filter).connect(gain).connect(this.masterGain);
    src.start();
    src.stop(now + 0.3);
  }

  /** Distant rumble for weather lightning strikes (see weather.js). Unlike
   * playImpact() this swells in rather than hitting instantly, is pitched
   * way down into rumble territory, and rings out much longer — a thunder
   * clap reads completely differently from a car-crash thud, so it deserves
   * its own shape rather than reusing playImpact() with different numbers. */
  playThunder() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.35 + Math.random() * 0.15; // slowed way down from the impact/screech noise for a deep rumble, not a hiss
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.25); // slow swell, not an instant hit — real thunder builds
    gain.gain.exponentialRampToValueAtTime(0.001, now + 2.2);
    src.connect(filter).connect(gain).connect(this.masterGain);
    src.start();
    src.stop(now + 2.3);
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
