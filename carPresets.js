// A handful of car "models" with different proportions and driving feel.
// The core suspension/inertia tuning (CHASSIS_Y_OFFSET, anti-roll stiffness,
// wheel suspension numbers in vehicle.js) stays shared and untouched across
// all of them — that tuning was verified empirically in headless physics
// tests, and re-deriving it per body shape is a much bigger job than this
// pass has room for. What DOES change per preset — dimensions, mass, engine
// force, steering angle, braking — is exactly the stuff that's safe to vary
// without re-validating the flip/roll behavior from scratch, since it feeds
// into the same already-correct formulas (e.g. the parallel-axis inertia
// correction uses the body's actual mass at runtime, whatever that is).

export const CAR_PRESETS = {
  sedan: {
    id: 'sedan',
    name: 'Седан',
    desc: 'Сбалансированный — ничего не подчёркнуто, ничего не в минусе',
    dims: { chassisW: 1.9, chassisH: 0.65, chassisL: 4.2 },
    mass: 165,
    maxForce: 1000,
    maxSteer: 0.32,
    maxBrakeForce: 55,
  },
  sport: {
    id: 'sport',
    name: 'Спорткар',
    desc: 'Ниже и легче, разгон и руль острее, тормозит сильнее',
    dims: { chassisW: 1.85, chassisH: 0.52, chassisL: 4.05 },
    mass: 138,
    maxForce: 1320,
    maxSteer: 0.37,
    maxBrakeForce: 62,
  },
  suv: {
    id: 'suv',
    name: 'Внедорожник',
    desc: 'Выше и тяжелее — медленнее разгон, зато крепче держит удар',
    dims: { chassisW: 2.02, chassisH: 0.86, chassisL: 4.55 },
    mass: 215,
    maxForce: 960,
    maxSteer: 0.29,
    maxBrakeForce: 58,
  },
};

export const CAR_COLORS = [0xff3b30, 0x34c759, 0x0a84ff, 0xffcc00, 0xaf52de, 0xff9500, 0x5ac8fa, 0xff2d55];
