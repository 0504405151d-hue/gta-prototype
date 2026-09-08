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
// Round 9 ("музыка по радио хотя бы 3 минуты разная но 1 мелодия, больше
// радиостанций"): the original 3 stations each just looped a single ~2.5-4s
// pattern forever — fine as a proof of concept, but it very quickly reads as
// "the same 8 notes on repeat" rather than a real song. Every MUSICAL
// station (all but Talk Radio) is now built as a real song STRUCTURE: one
// underlying theme (the arpeggio/hook/chord progression — the "1 мелодия")
// is defined once and reused for the station's entire runtime, but the
// ARRANGEMENT around it changes as the song moves through sections — a
// quiet intro, a sparser verse, a fuller chorus, a bridge that varies the
// same material (a different octave/interval, stripped-down drums, etc.),
// and an outro that fades back down — the same way a real radio song has
// dynamics instead of being one static loop. Each station's full structure
// runs at least ~3 minutes before it loops back to its own intro; a player
// who leaves the radio on that long hearing the "song" restart is normal
// radio behavior, not a bug. Two new stations (Pop FM, Classic FM, Chill
// FM — three, not two, since the extra one was cheap once the shared
// section-structure machinery existed) round the dial out to 6 stations
// plus off.
//
// A basic lookahead scheduler (the standard pattern for reliable Web Audio
// timing — see e.g. Chris Wilson's "A Tale of Two Clocks") drives all
// stations, checking in every 40ms and queuing any notes due in the next
// 120ms via the AudioContext's own clock so tempo stays steady even if the
// tab briefly stutters, rather than trusting setTimeout's own timing
// directly. This didn't need to change for the longer song structures —
// `steps` (how many ticks before the whole thing loops) is just a much
// bigger number now than "one bar", the scheduler itself doesn't care.

const NOTE = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25,
};
const BASS = { C2: 65.41, D2: 73.42, E2: 82.41, G2: 98.0, A2: 110.0 };

// A station's full runtime is carved into named sections (in this fixed
// order, looping back to 'intro' after 'outro') so every station gets the
// same "quiet start → verse → chorus → verse → chorus → bridge → chorus →
// fade out" shape without hand-writing bar counts per station — only the
// TOTAL bar count differs (tempo varies a lot station to station, so the
// bar count needed to reach the same ~3+ minutes does too).
function makeSectionPlan(totalBars) {
  const layout = [
    ['intro', 0.06], ['verse', 0.16], ['chorus', 0.16], ['verse', 0.16],
    ['chorus', 0.16], ['bridge', 0.14], ['chorus', 0.11], ['outro', 0.05],
  ];
  const defs = [];
  let used = 0;
  layout.forEach(([type, w], idx) => {
    const bars = idx === layout.length - 1 ? Math.max(1, totalBars - used) : Math.max(1, Math.round(totalBars * w));
    used += bars;
    defs.push({ type, bars });
  });
  return defs;
}

// Expands a section plan into a flat per-bar lookup, so a station's step
// function can just ask "what section (and where in the current bar) is
// step i in" without re-deriving it from scratch every tick.
function buildSectionTimeline(totalBars, stepsPerBar) {
  const plan = makeSectionPlan(totalBars);
  const bars = [];
  for (const { type, bars: n } of plan) for (let b = 0; b < n; b++) bars.push(type);
  const totalSteps = bars.length * stepsPerBar;
  return {
    totalSteps,
    sectionAt(i) { return bars[Math.floor(i / stepsPerBar) % bars.length]; },
    localStep(i) { return i % stepsPerBar; },
  };
}

// Same idea as buildSectionTimeline, but for Talk Radio, which doesn't have
// bars/a melody at all — just a repeating sequence of differently-sized
// "segments" (chatter / a short station-ID jingle / a beat of dead air).
function buildStepSegments(defs) {
  const arr = [];
  for (const { type, steps: n } of defs) for (let s = 0; s < n; s++) arr.push(type);
  return { totalSteps: arr.length, at(i) { return arr[i % arr.length]; } };
}

// ---- per-station song structures (computed once, shared by every play-through) ----
const synthTimeline = buildSectionTimeline(78, 16); // 78 bars × 16 steps × 0.155s ≈ 193s
const rockTimeline = buildSectionTimeline(64, 16); // 64 × 16 × 0.19s ≈ 194s
const popTimeline = buildSectionTimeline(82, 16); // 82 × 16 × 0.121s ≈ 159s... see note below
const classicTimeline = buildSectionTimeline(44, 16); // 44 × 16 × 0.28s ≈ 197s
const chillTimeline = buildSectionTimeline(58, 16); // 58 × 16 × 0.21s ≈ 195s
// Pop FM's bar count above undershoots 3 minutes on its own (124 BPM is
// just fast), so its bar count is bumped a little further below the shared
// layout's usual ratio — see popTimelineFast.
const popTimelineFast = buildSectionTimeline(96, 16); // 96 × 16 × 0.121s ≈ 186s

const talkPatternOnce = [
  { type: 'chatter', steps: 40 }, { type: 'jingle', steps: 6 }, { type: 'chatter', steps: 50 },
  { type: 'pause', steps: 14 }, { type: 'chatter', steps: 45 }, { type: 'jingle', steps: 6 },
  { type: 'chatter', steps: 55 }, { type: 'pause', steps: 10 }, { type: 'chatter', steps: 48 },
  { type: 'jingle', steps: 6 }, { type: 'chatter', steps: 52 }, { type: 'pause', steps: 12 },
  { type: 'chatter', steps: 60 }, { type: 'jingle', steps: 6 }, { type: 'chatter', steps: 50 },
];
// Two passes of the same segment layout comfortably clears 3 minutes (each
// segment's actual content is still randomized inside its handler below, so
// this doesn't sound like a literal instant-replay the second time through).
const talkSegments = buildStepSegments([...talkPatternOnce, ...talkPatternOnce]);

// Each station's `step(i, sched)` runs once per 16th-note tick (i wraps
// every `steps`); `sched(fn, t)` is how a station schedules a sound at
// AudioContext time `t` — see RadioSystem._scheduler below.
const STATIONS = [
  {
    name: '📻 Synth FM',
    stepDur: 0.155, // ~97 BPM in 16th notes — upbeat but not frantic
    steps: synthTimeline.totalSteps,
    build(radio) {
      const arp = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.G4, NOTE.E4, NOTE.A4, NOTE.C5];
      const lead = [null, null, NOTE.E5, null, null, null, NOTE.D5, null, null, null, NOTE.C5, null, null, NOTE.G4, null, null];
      return (i, t) => {
        const sec = synthTimeline.sectionAt(i);
        const local = synthTimeline.localStep(i);
        if (sec === 'intro' || sec === 'outro') {
          // Same theme, stripped right down to a soft pad hit on the theme's
          // own root notes — the song fading in/out, not snapping straight
          // into the full arrangement.
          if (local === 0) radio._playPad(t, NOTE.C4, 1.6, 0.05, 1200);
          if (local === 8) radio._playPad(t, NOTE.G4, 1.6, 0.05, 1200);
          return;
        }
        const density = sec === 'chorus' ? 1 : sec === 'bridge' ? 0.8 : 0.55;
        radio._playTone(t, arp[local % arp.length], 0.14, 'square', 0.05 + 0.09 * density, 1400);
        const l = lead[local];
        if (l && (sec === 'chorus' || Math.random() < 0.4)) {
          // Bridge: the exact same lead hook, just an octave up — a real
          // variation on the theme rather than new material.
          radio._playTone(t, sec === 'bridge' ? l * 2 : l, 0.3, 'triangle', 0.06 + 0.05 * density, 2200);
        }
      };
    },
  },
  {
    name: '🎸 Rock FM',
    stepDur: 0.19, // ~79 BPM — heavier, slower groove
    steps: rockTimeline.totalSteps,
    build(radio) {
      const bassLine = [BASS.E2, null, BASS.E2, null, BASS.G2, null, BASS.E2, null, BASS.D2, null, BASS.D2, null, BASS.E2, null, null, null];
      const kick = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0];
      const snare = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
      return (i, t) => {
        const sec = rockTimeline.sectionAt(i);
        const local = rockTimeline.localStep(i);
        if (sec === 'intro' || sec === 'outro') {
          if (local === 0 || local === 8) radio._playTone(t, BASS.E2, 0.5, 'sine', 0.08, 500);
          return;
        }
        const b = bassLine[local];
        // Bridge: same bass line, up an octave and with the drums stripped
        // back — a breakdown built from the same riff, not a new one.
        if (b) radio._playTone(t, sec === 'bridge' ? b * 2 : b, 0.22, 'sawtooth', sec === 'chorus' ? 0.19 : 0.13, 900);
        if (sec !== 'bridge' && kick[local]) radio._playThump(t);
        if (sec === 'chorus' && snare[local]) radio._playSnare(t);
        if (sec === 'bridge' && local % 8 === 4) radio._playSnare(t);
      };
    },
  },
  {
    name: '💖 Pop FM',
    stepDur: 0.121, // ~124 BPM — bright, four-on-the-floor
    steps: popTimelineFast.totalSteps,
    build(radio) {
      const hook = [NOTE.C5, null, NOTE.D5, NOTE.E5, null, NOTE.D5, null, NOTE.G4, NOTE.C5, null, NOTE.D5, NOTE.E5, null, NOTE.G4, null, null];
      const bassLine = [BASS.C2, null, null, null, BASS.C2, null, null, null, BASS.G2, null, null, null, BASS.A2, null, null, null];
      const kick = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
      const clap = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
      return (i, t) => {
        const sec = popTimelineFast.sectionAt(i);
        const local = popTimelineFast.localStep(i);
        if (sec === 'intro' || sec === 'outro') {
          if (local === 0) radio._playPad(t, NOTE.C4, 1.2, 0.05, 1500);
          return;
        }
        const b = bassLine[local];
        if (b) radio._playTone(t, b, 0.16, 'triangle', 0.13, 1100);
        if (sec !== 'bridge' && kick[local]) radio._playThump(t);
        if (sec === 'chorus' && clap[local]) radio._playClap(t);
        const h = hook[local];
        if (h && (sec === 'chorus' || Math.random() < 0.5)) {
          radio._playTone(t, sec === 'bridge' ? h / 2 : h, 0.22, 'square', sec === 'chorus' ? 0.13 : 0.08, 2600);
        }
      };
    },
  },
  {
    name: '🎻 Classic FM',
    stepDur: 0.28, // ~54 BPM — slow, graceful, no drums at all
    steps: classicTimeline.totalSteps,
    build(radio) {
      const arp = [
        NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.G4, NOTE.E4, NOTE.D4, NOTE.F4,
        NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.A4, NOTE.G4, NOTE.E4, NOTE.D4,
      ];
      const padChord = [NOTE.C4, NOTE.E4, NOTE.G4];
      return (i, t) => {
        const sec = classicTimeline.sectionAt(i);
        const local = classicTimeline.localStep(i);
        if (sec === 'intro' || sec === 'outro') {
          if (local === 0) radio._playChord(t, padChord, 3.2, 'sine', 0.045, 900);
          return;
        }
        if (local === 0) radio._playChord(t, padChord, 3.2, 'sine', 0.05, 900);
        const n = arp[local];
        const dense = sec === 'chorus' || sec === 'bridge';
        if (n && (dense || local % 2 === 0)) {
          // Bridge: the same arpeggio, transposed up a perfect fifth
          // (freq × 1.5 — a real, in-key interval, not detuned noise).
          radio._playTone(t, sec === 'bridge' ? n * 1.5 : n, 0.55, 'triangle', dense ? 0.1 : 0.065, 2000);
        }
      };
    },
  },
  {
    name: '🌙 Chill FM',
    stepDur: 0.21, // slow, laid-back lo-fi groove
    steps: chillTimeline.totalSteps,
    build(radio) {
      radio._startVinylCrackle();
      const chordA = [NOTE.C4, NOTE.E4, NOTE.A4];
      const chordB = [NOTE.D4, NOTE.F4, NOTE.A4];
      const bassLine = [BASS.C2, null, null, null, null, null, BASS.A2, null, null, null, null, null, null, null, null, null];
      const kick = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0];
      const snare = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
      return (i, t) => {
        const sec = chillTimeline.sectionAt(i);
        const local = chillTimeline.localStep(i);
        if (sec === 'intro' || sec === 'outro') {
          if (local === 0) radio._playChord(t, chordA, 2.2, 'sine', 0.04, 1000);
          return;
        }
        if (local === 0) radio._playChord(t, chordA, 1.8, 'triangle', sec === 'chorus' ? 0.09 : 0.06, 1300);
        if (local === 8) radio._playChord(t, chordB, 1.8, 'triangle', sec === 'chorus' ? 0.08 : 0.05, 1300);
        const b = bassLine[local];
        if (b) radio._playTone(t, b, 0.4, 'sine', 0.11, 500);
        if (sec !== 'bridge' && kick[local]) radio._playThump(t);
        if (sec === 'chorus' && snare[local]) radio._playSnare(t);
      };
    },
  },
  {
    name: '🎙️ Talk Radio',
    stepDur: 0.24,
    steps: talkSegments.totalSteps,
    build(radio) {
      // No music (no melody to build a "song" around, so this station is
      // exempt from the section-timeline treatment above) — instead a
      // repeating sequence of talk / a short station-ID jingle / a beat of
      // dead air, which is what actually reads as "varied over 3+ minutes"
      // for a talk station rather than one continuous murmur.
      const jingleNotes = [NOTE.G4, NOTE.C5, NOTE.E5];
      return (i, t) => {
        const type = talkSegments.at(i);
        if (type === 'chatter') {
          if (Math.random() < 0.72) radio._playVoiceBurst(t, 0.09 + Math.random() * 0.14);
        } else if (type === 'jingle') {
          radio._playTone(t, jingleNotes[Math.floor(Math.random() * jingleNotes.length)], 0.18, 'triangle', 0.1, 2400);
        }
        // 'pause': intentionally silent — a beat of dead air between
        // segments, the way a real talk show actually sounds.
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
    this._crackleSrc = null; // Chill FM's persistent vinyl-crackle texture — see _startVinylCrackle()
  }

  get stationName() {
    return this.stationIndex < 0 ? 'выключено' : STATIONS[this.stationIndex].name;
  }

  /** Q key: off → station 1 → 2 → ... → off → … Returns the new station name for the HUD toast. */
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
    // ms late under load. `steps` is now a whole song's worth of ticks
    // rather than one bar, but the scheduler itself doesn't need to know
    // that — it's still just "wrap the counter and keep going".
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
    if (this._crackleSrc) {
      try { this._crackleSrc.stop(); } catch (e) { /* already stopped */ }
      this._crackleSrc.disconnect();
      this._crackleSrc = null;
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

  // Slow-attack version of _playTone — a pad/string swells in rather than
  // plucking, which is what makes an intro/outro or a sustained backing
  // chord read as "the song breathing" instead of just a quieter pluck.
  _playPad(t, freq, dur, vol, filterHz, type = 'sine') {
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
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(filt).connect(g).connect(this.gain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // Several notes at once via _playPad's shared slow-attack envelope —
  // Classic FM's string pad and Chill FM's chord stabs are both "play this
  // whole chord right now", just with a swell instead of a pluck.
  _playChord(t, freqs, dur, type, vol, filterHz) {
    for (const f of freqs) this._playPad(t, f, dur, vol, filterHz, type);
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

  // Pop FM's backbeat clap — a brighter, shorter bandpassed noise hit than
  // the snare above (a real drum clap sits higher and tighter than a snare).
  _playClap(t) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.audio.noiseBuffer;
    src.playbackRate.value = 2.1;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 1700;
    filt.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(filt).connect(g).connect(this.gain);
    src.start(t);
    src.stop(t + 0.1);
  }

  // Chill FM only: one continuous, very quiet filtered-noise loop running
  // underneath the whole station for a lo-fi "vinyl" texture — unlike every
  // other sound here this isn't a per-tick one-shot, it's started once when
  // the station starts and stopped in _stop() alongside the scheduler.
  _startVinylCrackle() {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.audio.noiseBuffer;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.value = 0.025;
    src.connect(filt).connect(g).connect(this.gain);
    src.start();
    this._crackleSrc = src;
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
