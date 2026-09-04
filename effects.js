// Lightweight visual-only effects: impact dust/sparks/smoke particles and
// tire skid marks. None of this touches physics or the network layer — it's
// pure eye-candy driven by events other modules already produce (collisions,
// wheel skid state), pooled and capped so it stays cheap at prototype scale.

import { rand, buildSoftDotTexture } from './utils.js';

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
