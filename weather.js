// A small set of weather/time presets — not a full day/night cycle, just
// discrete looks the player can pick from the settings/phone UI: sun
// intensity + color, fog density, sky gradient, a rain particle effect, and
// a "wet road" material tweak (glossier, less rough) while it's raining.
//
// Round-4 realism pass ("сделай погоду реалистичнее"): three concrete gaps
// from the original version, each independently fixable —
//  1) Switching weather used to SNAP every value (sun, fog, sky, road
//     wetness) instantly the frame the player picked a new preset from
//     settings. Real weather never changes in a single frame; this now
//     eases every value from its current live state to the new preset's
//     target over a few seconds (see the transition fields on
//     WeatherSystem / its update()).
//  2) Rain fell perfectly straight down, uniformly, with no wind at all —
//     visually a "special effect" rather than actual weather. Drops now
//     fall along a fixed wind-angled vector (tilted instances, drifting
//     x/z) instead of straight down.
//  3) Rain had no weather "event" texture to it — real rainstorms include
//     the occasional lightning flash + delayed thunder rumble. Added as a
//     low-probability random trigger while the 'rain' preset is active.

import { rand } from './utils.js';

const RAIN_COUNT = 500;
const RAIN_VOLUME = { x: 70, y: 45, z: 70 };
const RAIN_FALL_SPEED = 30;
// Horizontal drift while falling — real rain essentially never falls
// perfectly straight down; even a light breeze visibly slants it. This is
// what turns "particles moving down" into "wind-blown rain".
const WIND = { x: 6, z: 3.5 };

function buildRain(THREE) {
  const geo = new THREE.CylinderGeometry(0.012, 0.012, 0.55, 4);
  const mat = new THREE.MeshBasicMaterial({ color: 0xaed4ff, transparent: true, opacity: 0.45, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geo, mat, RAIN_COUNT);
  mesh.visible = false;
  mesh.frustumCulled = false; // it's a volume that follows the camera everywhere — never worth culling away
  const drops = [];
  for (let i = 0; i < RAIN_COUNT; i++) {
    drops.push({
      x: rand(-RAIN_VOLUME.x / 2, RAIN_VOLUME.x / 2),
      y: rand(0, RAIN_VOLUME.y),
      z: rand(-RAIN_VOLUME.z / 2, RAIN_VOLUME.z / 2),
    });
  }
  const dummy = new THREE.Object3D();
  // One shared tilt for every drop, computed once from the fall+wind vector
  // (a cylinder's own axis is Y by default, so this is the rotation that
  // takes "pointing up" to "pointing along the direction the rain is
  // actually falling"). Real wind-blown rain all slants the same way at
  // any given moment, so sharing one quaternion across all 500 instances is
  // both correct and far cheaper than computing 500 individual ones.
  const fallDir = new THREE.Vector3(WIND.x, -RAIN_FALL_SPEED, WIND.z).normalize();
  const tiltQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), fallDir.clone().negate());
  function sync() {
    for (let i = 0; i < RAIN_COUNT; i++) {
      dummy.position.set(drops[i].x, drops[i].y, drops[i].z);
      dummy.quaternion.copy(tiltQuat);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  sync();
  return {
    mesh,
    update(dt, followPos) {
      for (const d of drops) {
        d.y -= RAIN_FALL_SPEED * dt;
        d.x += WIND.x * dt;
        d.z += WIND.z * dt;
        if (d.y < -2) {
          // Reseed the whole position (not just y) — letting x/z keep
          // drifting from wind forever would eventually walk every drop
          // outside the volume; a real rainstorm looks the same everywhere
          // within it, so a fresh random spot reads identically to letting
          // the old one keep falling.
          d.y = RAIN_VOLUME.y;
          d.x = rand(-RAIN_VOLUME.x / 2, RAIN_VOLUME.x / 2);
          d.z = rand(-RAIN_VOLUME.z / 2, RAIN_VOLUME.z / 2);
        }
      }
      mesh.position.set(followPos.x, 0, followPos.z);
      sync();
    },
  };
}

const PRESETS = {
  clear: { sunMul: 1, fogMul: 1, hemiMul: 1, sky: 'clear', rain: false, wet: false },
  cloudy: { sunMul: 0.5, fogMul: 1.7, hemiMul: 0.8, sky: 'overcast', rain: false, wet: false },
  rain: { sunMul: 0.38, fogMul: 2.3, hemiMul: 0.65, sky: 'overcast', rain: true, wet: true },
  night: { sunMul: 0.1, fogMul: 1.3, hemiMul: 0.3, sky: 'night', rain: false, wet: false },
};

export const WEATHER_NAMES = { clear: 'Ясно', cloudy: 'Облачно', rain: 'Дождь', night: 'Ночь' };

const TRANSITION_DURATION = 3.5; // seconds to ease between presets, instead of snapping

export class WeatherSystem {
  // `audio`: optional AudioSystem instance (see audio.js's playThunder) —
  // when provided, a rain-weather lightning strike also plays a delayed
  // thunder rumble; entirely optional so this class still works standalone.
  // `dayNight`: optional DayNightCycle instance (see dayNightCycle.js).
  // Round 9: previously `this.base` was a fixed snapshot of the sun/hemi/
  // fog/sky values taken once at construction, and every preset here was
  // just a flat percentage of THAT one unchanging number forever. With a
  // day/night cycle now moving the sun on its own clock, that snapshot has
  // to become a LIVE read instead — see _presetValues() below — so that
  // e.g. "Дождь" actually looks different at noon than at midnight, rather
  // than always subtracting the same fixed amount from a value that never
  // otherwise moved. Sun POSITION and HUE stay entirely DayNightCycle's own
  // job (see that file) — this class still only ever touches intensity,
  // fog, the hemisphere light, the sky gradient, and road wetness.
  constructor(THREE, scene, city, roadMat, audio = null, dayNight = null) {
    this.THREE = THREE;
    this.scene = scene;
    this.sun = city.sun;
    this.hemi = city.hemi;
    this.skyMat = city.skyMat;
    this.roadMat = roadMat;
    this.audio = audio;
    this.dayNight = dayNight;
    // Round 13 ("вода, лужи, дождь"): the puddle decals city.js scatters
    // along the roads (see buildPuddles()) start fully invisible — this
    // just grabs their shared material so its opacity can fade in/out with
    // the exact same transition machinery already driving roadRough/roadEnv
    // below, rather than adding a second, parallel fade system.
    this.puddleMat = city.puddles ? city.puddles.material : null;

    this.base = {
      sunI: this.sun.intensity,
      fogD: scene.fog.density,
      hemiI: this.hemi.intensity,
      hemiSky: this.hemi.color.clone(),
      hemiGround: this.hemi.groundColor.clone(),
      top: this.skyMat.uniforms.topColor.value.clone(),
      bottom: this.skyMat.uniforms.bottomColor.value.clone(),
      fogColor: scene.fog.color.clone(),
      roadRough: roadMat.roughness,
      roadEnv: roadMat.envMapIntensity ?? 1,
      puddleOpacity: this.puddleMat ? this.puddleMat.opacity : 0,
    };
    this.skyTargets = {
      clear: { top: this.base.top.clone(), bottom: this.base.bottom.clone() },
      overcast: { top: new THREE.Color(0x5a6270), bottom: new THREE.Color(0x8a8f96) },
      night: { top: new THREE.Color(0x03040a), bottom: new THREE.Color(0x11151f) },
    };

    this.rain = buildRain(THREE);
    scene.add(this.rain.mesh);

    this._t = 1;
    this._from = null;
    this._to = null;
    this._flashT = 0;
    this._flashDur = 0;
    this._lightningCooldown = rand(5, 14);

    this.current = 'clear';
    this.set('clear', true);
  }

  // Live base values every preset's percentages multiply against — the
  // day/night cycle's current sun/hemi/sky/fog when one is attached,
  // otherwise the fixed construction-time snapshot (so this class still
  // works standalone, e.g. in older tests, without a DayNightCycle).
  _liveBase() {
    return this.dayNight ? this.dayNight.getBase() : this.base;
  }

  _presetValues(name) {
    const p = PRESETS[name] || PRESETS.clear;
    const live = this._liveBase();
    // 'clear' tracks whatever the sky actually looks like right now (so it's
    // the one preset that visibly cycles through day/night); 'overcast' and
    // 'night' stay their own fixed look regardless of time of day — an
    // overcast sky reads about the same at 9am or 4pm, and picking "Ночь"
    // is meant to force actual darkness even if the cycle's clock currently
    // says otherwise.
    const sky = p.sky === 'clear' ? { top: live.top, bottom: live.bottom } : (this.skyTargets[p.sky] || this.skyTargets.clear);
    return {
      sunI: live.sunI * p.sunMul,
      fogD: this.base.fogD * p.fogMul,
      fogColor: live.fogColor || this.base.fogColor,
      hemiI: live.hemiI * p.hemiMul,
      hemiSky: live.hemiSky || this.base.hemiSky,
      hemiGround: live.hemiGround || this.base.hemiGround,
      top: sky.top,
      bottom: sky.bottom,
      roadRough: p.wet ? Math.max(0.12, this.base.roadRough * 0.3) : this.base.roadRough,
      roadEnv: p.wet ? 1.7 : this.base.roadEnv,
      puddleOpacity: p.wet ? 0.75 : 0,
      rain: p.rain,
    };
  }

  _applyValues(v) {
    this.sun.intensity = v.sunI;
    this.scene.fog.density = v.fogD;
    this.scene.fog.color.copy(v.fogColor);
    this.hemi.intensity = v.hemiI;
    this.hemi.color.copy(v.hemiSky);
    this.hemi.groundColor.copy(v.hemiGround);
    this.skyMat.uniforms.topColor.value.copy(v.top);
    this.skyMat.uniforms.bottomColor.value.copy(v.bottom);
    this.roadMat.roughness = v.roadRough;
    this.roadMat.envMapIntensity = v.roadEnv;
    if (this.puddleMat) this.puddleMat.opacity = v.puddleOpacity;
  }

  /** `instant`: skip the fade (used for the very first call, at construction,
   * before the scene is ever shown to the player — nothing to ease from). */
  set(name, instant = false) {
    const target = this._presetValues(name);
    this.current = PRESETS[name] ? name : 'clear';
    this._from = {
      sunI: this.sun.intensity,
      fogD: this.scene.fog.density,
      fogColor: this.scene.fog.color.clone(),
      hemiI: this.hemi.intensity,
      hemiSky: this.hemi.color.clone(),
      hemiGround: this.hemi.groundColor.clone(),
      top: this.skyMat.uniforms.topColor.value.clone(),
      bottom: this.skyMat.uniforms.bottomColor.value.clone(),
      roadRough: this.roadMat.roughness,
      roadEnv: this.roadMat.envMapIntensity ?? 1,
      puddleOpacity: this.puddleMat ? this.puddleMat.opacity : 0,
    };
    this._to = target;
    this._t = instant ? 1 : 0;
    // Rain visibility turns on immediately at the START of a transition
    // INTO rain (so drops are already falling as the sky darkens toward
    // it) but only turns off once a transition AWAY from rain finishes
    // (so it doesn't just vanish mid-fade while everything's still wet).
    if (target.rain) this.rain.mesh.visible = true;
    this._rainFadeOut = !target.rain;
    if (instant) {
      this._applyValues(target);
      if (!target.rain) this.rain.mesh.visible = false;
    }
  }

  update(dt, followPos) {
    // Advance the sun's own clock first (position + hue — entirely its own
    // concern, see dayNightCycle.js) so everything below already reads
    // this frame's up-to-date live base, not last frame's. Re-center its
    // orbit (and shadow target) on the player first, using the same
    // followPos the rain system already gets — see the shrunk shadow
    // frustum comment in city.js for why this matters.
    if (this.dayNight) {
      if (followPos) this.dayNight.setFollowPosition(followPos);
      this.dayNight.update(dt);
    }

    if (this._t < 1) {
      this._t = Math.min(1, this._t + dt / TRANSITION_DURATION);
      const s = this._t;
      const lerp = (a, b) => a + (b - a) * s;
      this.sun.intensity = lerp(this._from.sunI, this._to.sunI);
      this.scene.fog.density = lerp(this._from.fogD, this._to.fogD);
      this.scene.fog.color.copy(this._from.fogColor).lerp(this._to.fogColor, s);
      this.hemi.intensity = lerp(this._from.hemiI, this._to.hemiI);
      this.hemi.color.copy(this._from.hemiSky).lerp(this._to.hemiSky, s);
      this.hemi.groundColor.copy(this._from.hemiGround).lerp(this._to.hemiGround, s);
      this.skyMat.uniforms.topColor.value.copy(this._from.top).lerp(this._to.top, s);
      this.skyMat.uniforms.bottomColor.value.copy(this._from.bottom).lerp(this._to.bottom, s);
      this.roadMat.roughness = lerp(this._from.roadRough, this._to.roadRough);
      this.roadMat.envMapIntensity = lerp(this._from.roadEnv, this._to.roadEnv);
      if (this.puddleMat) this.puddleMat.opacity = lerp(this._from.puddleOpacity, this._to.puddleOpacity);
      if (this._t >= 1 && this._rainFadeOut) this.rain.mesh.visible = false;
    } else if (this.dayNight) {
      // No weather-preset transition in flight, but the day/night base is
      // still moving underneath — recompute the current preset's live
      // values fresh every frame so e.g. plain "Ясно" keeps cycling through
      // day/night instead of freezing at whatever it looked like the
      // moment the last transition finished.
      this._applyValues(this._presetValues(this.current));
    }

    if (this.rain.mesh.visible) this.rain.update(dt, followPos);

    // Lightning: only while actually raining, on a random multi-second
    // cooldown so strikes feel occasional rather than metronomic.
    if (this.current === 'rain') {
      this._lightningCooldown -= dt;
      if (this._lightningCooldown <= 0) {
        this._triggerLightning();
        this._lightningCooldown = rand(6, 18);
      }
    }
    if (this._flashT > 0) {
      this._flashT = Math.max(0, this._flashT - dt);
      // Quick bright spike that decays back to the current target values —
      // written AFTER the transition lerp above so a flash during an
      // in-progress fade still reads correctly on top of it.
      const k = this._flashT / this._flashDur;
      this.hemi.intensity = this._to.hemiI * (1 + k * k * 5);
      this.sun.intensity = this._to.sunI + (this.base.sunI - this._to.sunI) * k * 0.7;
    }
  }

  _triggerLightning() {
    this._flashDur = 0.1 + Math.random() * 0.12;
    this._flashT = this._flashDur;
    if (this.audio && typeof this.audio.playThunder === 'function') {
      // Thunder arrives after the flash, not with it — the delay stands in
      // for "the strike is some distance away", same as real lightning.
      const delayMs = (0.4 + Math.random() * 2.4) * 1000;
      setTimeout(() => this.audio.playThunder(), delayMs);
    }
  }
}
