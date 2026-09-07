// Round 7 ("добавь типо радио какой можно через англ кнопку кью переключать
// или выключить" — add an in-car radio, toggled/cycled with the Q key).
//
// Fully procedural, like the rest of this project's audio (audio.js) — no
// mp3/ogg files to fetch or host, which matters here since this project
// ships as a flat set of source files with no build/asset pipeline and gets
// deployed straight onto Render. Reuses the SAME AudioContext + master gain
// node audio.js already created (so the game's existing mute/volume slider
// silences the radio too, for free) rather than spinning up a second audio
// graph, and only ever touches audio nodes it created itself.
//
// Three "stations" plus off, cycled in that order by Q:
//   1) Synth FM  — a bright, upbeat arpeggio + lead loop (square/saw waves).
//   2) Rock FM   — a driving distorted-bass pulse with a simple kick/snare beat.
//   3) Talk Radio — no music at all: a filtered, amplitude-modulated noise
//      murmur pitched into human-voice range, reading as "someone talking
//      just out of earshot" rather than static or hiss.
// A basic lookahead scheduler (the standard pattern for reliable Web Audio
// timing — see e.g. Chris Wilson's "A Tale of Two Clocks") drives all three,
// checking in every 40ms and queuing any notes due in the next 120ms via the
// AudioContext's own clock so tempo stays steady even if the tab briefly
// stutters, rather than trusting setTimeout's own timing directly.

const NOTE = { C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.0, A4: 440.0, C5: 523.25, D5: 587.33, E5: 659.25 };
const BASS = { C2: 65.41, D2: 73.42, E2: 82.41, G2: 98.0, A2: 110.0 };

// Each station's `step(i, sched)` runs once per 16th-note tick (i wraps
// every `steps`); `sched(fn, t)` is how a station schedules a sound at
// AudioContext time `t` — see RadioSystem._scheduler below.
const STATIONS = [
  {
    name: '📻 Synth FM',
    stepDur: 0.155, // ~97 BPM in 16th notes — upbeat but not frantic
    steps: 16,
    build(radio) {
      const arp = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.G4, NOTE.E4, NOTE.A4, NOTE.C5];
      const lead = [null, null, NOTE.E5, null, null, null, NOTE.D5, null, null, null, NOTE.C5, null, null, NOTE.G4, null, null];
      return (i, t) => {
        radio._playTone(t, arp[i % arp.length], 0.14, 'square', 0.05, 1400);
        const l = lead[i % lead.length];
        if (l) radio._playTone(t, l, 0.3, 'triangle', 0.09, 2200);
      };
    },
  },
  {
    name: '🎸 Rock FM',
    stepDur: 0.19, // ~79 BPM — heavier, slower groove
    steps: 16,
    build(radio) {
      const bassLine = [BASS.E2, null, BASS.E2, null, BASS.G2, null, BASS.E2, null, BASS.D2, null, BASS.D2, null, BASS.E2, null, null, null];
      const kick = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0];
      const snare = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
      return (i, t) => {
        const b = bassLine[i % bassLine.length];
        if (b) radio._playTone(t, b, 0.22, 'sawtooth', 0.16, 900);
        if (kick[i % kick.length]) radio._playThump(t);
        if (snare[i % snare.length]) radio._playSnare(t);
      };
    },
  },
  {
    name: '🎙️ Talk Radio',
    stepDur: 0.24,
    steps: 8,
    build(radio) {
      // No music at all — irregular short voice-band noise bursts (some
      // steps skip entirely) so it reads as speech cadence, not a beat.
      return (i, t) => {
        if (Math.random() < 0.72) radio._playVoiceBurst(t, 0.09 + Math.random() * 0.14);
      };
    },
  },
];

export class RadioSystem {
  constructor(audioSystem) {
    this.audio = audioSystem; // shares its AudioContext + masterGain
    this.stationIndex = -1; // -1 = off
    this._timer = null;
    this._nextNoteTime = 0;
    this._stepIndex = 0;
    this._stepFn = null;
  }

  get stationName() {
    return this.stationIndex < 0 ? 'выключено' : STATIONS[this.stationIndex].name;
  }

  /** Q key: off → station 1 → 2 → 3 → off → … Returns the new station name for the HUD toast. */
  cycle() {
    if (!this.audio.ready) return 'выключено'; // no AudioContext yet (before the player clicked "Сесть за руль")
    this._stop();
    this.stationIndex = this.stationIndex + 1 >= STATIONS.length ? -1 : this.stationIndex + 1;
    if (this.stationIndex >= 0) this._start(STATIONS[this.stationIndex]);
    return this.stationName;
  }

  _ensureBus() {
    if (this.gain) return;
    const ctx = this.audio.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0.55; // sits under the engine/impact sounds, not over them
    gain.connect(this.audio.masterGain);
    this.gain = gain;
  }

  _start(station) {
    this._ensureBus();
    const ctx = this.audio.ctx;
    this._stepFn = station.build(this);
    this._stepDur = station.stepDur;
    this._stepCount = station.steps;
    this._stepIndex = 0;
    this._nextNoteTime = ctx.currentTime + 0.05;
    // Standard Web-Audio lookahead scheduler: a real setInterval "tick" just
    // decides WHICH notes are due soon, but every note itself still gets
    // scheduled against the AudioContext's own sample-accurate clock (the
    // `t` passed into _playTone/_playThump/etc. below) — that's what keeps
    // the beat steady even if this setInterval callback itself fires a few
    // ms late under load.
    this._timer = setInterval(() => {
      while (this._nextNoteTime < ctx.currentTime + 0.12) {
        this._stepFn(this._stepIndex, this._nextNoteTime);
        this._stepIndex = (this._stepIndex + 1) % this._stepCount;
        this._nextNoteTime += this._stepDur;
      }
    }, 40);
  }

  _stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ---- small procedural instrument palette, shared across stations ----

  _playTone(t, freq, dur, type, vol, filterHz) {
    if (!freq) return;
    const ctx = this.audio.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = filterHz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    osc.connect(filt).connect(g).connect(this.gain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  _playThump(t) {
    const ctx = this.audio.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(g).connect(this.gain);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  _playSnare(t) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.audio.noiseBuffer;
    src.playbackRate.value = 1.6;
    const filt = ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    src.connect(filt).connect(g).connect(this.gain);
    src.start(t);
    src.stop(t + 0.12);
  }

  _playVoiceBurst(t, dur) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.audio.noiseBuffer;
    src.playbackRate.value = 0.6 + Math.random() * 0.3;
    // Two stacked bandpasses roughly around vowel formants — reads as
    // muffled speech cadence, not white noise, without ever needing actual
    // recorded (or synthesized) words.
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 500 + Math.random() * 200;
    f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1500 + Math.random() * 400;
    f2.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + dur * 0.2);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(f1).connect(f2).connect(g).connect(this.gain);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}
