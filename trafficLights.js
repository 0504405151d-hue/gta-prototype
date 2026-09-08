// Round 7: "add traffic lights so NPCs don't crash into each other."
// Round 7 follow-up: "светофоры это просто шарики — они должны быть на
// стойке, а сам светофор это прямоугольник с 3 кругами, на Г-образной
// палке" — the bare glowing spheres read as UFOs, not traffic lights. Each
// fixture is now a real signal: a vertical pole, a horizontal arm bending
// off the top (the "Г" shape — vertical stroke + one horizontal stroke,
// same bent-arm idea already used for streetlights in city.js), and a dark
// rectangular signal head hanging off the arm's end with three lens
// circles stacked on its face (red/yellow/green, top to bottom).
//
// A single GLOBAL signal phase shared by the whole city (every intersection
// changes together) rather than per-intersection independent timers — this
// is a small stylised city, not a real traffic-engineering sim, and the
// actual goal is "AI traffic stops at intersections instead of T-boning
// each other", which a shared phase achieves just as well as per-node
// timing while being far simpler to reason about and far cheaper to render.
//
// Performance stays the same trick as the old bare-sphere version, just
// split further: every POLE+ARM+HEAD casing across the whole city (dark,
// never changes) is one merged mesh/material, and every LENS CIRCLE of a
// given color+axis across the whole city is its own merged mesh/material —
// so a phase change is still just a handful of material.emissive
// assignments, never per-fixture state, and the entire city's traffic
// lights cost 7 draw calls total (1 structure + 3 lens colors × 2 axes)
// regardless of how many intersections exist.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Round 9 ("иногда всё равно бывают аварии"): the all-red clearance gap
// between phases used to be 800ms. traffic.js only ever brakes a car for a
// red light BEFORE it commits to crossing (the stop-line window ends at
// car.t=0.93, just short of the intersection) — a car that entered right at
// the tail end of yellow is then "committed" and keeps going regardless of
// what the light does next, exactly like a real driver already in the box.
// The intersection itself is roughly 2×ROAD_HALF_WIDTH (~11 units) wide,
// plus however much of the car's own length still has to clear it — for a
// car moving at a typical AI cruise/turn speed that's comfortably more than
// one second of driving, not 0.8s. So a car that just barely made it in
// under yellow could still physically be inside the box the instant the
// OTHER axis went green and a fresh car started across — a real, if rare,
// T-bone that no amount of stop-line braking logic can catch, because by
// then the light isn't what's stopping it. 800ms → 3200ms gives every
// entered car enough time to actually clear the box before the cross
// traffic is let in, at the cost of a slightly longer pause between phases
// (still short next to the 7s green itself).
const PHASES = [
  { axis: 'ns', state: 'green', ms: 7000 },
  { axis: 'ns', state: 'yellow', ms: 1500 },
  { axis: 'both', state: 'red', ms: 3200 }, // all-red clearance gap
  { axis: 'ew', state: 'green', ms: 7000 },
  { axis: 'ew', state: 'yellow', ms: 1500 },
  { axis: 'both', state: 'red', ms: 3200 },
];

// `on`/`off` are both used as color AND emissive — an "off" lens isn't
// fully black (real signal lenses are a dark tinted glass even unlit), just
// much dimmer than the lit one.
const LENS_COLORS = {
  red: { on: 0xff2a2a, off: 0x3a1010 },
  yellow: { on: 0xffcc33, off: 0x3a2e10 },
  green: { on: 0x35ff6e, off: 0x0f2e18 },
};
const LENS_ORDER = ['red', 'yellow', 'green']; // top to bottom, like a real signal head

export class TrafficLightSystem {
  constructor(THREE, CANNON, world, group, streetCoords, { offset = 6.4, poleHeight = 3.3, armLen = 0.8 } = {}) {
    this._phaseIdx = 0;
    this._phaseElapsed = 0;
    // Start mid-cycle-ish (NS green, EW red) so the very first frame already
    // has a sensible, non-ambiguous state.
    this._ns = 'green';
    this._ew = 'red';

    // One shared material per (axis, lens color) — 6 total. Each backs a
    // single merged mesh of every lens circle of that color+axis across the
    // whole city, so lighting one up/dimming it down is one material edit,
    // not a walk over every intersection.
    this.lensMats = { ns: {}, ew: {} };
    for (const axis of ['ns', 'ew']) {
      for (const name of LENS_ORDER) {
        this.lensMats[axis][name] = new THREE.MeshStandardMaterial({
          color: LENS_COLORS[name].off, emissive: LENS_COLORS[name].off, emissiveIntensity: 0.2, roughness: 0.35,
        });
      }
    }

    const structureGeos = []; // pole + arm + signal-head casing, one shared dark material
    const lensGeos = { ns: { red: [], yellow: [], green: [] }, ew: { red: [], yellow: [], green: [] } };

    const headW = 0.34, headH = 0.9, headD = 0.22, lensR = 0.11, lensGap = 0.32;

    // Builds one full fixture (pole/arm/head/lenses) at (px, pz), with the
    // arm swinging off in direction `angle` (radians, standard atan2 sense)
    // — the signal head ends up out at the end of the arm, and its lens
    // face points back the way the arm came from, toward whoever is
    // approaching the pole along that axis.
    const buildFixture = (axis, px, pz, angle) => {
      const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, poleHeight, 8);
      poleGeo.translate(px, poleHeight / 2, pz);
      structureGeos.push(poleGeo);

      // Follow-up fix ("и еще нету колидеров у светофоров"): city.js already
      // gives its streetlights a real static collider so cars don't drive
      // straight through the post — the traffic-light pole never got the
      // same treatment. Same recipe (thin static CANNON.Cylinder centered on
      // the pole), tagged isBuilding so ramming one is dangerous too, same
      // as any other solid street furniture.
      const poleBody = new CANNON.Body({ mass: 0, shape: new CANNON.Cylinder(0.09, 0.09, poleHeight, 8) });
      poleBody.position.set(px, poleHeight / 2, pz);
      poleBody.userData = { isBuilding: true };
      world.addBody(poleBody);

      const dirX = Math.cos(angle), dirZ = Math.sin(angle);
      const bendY = poleHeight;

      // The "Г" bend: a horizontal arm from the top of the pole out toward
      // the road it controls — built along local +X then rotated to `angle`
      // and dropped at the bend point, the same construction city.js's
      // addStreetlight() already uses for its own arm.
      const armGeo = new THREE.CylinderGeometry(0.045, 0.045, armLen, 8);
      armGeo.rotateZ(Math.PI / 2);
      armGeo.translate(armLen / 2, 0, 0);
      armGeo.rotateY(-angle);
      armGeo.translate(px, bendY, pz);
      structureGeos.push(armGeo);

      const headX = px + dirX * armLen, headZ = pz + dirZ * armLen;
      const headY = bendY - headH / 2 - 0.1;
      const headGeo = new THREE.BoxGeometry(headW, headH, headD);
      headGeo.rotateY(-angle);
      headGeo.translate(headX, headY, headZ);
      structureGeos.push(headGeo);

      // Lens circles on the face of the head pointing back along the arm's
      // direction (away from the pole) — a thin thick disc, standing
      // slightly proud of the casing so it doesn't z-fight with it.
      const faceOffset = headD / 2 + 0.015;
      const faceX = headX + dirX * faceOffset, faceZ = headZ + dirZ * faceOffset;
      LENS_ORDER.forEach((name, i) => {
        const ly = headY + headH / 2 - 0.22 - i * lensGap;
        const lensGeo = new THREE.CylinderGeometry(lensR, lensR, 0.03, 14);
        lensGeo.rotateX(Math.PI / 2); // circular faces now point along local Z
        lensGeo.rotateY(-angle);
        lensGeo.translate(faceX, ly, faceZ);
        lensGeos[axis][name].push(lensGeo);
      });
    };

    // Follow-up fix ("ну на обочине а не посепедине перекрестка" pt.2 — the
    // first curb-offset pass only pushed the pole out along ONE axis, e.g.
    // the ns-fixture moved to x+offset but kept z exactly on the EW road's
    // own centerline, so it ended up standing dead center in the middle of
    // the OTHER street instead of on a sidewalk corner. It also explains the
    // "NPCs run red and stop on green" report: from a car's point of view,
    // the pole planted in ITS path was actually showing the OTHER axis'
    // state, making it look like the wrong light. Fix: offset BOTH x and z
    // (like city.js's own streetlight corners already do), so each fixture
    // clears BOTH roads and sits on an actual block corner — and put ns/ew
    // on two different corners of the same intersection so they don't share
    // a spot.
    for (const x of streetCoords) {
      for (const z of streetCoords) {
        // NS fixture: NE-ish corner, arm swings back toward -X to hang the
        // head out over the NS road (the one running along z at this x).
        buildFixture('ns', x + offset, z + offset, Math.PI);
        // EW fixture: NW-ish corner, arm swings back toward -Z to hang the
        // head out over the EW road (the one running along x at this z).
        buildFixture('ew', x - offset, z + offset, -Math.PI / 2);
      }
    }

    const structureMat = new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.55, metalness: 0.5 });
    group.add(new THREE.Mesh(mergeGeometries(structureGeos), structureMat));
    structureGeos.forEach((g) => g.dispose());

    for (const axis of ['ns', 'ew']) {
      for (const name of LENS_ORDER) {
        const geos = lensGeos[axis][name];
        group.add(new THREE.Mesh(mergeGeometries(geos), this.lensMats[axis][name]));
        geos.forEach((g) => g.dispose());
      }
    }

    this._applyState('ns', this._ns);
    this._applyState('ew', this._ew);
  }

  // Lights up the ONE lens matching `state` for this axis and dims the
  // other two back to their unlit color — mirrors a real signal head, where
  // exactly one of the three lenses is ever lit at once.
  _applyState(axis, state) {
    for (const name of LENS_ORDER) {
      const mat = this.lensMats[axis][name];
      const c = LENS_COLORS[name];
      const lit = name === state;
      mat.color.setHex(lit ? c.on : c.off);
      mat.emissive.setHex(lit ? c.on : c.off);
      mat.emissiveIntensity = lit ? 2.6 : 0.2;
    }
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
