// Round 7: "add traffic lights so NPCs don't crash into each other."
//
// A single GLOBAL signal phase shared by the whole city (every intersection
// changes together) rather than per-intersection independent timers — this
// is a small stylised city, not a real traffic-engineering sim, and the
// actual goal is "AI traffic stops at intersections instead of T-boning
// each other", which a shared phase achieves just as well as per-node
// timing while being far simpler to reason about and far cheaper to render.
//
// Visual footprint is kept small on purpose: every intersection gets two
// small glowing spheres (one per axis, NS and EW) instead of full signal-head
// models with poles/arms — and every NS sphere across the WHOLE CITY shares
// one merged geometry + one material (same for EW), so changing the phase
// is two material.color/.emissive assignments, not per-intersection state,
// and the entire city's traffic lights cost exactly 2 draw calls total.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PHASES = [
  { axis: 'ns', state: 'green', ms: 7000 },
  { axis: 'ns', state: 'yellow', ms: 1500 },
  { axis: 'both', state: 'red', ms: 800 }, // all-red clearance gap
  { axis: 'ew', state: 'green', ms: 7000 },
  { axis: 'ew', state: 'yellow', ms: 1500 },
  { axis: 'both', state: 'red', ms: 800 },
];

const COLORS = {
  green: { color: 0x1fae4a, emissive: 0x2fff6a, intensity: 2.4 },
  yellow: { color: 0xd8a520, emissive: 0xffcc33, intensity: 2.2 },
  red: { color: 0x9a1a1a, emissive: 0xff2222, intensity: 2.2 },
};

export class TrafficLightSystem {
  constructor(THREE, group, streetCoords, { offset = 3.4, height = 4.4 } = {}) {
    this._phaseIdx = 0;
    this._phaseElapsed = 0;
    // Start mid-cycle-ish (NS green, EW red) so the very first frame already
    // has a sensible, non-ambiguous state.
    this._ns = 'green';
    this._ew = 'red';

    this.nsMat = new THREE.MeshStandardMaterial({ color: COLORS.green.color, emissive: COLORS.green.emissive, emissiveIntensity: COLORS.green.intensity, roughness: 0.4 });
    this.ewMat = new THREE.MeshStandardMaterial({ color: COLORS.red.color, emissive: COLORS.red.emissive, emissiveIntensity: COLORS.red.intensity, roughness: 0.4 });

    const nsGeos = [];
    const ewGeos = [];
    for (const x of streetCoords) {
      for (const z of streetCoords) {
        const nsGeo = new THREE.SphereGeometry(0.3, 10, 10);
        nsGeo.translate(x + offset, height, z);
        nsGeos.push(nsGeo);
        const ewGeo = new THREE.SphereGeometry(0.3, 10, 10);
        ewGeo.translate(x, height, z + offset);
        ewGeos.push(ewGeo);
      }
    }
    const nsMesh = new THREE.Mesh(mergeGeometries(nsGeos), this.nsMat);
    const ewMesh = new THREE.Mesh(mergeGeometries(ewGeos), this.ewMat);
    group.add(nsMesh);
    group.add(ewMesh);
    nsGeos.forEach((g) => g.dispose());
    ewGeos.forEach((g) => g.dispose());
  }

  _applyState(axis, state) {
    const c = COLORS[state];
    const mat = axis === 'ns' ? this.nsMat : this.ewMat;
    mat.color.setHex(c.color);
    mat.emissive.setHex(c.emissive);
    mat.emissiveIntensity = c.intensity;
  }

  update(dt) {
    this._phaseElapsed += dt * 1000;
    const phase = PHASES[this._phaseIdx];
    if (this._phaseElapsed >= phase.ms) {
      this._phaseElapsed -= phase.ms;
      this._phaseIdx = (this._phaseIdx + 1) % PHASES.length;
      const next = PHASES[this._phaseIdx];
      if (next.axis === 'ns') { this._ns = next.state; this._ew = 'red'; }
      else if (next.axis === 'ew') { this._ew = next.state; this._ns = 'red'; }
      else { this._ns = 'red'; this._ew = 'red'; } // all-red clearance gap
      this._applyState('ns', this._ns);
      this._applyState('ew', this._ew);
    }
  }

  // Used by traffic.js's AI: only a solid GREEN counts as "go" — yellow and
  // red both mean "should be stopping/waiting", which keeps the collision-
  // avoidance logic in traffic.js simple (one boolean check) instead of
  // needing to model reaction time to a changing yellow light.
  isGreenForAxis(axis) {
    return (axis === 'ns' ? this._ns : this._ew) === 'green';
  }
}
