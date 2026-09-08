// Round 9 ("время суток" — a real day/night cycle instead of a fixed
// dusk look). Previously the whole scene was lit by one never-moving sun
// (city.js set its position once at startup and nothing ever touched it
// again) with only a handful of DISCRETE, manually-picked "weather"
// presets (see weather.js) — including a 'night' option that was really
// just "dim everything down", not an actual different sun position/sky.
//
// This module owns the sun's POSITION and COLOR and the stars' opacity,
// continuously advancing through a stylised 24h cycle on a slow real-time
// clock — nothing the player has to turn on, the same way a GTA-style game
// just always has a moving sun. It deliberately does NOT touch sun
// intensity, fog, the hemisphere light, or the sky gradient directly:
// weather.js already owns smoothly blending those (including its own
// preset transitions), so instead this exposes getBase() — a live,
// continuously-updated version of what used to be a fixed snapshot
// (`this.base`) inside WeatherSystem — and weather.js's preset percentages
// multiply against THAT instead. That's what makes e.g. picking "Дождь" at
// 3pm vs. at midnight actually look different (dim daytime rain vs. dark
// nighttime rain) instead of always subtracting the same fixed amount from
// a value that never otherwise changed.
//
// The very first frame of the cycle is pinned to exactly reproduce the
// game's long-tuned "dusk" baseline (same sun elevation implied by its old
// fixed position, same colors) — brightness has been adjusted more than
// once across earlier rounds specifically to stop being "too bright", and
// this only ever drifts forward from that tuned point, never retroactively
// changes what a fresh page load looks like at t=0.

const CYCLE_SECONDS = 1200; // 20 real minutes per in-game day — slow enough to read as ambient atmosphere, not a timelapse; still easily seen within one normal play session

function lerpColor(THREE, hexA, hexB, s) {
  return new THREE.Color(hexA).lerp(new THREE.Color(hexB), s);
}

// Keyframes across one stylised day, `t` ascending 0→1 (0 and 1 are the
// same instant — midnight). `elevation` is the sun's angle above the
// horizon in degrees (negative = below it). Colors are plain hex ints,
// converted to THREE.Color only when sampled.
const KEYFRAMES = [
  { t: 0.00, elevation: -30, sunColor: 0x8fb0ff, sunMul: 0.06, hemiSky: 0x1c2444, hemiGround: 0x05050a, hemiMul: 0.42, skyTop: 0x03040a, skyBottom: 0x11151f, fogTint: 0x0c1020, starOpacity: 1.0 },
  { t: 0.22, elevation: 14, sunColor: 0xffd9a8, sunMul: 0.55, hemiSky: 0x6f86c9, hemiGround: 0x241c14, hemiMul: 0.55, skyTop: 0x2b3a68, skyBottom: 0xe0a06a, fogTint: 0xb87a5c, starOpacity: 0.35 },
  { t: 0.50, elevation: 70, sunColor: 0xfff6e0, sunMul: 1.15, hemiSky: 0xaed0ff, hemiGround: 0x4a4636, hemiMul: 0.95, skyTop: 0x2f6fc2, skyBottom: 0xbfe0f5, fogTint: 0xcfe3ef, starOpacity: 0.0 },
  // "Dusk" — exactly the pre-existing tuned baseline (sun elevation backed
  // out from the old fixed position (-140, 120, -80): atan2(120, |(-140,-80)|)
  // ≈ 36.6°; sun color 0xffd9a8 @ intensity mul 1; hemi 0x8fa8ff/0x30261a
  // @ mul 1; sky 0x1b2a52/0xffb27a; fog tint 0xd68a5c — every one of these
  // is the literal existing value from city.js, not a new invention).
  { t: 0.78, elevation: 36.6, sunColor: 0xffd9a8, sunMul: 1.0, hemiSky: 0x8fa8ff, hemiGround: 0x30261a, hemiMul: 1.0, skyTop: 0x1b2a52, skyBottom: 0xffb27a, fogTint: 0xd68a5c, starOpacity: 0.15 },
  { t: 1.00, elevation: -30, sunColor: 0x8fb0ff, sunMul: 0.06, hemiSky: 0x1c2444, hemiGround: 0x05050a, hemiMul: 0.42, skyTop: 0x03040a, skyBottom: 0x11151f, fogTint: 0x0c1020, starOpacity: 1.0 },
];

function sampleKeyframes(THREE, t) {
  let i = 0;
  while (i < KEYFRAMES.length - 2 && KEYFRAMES[i + 1].t <= t) i++;
  const a = KEYFRAMES[i], b = KEYFRAMES[i + 1];
  const span = b.t - a.t || 1;
  const s = Math.min(1, Math.max(0, (t - a.t) / span));
  return {
    elevation: a.elevation + (b.elevation - a.elevation) * s,
    sunColor: lerpColor(THREE, a.sunColor, b.sunColor, s),
    sunMul: a.sunMul + (b.sunMul - a.sunMul) * s,
    hemiSky: lerpColor(THREE, a.hemiSky, b.hemiSky, s),
    hemiGround: lerpColor(THREE, a.hemiGround, b.hemiGround, s),
    hemiMul: a.hemiMul + (b.hemiMul - a.hemiMul) * s,
    skyTop: lerpColor(THREE, a.skyTop, b.skyTop, s),
    skyBottom: lerpColor(THREE, a.skyBottom, b.skyBottom, s),
    fogTint: lerpColor(THREE, a.fogTint, b.fogTint, s),
    starOpacity: a.starOpacity + (b.starOpacity - a.starOpacity) * s,
  };
}

export class DayNightCycle {
  constructor(THREE, city) {
    this.THREE = THREE;
    this.sun = city.sun;
    this.starsMat = city.starsMat || null;
    this.baseSunIntensity = city.sun.intensity;
    this.baseHemiIntensity = city.hemi.intensity;
    this._starBaseOpacity = this.starsMat ? this.starsMat.opacity : 0.75;

    // Preserve the sun's existing horizontal compass direction (only its
    // ELEVATION changes through the cycle) and distance, so at t=0.78
    // (the dusk keyframe, elevation 36.6°) the sun lands EXACTLY back on
    // its old fixed position — see the keyframe comment above.
    this._dist = city.sun.position.length();
    const horizLen = Math.hypot(city.sun.position.x, city.sun.position.z) || 1;
    this._horiz = { x: city.sun.position.x / horizLen, y: city.sun.position.z / horizLen };

    this.enabled = true;
    this.t = 0.78; // start already at the tuned dusk baseline — see file header
    this.profile = sampleKeyframes(THREE, this.t);

    // Round 9 ("лучше тени" — shadow follows the player): the sun now
    // orbits a movable target instead of always the world origin, so its
    // shadow camera (shrunk in city.js from covering the whole city down to
    // a tight box, see the comment there) stays centered on wherever the
    // player actually is. Defaults to the origin until main.js starts
    // calling setFollowPosition() every frame, so nothing breaks if that's
    // ever skipped (e.g. before the player's car exists yet).
    this._followPos = new THREE.Vector3(0, 0, 0);

    this._applySun();
  }

  setFollowPosition(pos) {
    this._followPos.copy(pos);
  }

  _applySun() {
    const elevRad = this.THREE.MathUtils.degToRad(this.profile.elevation);
    const horizDist = this._dist * Math.cos(elevRad);
    const height = this._dist * Math.sin(elevRad);
    this.sun.position.set(
      this._followPos.x + this._horiz.x * horizDist,
      height,
      this._followPos.z + this._horiz.y * horizDist
    );
    this.sun.target.position.copy(this._followPos);
    this.sun.color.copy(this.profile.sunColor);
  }

  update(dt) {
    if (!this.enabled) return;
    this.t = (this.t + dt / CYCLE_SECONDS) % 1;
    this.profile = sampleKeyframes(this.THREE, this.t);
    this._applySun();
    if (this.starsMat) this.starsMat.opacity = this.profile.starOpacity * this._starBaseOpacity;
  }

  // What WeatherSystem multiplies its preset percentages against every
  // frame, instead of a value captured once and fixed forever.
  getBase() {
    return {
      sunI: this.baseSunIntensity * this.profile.sunMul,
      hemiI: this.baseHemiIntensity * this.profile.hemiMul,
      hemiSky: this.profile.hemiSky,
      hemiGround: this.profile.hemiGround,
      top: this.profile.skyTop,
      bottom: this.profile.skyBottom,
      fogColor: this.profile.fogTint,
    };
  }
}
