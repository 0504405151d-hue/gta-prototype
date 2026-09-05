// A small set of weather/time presets — not a full day/night cycle, just
// discrete looks the player can pick from the settings/phone UI: sun
// intensity + color, fog density, sky gradient, a rain particle effect, and
// a "wet road" material tweak (glossier, less rough) while it's raining.

import { rand } from './utils.js';

const RAIN_COUNT = 500;
const RAIN_VOLUME = { x: 70, y: 45, z: 70 };
const RAIN_FALL_SPEED = 30;

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
  function sync() {
    for (let i = 0; i < RAIN_COUNT; i++) {
      dummy.position.set(drops[i].x, drops[i].y, drops[i].z);
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
        if (d.y < -2) d.y = RAIN_VOLUME.y;
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

export class WeatherSystem {
  constructor(THREE, scene, city, roadMat) {
    this.THREE = THREE;
    this.scene = scene;
    this.sun = city.sun;
    this.hemi = city.hemi;
    this.skyMat = city.skyMat;
    this.roadMat = roadMat;

    this.base = {
      sunI: this.sun.intensity,
      fogD: scene.fog.density,
      hemiI: this.hemi.intensity,
      top: this.skyMat.uniforms.topColor.value.clone(),
      bottom: this.skyMat.uniforms.bottomColor.value.clone(),
      roadRough: roadMat.roughness,
      roadEnv: roadMat.envMapIntensity ?? 1,
    };
    this.skyTargets = {
      clear: { top: this.base.top.clone(), bottom: this.base.bottom.clone() },
      overcast: { top: new THREE.Color(0x5a6270), bottom: new THREE.Color(0x8a8f96) },
      night: { top: new THREE.Color(0x03040a), bottom: new THREE.Color(0x11151f) },
    };

    this.rain = buildRain(THREE);
    scene.add(this.rain.mesh);

    this.current = 'clear';
    this.set('clear');
  }

  set(name) {
    const p = PRESETS[name] || PRESETS.clear;
    this.current = PRESETS[name] ? name : 'clear';
    this.sun.intensity = this.base.sunI * p.sunMul;
    this.scene.fog.density = this.base.fogD * p.fogMul;
    this.hemi.intensity = this.base.hemiI * p.hemiMul;
    const sky = this.skyTargets[p.sky] || this.skyTargets.clear;
    this.skyMat.uniforms.topColor.value.copy(sky.top);
    this.skyMat.uniforms.bottomColor.value.copy(sky.bottom);
    this.roadMat.roughness = p.wet ? Math.max(0.12, this.base.roadRough * 0.3) : this.base.roadRough;
    this.roadMat.envMapIntensity = p.wet ? 1.7 : this.base.roadEnv;
    this.rain.mesh.visible = p.rain;
  }

  update(dt, followPos) {
    if (this.rain.mesh.visible) this.rain.update(dt, followPos);
  }
}
