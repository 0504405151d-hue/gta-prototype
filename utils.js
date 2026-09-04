// Small shared helpers used across client modules.

// Deterministic seeded PRNG (mulberry32) so every connected client generates
// the EXACT same city layout and prop positions/ids without the server having
// to transmit world geometry. Call resetSeed() once before generating world
// content; everything below draws from this instead of Math.random().
let _state = 1337 >>> 0;
export function resetSeed(seed = 1337) {
  _state = seed >>> 0;
}
function _next() {
  _state |= 0;
  _state = (_state + 0x6d2b79f5) | 0;
  let t = Math.imul(_state ^ (_state >>> 15), 1 | _state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rand(min, max) {
  return min + _next() * (max - min);
}

export function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

export function choice(arr) {
  return arr[Math.floor(_next() * arr.length)];
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Procedural building facade texture (windows grid), drawn on a canvas.
// Avoids needing external image assets while still looking detailed.
export function buildFacadeTexture(THREE, { w = 128, h = 256, base = '#2b2f3a', lit = '#ffd98a', dim = '#12141c', cols = 6, rows = 14 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const cellW = w / cols;
  const cellH = h / rows;
  const pad = Math.min(cellW, cellH) * 0.18;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const litUp = Math.random() < 0.35;
      ctx.fillStyle = litUp ? lit : dim;
      ctx.globalAlpha = litUp ? rand(0.6, 1) : 1;
      ctx.fillRect(c * cellW + pad, r * cellH + pad, cellW - pad * 2, cellH - pad * 2);
      ctx.globalAlpha = 1;
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // keeps facades from turning into a mushy blur at grazing/distant view angles
  return tex;
}

// Plain asphalt texture — deliberately DIRECTION-FREE (isotropic speckle,
// nothing baked in that points one way). This single texture tiles across
// the whole ground plane under both the north-south and east-west streets
// of the grid, so it must look right no matter which way a given street
// runs. (An earlier version baked a dashed center line into this texture —
// that line was only ever correctly oriented for streets running one way;
// every cross-street showed it running across the road instead of along
// it. Lane markings are now separate, correctly-oriented 3D dash meshes —
// see addLaneMarkings() in city.js — laid down per street direction.)
export function buildRoadTexture(THREE, { w = 128, h = 128 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2a2c31';
  ctx.fillRect(0, 0, w, h);
  // subtle asphalt speckle, scattered with no directional bias
  for (let i = 0; i < 2000; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`;
    const s = w / 32;
    ctx.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Soft radial-gradient dot used as a shared sprite texture for every particle
// (dust, sparks, smoke) — one small canvas, reused everywhere via material
// tinting rather than loading any external image asset.
let _dotTexCache = null;
export function buildSoftDotTexture(THREE) {
  if (_dotTexCache) return _dotTexCache;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  _dotTexCache = tex;
  return tex;
}

export function buildSidewalkTexture(THREE, { size = 128 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8b8d92';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  const cells = 4;
  for (let i = 0; i <= cells; i++) {
    const p = (i / cells) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
