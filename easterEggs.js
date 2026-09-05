// A few small, deliberately low-stakes easter eggs. Nothing here affects
// gameplay balance or physics tuning — just fun surprises a player can find
// (a hidden UFO) or trigger themselves (typing a magic word in chat).

const UFO_RING_COUNT = 8;

/**
 * A simple flying-saucer mesh: a flattened sphere for the hull, a
 * translucent dome on top, a ring of glowing lights around the rim, and one
 * real point light so it actually lights up whatever's underneath it at
 * night. Shared by both the hidden rooftop easter egg and the chat-summoned
 * flyover.
 */
export function buildUfoMesh(THREE) {
  const group = new THREE.Group();

  const hullMat = new THREE.MeshStandardMaterial({ color: 0x9aa7bd, metalness: 0.85, roughness: 0.25, emissive: 0x1a2a3a, emissiveIntensity: 0.4 });
  const hull = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 12), hullMat);
  hull.scale.set(1, 0.28, 1);
  hull.castShadow = true;
  group.add(hull);

  const domeMat = new THREE.MeshPhysicalMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.5, roughness: 0.08, clearcoat: 1 });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
  dome.position.y = 0.45;
  group.add(dome);

  const ringMat = new THREE.MeshStandardMaterial({ color: 0x6dffcf, emissive: 0x6dffcf, emissiveIntensity: 2.6 });
  for (let i = 0; i < UFO_RING_COUNT; i++) {
    const a = (i / UFO_RING_COUNT) * Math.PI * 2;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), ringMat);
    bulb.position.set(Math.cos(a) * 2.6, -0.35, Math.sin(a) * 2.6);
    group.add(bulb);
  }

  const glow = new THREE.PointLight(0x6dffcf, 3.5, 26);
  glow.position.y = -0.4;
  group.add(glow);

  return group;
}

/**
 * A permanent, deterministic easter egg: a UFO quietly parked on the
 * rooftop of whichever building sits closest to the exact center of the
 * city. Every client generates the same city from the same seed (see
 * utils.js resetSeed/city.js), so every player who goes looking finds it in
 * the same spot — this isn't randomized per-session.
 */
export function spawnRoofUfo(THREE, scene, city) {
  if (!city.footprints || !city.footprints.length) return null;
  let best = city.footprints[0], bestDist = Infinity;
  for (const f of city.footprints) {
    const d = Math.hypot(f.x, f.z);
    if (d < bestDist) { bestDist = d; best = f; }
  }
  const group = buildUfoMesh(THREE);
  group.scale.setScalar(0.85);
  const baseY = (best.h ?? 12) + 2.6;
  group.position.set(best.x, baseY, best.z);
  scene.add(group);

  let t = 0;
  return {
    group,
    update(dt) {
      t += dt;
      group.position.y = baseY + Math.sin(t * 0.6) * 0.4;
      group.rotation.y += dt * 0.35;
    },
  };
}

/**
 * A temporary UFO that circles high over the given position for a while
 * and then leaves — summoned by typing "ufo"/"нло" in chat (see main.js).
 * Returns an object with update(dt) to call each frame and a `done` flag
 * the caller can poll to know when it's safe to stop calling update().
 */
export function spawnFlyoverUfo(THREE, scene, aroundPos, { radius = 90, height = 46, lifeSeconds = 16 } = {}) {
  const group = buildUfoMesh(THREE);
  scene.add(group);
  const startAngle = Math.random() * Math.PI * 2;
  const angularSpeed = 0.3; // rad/s
  const state = { done: false };
  let t = 0;

  state.update = (dt) => {
    t += dt;
    const a = startAngle + t * angularSpeed;
    group.position.set(
      aroundPos.x + Math.cos(a) * radius,
      height + Math.sin(t * 0.8) * 3,
      aroundPos.z + Math.sin(a) * radius
    );
    group.rotation.y += dt * 1.1;
    if (t > lifeSeconds) {
      scene.remove(group);
      state.done = true;
    }
  };
  return state;
}
