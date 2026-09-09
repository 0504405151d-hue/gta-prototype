// Lightweight visual-only effects: impact dust/sparks/smoke particles and
// tire skid marks. None of this touches physics or the network layer — it's
// pure eye-candy driven by events other modules already produce (collisions,
// wheel skid state), pooled and capped so it stays cheap at prototype scale.

import { rand, choice, buildSoftDotTexture } from './utils.js';

const MAX_PARTICLES = 220;
const MAX_SKID_QUADS = 500;

export class EffectsSystem {
  constructor(THREE, scene) {
    this.THREE = THREE;
    this.scene = scene;
    this.particles = []; // { sprite, vel:Vector3, life, maxLife, gravity, fadeIn }
    this.skidGroup = new THREE.Group();
    scene.add(this.skidGroup);
    this.skidQuads = []; // { mesh, life }
    this.dotTex = buildSoftDotTexture(THREE);
  }

  _spawnParticle({ position, velocity, size = 0.3, color = 0xffffff, life = 0.6, gravity = -9.8, opacity = 0.85 }) {
    const { THREE } = this;
    if (this.particles.length >= MAX_PARTICLES) {
      const oldest = this.particles.shift();
      this.scene.remove(oldest.sprite);
      oldest.sprite.material.dispose();
    }
    const mat = new THREE.SpriteMaterial({
      map: this.dotTex,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(position);
    sprite.scale.setScalar(size);
    this.scene.add(sprite);
    this.particles.push({ sprite, velocity: velocity.clone(), life, maxLife: life, gravity, baseSize: size, baseOpacity: opacity });
  }

  /** A shower of small stone/wood chip sparks — used for impacts against hard props/buildings. */
  spawnSparks(position, count = 10) {
    const { THREE } = this;
    for (let i = 0; i < count; i++) {
      const vel = new THREE.Vector3(rand(-4, 4), rand(2, 6), rand(-4, 4));
      this._spawnParticle({
        position,
        velocity: vel,
        size: rand(0.08, 0.18),
        color: 0xffcf6b,
        life: rand(0.25, 0.5),
        gravity: -14,
        opacity: 1,
      });
    }
  }

  /** Soft dust puff — used for lighter scrapes and for tires kicking up dirt. */
  spawnDust(position, count = 5) {
    const { THREE } = this;
    for (let i = 0; i < count; i++) {
      const vel = new THREE.Vector3(rand(-1.2, 1.2), rand(0.6, 2), rand(-1.2, 1.2));
      this._spawnParticle({
        position,
        velocity: vel,
        size: rand(0.5, 1.1),
        color: 0xcfc3a8,
        life: rand(0.6, 1.1),
        gravity: -1.5,
        opacity: 0.35,
      });
    }
  }

  /** Splintering wood smoke puff — used when a crate shatters. */
  spawnSmoke(position, count = 8) {
    const { THREE } = this;
    for (let i = 0; i < count; i++) {
      const vel = new THREE.Vector3(rand(-1.5, 1.5), rand(1.5, 3.5), rand(-1.5, 1.5));
      this._spawnParticle({
        position,
        velocity: vel,
        size: rand(0.6, 1.3),
        color: 0x9c8f7a,
        life: rand(0.8, 1.4),
        gravity: -0.6,
        opacity: 0.5,
      });
    }
  }

  /**
   * Round 11 ("улучши графику в 1000 раз" — частицы и эффекты): a small,
   * short-lived puff behind a car's exhaust tip under load — up to now the
   * only visible sign a car was accelerating hard was the engine sound and
   * the skid dust under drift/braking; there was nothing at all coming out
   * of the actual exhaust pipes. Deliberately much smaller/quieter than
   * spawnSmoke() above (that one's tuned for "a crate just exploded") —
   * this needs to read as a continuous light drift behind a moving car, not
   * another one-shot burst, so it's called every couple of frames rather
   * than once per event (see main.js's throttle-driven call site).
   */
  spawnExhaust(position, backward) {
    const { THREE } = this;
    const vel = backward.clone()
      .multiplyScalar(rand(1.2, 2.2))
      .add(new THREE.Vector3(rand(-0.3, 0.3), rand(0.3, 0.8), rand(-0.3, 0.3)));
    this._spawnParticle({
      position, velocity: vel, size: rand(0.16, 0.3), color: 0xb9b9b9,
      life: rand(0.4, 0.7), gravity: -0.3, opacity: 0.3,
    });
  }

  /**
   * Round 11 ("улучши графику в 1000 раз" — частицы и эффекты): a quick,
   * flat-ish splash where a tire meets standing water — the rain preset
   * (weather.js) already has falling drops and a wet/reflective road
   * material, but nothing at all happened at actual ground contact, which
   * is the single most noticeable thing about driving through real rain.
   * Barely-there and very short-lived by design (a light grey-blue fleck,
   * gone in a third of a second) — this fires continuously while driving in
   * rain (see main.js), so anything bigger/longer would quickly turn into a
   * distracting haze around the car instead of a subtle "yes it's wet" cue.
   */
  spawnSplash(position) {
    const { THREE } = this;
    for (let i = 0; i < 2; i++) {
      const vel = new THREE.Vector3(rand(-0.8, 0.8), rand(1.2, 2.4), rand(-0.8, 0.8));
      this._spawnParticle({
        position, velocity: vel, size: rand(0.1, 0.2), color: 0xc9d8e0,
        life: rand(0.15, 0.3), gravity: -12, opacity: 0.5,
      });
    }
  }

  /**
   * Round 7 ("сделай в 10 раз летальнее машини" — real car destruction, not
   * just a dent): the one-shot burst when a car gets totalled (see
   * vehicle.js's _explode()). Deliberately bigger/louder-reading than every
   * other effect here — a fast bright flash, a wide shower of fire-colored
   * embers (reusing the same sprite/particle pool as spawnSparks, just hot
   * orange/red instead of stone-chip yellow and thrown further), and a
   * heavy black smoke column that lingers well past the other effects so
   * the wreck keeps visibly smoking for a beat after the flash is gone.
   */
  spawnExplosion(position) {
    const { THREE } = this;
    // Flash: one big, fast-fading bright sprite — the "boom" read happens
    // in the first couple of frames, everything else below is the follow-through.
    this._spawnParticle({
      position, velocity: new THREE.Vector3(0, 0.5, 0), size: 3.2, color: 0xfff2c0,
      life: 0.18, gravity: 0, opacity: 1,
    });
    for (let i = 0; i < 22; i++) {
      const vel = new THREE.Vector3(rand(-7, 7), rand(3, 9), rand(-7, 7));
      this._spawnParticle({
        position, velocity: vel, size: rand(0.14, 0.32), color: choice([0xff6a1a, 0xffb347, 0xff2e0e]),
        life: rand(0.4, 0.85), gravity: -10, opacity: 1,
      });
    }
    for (let i = 0; i < 14; i++) {
      const vel = new THREE.Vector3(rand(-2.5, 2.5), rand(2.5, 5.5), rand(-2.5, 2.5));
      this._spawnParticle({
        position, velocity: vel, size: rand(1.1, 2.1), color: 0x2a2620,
        life: rand(1.6, 2.6), gravity: -0.4, opacity: 0.65,
      });
    }
  }

  /** Drop a small dark skid-mark quad flat on the ground at a wheel contact point. */
  addSkidMark(position, headingRad) {
    const { THREE } = this;
    if (this.skidQuads.length >= MAX_SKID_QUADS) {
      const oldest = this.skidQuads.shift();
      this.skidGroup.remove(oldest.mesh);
      oldest.mesh.geometry.dispose();
      oldest.mesh.material.dispose();
    }
    const geo = new THREE.PlaneGeometry(0.22, 0.55);
    const mat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.35, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = headingRad;
    mesh.position.copy(position);
    mesh.position.y = 0.02;
    this.skidGroup.add(mesh);
    this.skidQuads.push({ mesh, life: 18 });
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.velocity.y += p.gravity * dt;
      p.sprite.position.addScaledVector(p.velocity, dt);
      const fade = p.life / p.maxLife;
      p.sprite.material.opacity = fade * p.baseOpacity;
      p.sprite.scale.setScalar(p.baseSize * (1 + (1 - fade) * 0.6));
    }

    for (let i = this.skidQuads.length - 1; i >= 0; i--) {
      const s = this.skidQuads[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.skidGroup.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        this.skidQuads.splice(i, 1);
        continue;
      }
      if (s.life < 3) s.mesh.material.opacity = 0.35 * (s.life / 3);
    }
  }
}
