// Destructible street props: barrels, traffic cones, wooden crates and fence
// panels. Each is a dynamic physics body that gets knocked around / shattered
// by vehicle impacts. Every prop has a stable numeric id (based on spawn
// order) so multiplayer clients — who all build the identical deterministic
// world (see utils.resetSeed) — stay in sync:
//   - a live 'hit' (with a shatter flag when the impact broke the prop) is
//     broadcast the instant it happens, so everyone sees it immediately;
//   - once a knocked-around prop settles, its resting pose is reported once
//     (throttled, only if it actually moved) so a player who joins later
//     still finds it lying where the group left it, not back on its spawn
//     spot — see propRest handling in server/index.js.

import { rand, choice } from './utils.js';

const KINDS = ['barrel', 'cone', 'crate', 'fence'];
const REST_MOVE_THRESHOLD = 0.35; // meters from spawn before a "settled" report is worth sending

export class DestructibleField {
  constructor(THREE, CANNON, world, scene, { onEffect, onRest } = {}) {
    this.THREE = THREE;
    this.CANNON = CANNON;
    this.world = world;
    this.scene = scene;
    this.onEffect = onEffect || (() => {});
    this.onRest = onRest || (() => {});
    this.props = new Map(); // id -> record
    this.debris = [];       // free-flying shatter fragments { mesh, body, life }
    this.pendingHits = [];  // events to broadcast: { id, impulse:[x,y,z], point:[x,y,z], shatter:bool }
    this._nextId = 1;
  }

  spawnField(spots) {
    for (const spot of spots) {
      const count = Math.floor(rand(1, 3.999));
      for (let k = 0; k < count; k++) {
        const kind = choice(KINDS);
        const x = spot.x + rand(-3, 3);
        const z = spot.z + rand(-3, 3);
        this._spawnProp(kind, x, z);
      }
    }
  }

  _spawnProp(kind, x, z) {
    const { THREE, CANNON, world, scene } = this;
    const id = this._nextId++;
    let mesh, body;

    if (kind === 'barrel') {
      const r = 0.42, h = 0.9;
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, h, 16),
        new THREE.MeshStandardMaterial({ color: choice([0x1c6dd0, 0xd0421c, 0x2fae4a]), roughness: 0.5, metalness: 0.4 })
      );
      body = new CANNON.Body({ mass: 18, shape: new CANNON.Cylinder(r, r, h, 12) });
    } else if (kind === 'cone') {
      const rB = 0.24, rT = 0.03, h = 0.65;
      mesh = new THREE.Mesh(
        new THREE.ConeGeometry(rB, h, 14),
        new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 })
      );
      body = new CANNON.Body({ mass: 3, shape: new CANNON.Cylinder(rT, rB, h, 10) });
    } else if (kind === 'crate') {
      const s = 0.85;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: 0.9 })
      );
      body = new CANNON.Body({ mass: 26, shape: new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2)) });
    } else {
      // fence panel
      const w = 1.8, h = 1.0, t = 0.06;
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, t),
        new THREE.MeshStandardMaterial({ color: 0xcfcfcf, roughness: 0.8 })
      );
      body = new CANNON.Body({ mass: 9, shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, t / 2)) });
      body.quaternion.setFromEuler(0, rand(0, Math.PI * 2), 0);
    }

    const restH = kind === 'crate' ? 0.43 : kind === 'fence' ? 0.5 : kind === 'cone' ? 0.33 : 0.45;
    mesh.position.set(x, restH, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    body.position.set(x, restH, z);
    body.angularDamping = 0.4;
    body.linearDamping = 0.15;
    body.allowSleep = true;
    body.sleepSpeedLimit = 0.15;
    body.sleepTimeLimit = 0.6;
    world.addBody(body);

    const record = {
      id,
      kind,
      mesh,
      body,
      hp: kind === 'crate' ? 1 : Infinity,
      spawnPos: { x, y: restH, z },
      lastReportedRest: null,
    };
    this.props.set(id, record);

    body.addEventListener('collide', (e) => this._onCollide(record, e));
    body.addEventListener('sleep', () => this._onSleep(record));
    return record;
  }

  _onCollide(record, e) {
    const other = e.body;
    if (!other.userData || !other.userData.isVehicle) return;
    const impactSpeed = e.contact.getImpactVelocityAlongNormal ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 0;
    if (impactSpeed < 1.2) return;

    const point = [record.body.position.x, record.body.position.y, record.body.position.z];
    const willShatter = record.kind === 'crate' && impactSpeed > 5 && record.hp > 0;

    this.pendingHits.push({
      id: record.id,
      impulse: [record.body.velocity.x, record.body.velocity.y, record.body.velocity.z],
      point,
      shatter: willShatter,
    });

    this.onEffect(willShatter ? 'shatter' : 'impact', point, Math.min(1, impactSpeed / 12));

    if (willShatter) {
      record.hp = 0;
      this._shatter(record);
    }
  }

  _onSleep(record) {
    if (!this.props.has(record.id)) return; // already shattered/removed
    const p = record.body.position;
    const dx = p.x - record.spawnPos.x;
    const dz = p.z - record.spawnPos.z;
    if (dx * dx + dz * dz < REST_MOVE_THRESHOLD * REST_MOVE_THRESHOLD) return; // barely moved, not worth a message
    const q = record.body.quaternion;
    const pose = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
    record.lastReportedRest = pose;
    this.onRest(record.id, pose);
  }

  _shatter(record) {
    const { THREE, CANNON, world, scene } = this;
    scene.remove(record.mesh);
    world.removeBody(record.body);
    this.props.delete(record.id);

    const origin = record.body.position;
    const baseVel = record.body.velocity;
    const chunkMat = new THREE.MeshStandardMaterial({ color: 0x8a5a30, roughness: 0.9 });
    for (let i = 0; i < 6; i++) {
      const s = rand(0.22, 0.4);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), chunkMat);
      const body = new CANNON.Body({ mass: 2.2, shape: new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2)) });
      body.position.set(origin.x + rand(-0.3, 0.3), origin.y + rand(0, 0.4), origin.z + rand(-0.3, 0.3));
      body.velocity.set(baseVel.x * 0.5 + rand(-3, 3), rand(1, 4), baseVel.z * 0.5 + rand(-3, 3));
      body.angularVelocity.set(rand(-6, 6), rand(-6, 6), rand(-6, 6));
      mesh.castShadow = true;
      scene.add(mesh);
      world.addBody(body);
      this.debris.push({ mesh, body, life: 6 });
    }
  }

  /** Apply a networked hit (from another player's client) to keep wreckage roughly in sync. */
  applyRemoteHit(id, impulse) {
    const rec = this.props.get(id);
    if (!rec) return;
    rec.body.wakeUp();
    rec.body.velocity.x += impulse[0] * 0.4;
    rec.body.velocity.y += Math.max(0, impulse[1]) * 0.4;
    rec.body.velocity.z += impulse[2] * 0.4;
  }

  /** Replay a shatter that happened on another client (or before we joined). */
  applyRemoteShatter(id) {
    const rec = this.props.get(id);
    if (!rec || rec.hp <= 0) return;
    rec.hp = 0;
    this._shatter(rec);
  }

  /** Snap a prop straight to a known resting pose reported by another client / the join snapshot. */
  applyRemoteRest(id, p, q) {
    const rec = this.props.get(id);
    if (!rec) return;
    rec.body.wakeUp();
    rec.body.position.set(p[0], p[1], p[2]);
    rec.body.quaternion.set(q[0], q[1], q[2], q[3]);
    rec.body.velocity.set(0, 0, 0);
    rec.body.angularVelocity.set(0, 0, 0);
  }

  update(dt) {
    for (const rec of this.props.values()) {
      rec.mesh.position.copy(rec.body.position);
      rec.mesh.quaternion.copy(rec.body.quaternion);
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.mesh.position.copy(d.body.position);
      d.mesh.quaternion.copy(d.body.quaternion);
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        this.world.removeBody(d.body);
        this.debris.splice(i, 1);
      }
    }
  }

  /** Drain and return this frame's collision events for the network layer to broadcast. */
  drainHits() {
    const hits = this.pendingHits;
    this.pendingHits = [];
    return hits;
  }
}
