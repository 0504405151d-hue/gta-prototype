// Small shared helpers used across client modules.

// Texture anisotropic-filtering level, shared by every buildXTexture() call
// below. Fixed at 8 before the graphics-quality "ultra" tier existed; now
// set once at boot (main.js) from the chosen quality + what the GPU actually
// supports, via setAnisotropy(). Changing it later doesn't retroactively
// refilter textures already built (same limitation as antialiasing, which
// also only applies at renderer creation) — good enough for a setting a
// player picks once before driving rather than mid-session.
let _anisotropy = 8;
export function setAnisotropy(v) {
  _anisotropy = v;
}

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
// Round-5 ("windows are too small"): cols/rows dropped from 6/14 to 5/10 —
// fewer, bigger cells per tile — and city.js was ALSO tiling this texture
// far too densely across a building face (repeating the whole 6x14 grid
// once every 6 units of wall), which compounded into windows barely large
// enough to read as windows at all rather than a fine noise pattern. See the
// repeat.set() call there for the other half of this fix.
export function buildFacadeTexture(THREE, { w = 256, h = 512, base = '#2b2f3a', lit = '#ffd98a', dim = '#12141c', cols = 5, rows = 10 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Subtle vertical panel-seam lines break up the flat base color before
  // windows go down, so facades read as built from panels rather than a
  // single painted slab.
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = Math.max(1, w / 180);
  for (let c = 1; c < cols; c++) {
    const x = (c / cols) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  const cellW = w / cols;
  const cellH = h / rows;
  const pad = Math.min(cellW, cellH) * 0.18;
  const frame = Math.max(1, pad * 0.35);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const litUp = Math.random() < 0.35;
      const wx = c * cellW + pad, wy = r * cellH + pad, ww = cellW - pad * 2, wh = cellH - pad * 2;
      // Dark window frame first, then the (lit or dim) glass slightly inset —
      // gives every window a visible edge instead of a flat color rectangle.
      ctx.fillStyle = '#0a0a0c';
      ctx.fillRect(wx - frame, wy - frame, ww + frame * 2, wh + frame * 2);
      ctx.fillStyle = litUp ? lit : dim;
      ctx.globalAlpha = litUp ? rand(0.6, 1) : 1;
      ctx.fillRect(wx, wy, ww, wh);
      ctx.globalAlpha = 1;
      // A soft highlight along the top edge of lit windows to fake an
      // interior ceiling-light glow instead of a uniform flat glass tone.
      if (litUp) {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(wx, wy, ww, wh * 0.25);
      }
    }
  }

  // Occasional horizontal string-course band (a floor-level trim strip) —
  // cheap way to break up tall facades so they don't look like one extrusion.
  const bandRows = [Math.floor(rows * 0.32), Math.floor(rows * 0.68)];
  for (const r of bandRows) {
    if (r <= 0 || r >= rows) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, r * cellH - Math.max(1, cellH * 0.06), w, Math.max(2, cellH * 0.1));
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = _anisotropy; // keeps facades from turning into a mushy blur at grazing/distant view angles
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
export function buildRoadTexture(THREE, { w = 256, h = 256 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2a2c31';
  ctx.fillRect(0, 0, w, h);
  // Asphalt aggregate speckle at two grain sizes, scattered with no
  // directional bias — coarse dark flecks plus fine light grit on top.
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.16})`;
    const s = w / 32;
    ctx.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    const s = w / 96;
    ctx.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
  // Random hairline cracks at random angles — individually directional but
  // scattered with no net bias, so the tiled result still reads as
  // direction-free asphalt rather than pointing one way down every street.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    let x = Math.random() * w, y = Math.random() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 2 + Math.floor(Math.random() * 3);
    for (let s = 0; s < segs; s++) {
      x += (Math.random() - 0.5) * (w / 6);
      y += (Math.random() - 0.5) * (h / 6);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // A few soft dark patch stains (old repairs / oil marks)
  for (let i = 0; i < 4; i++) {
    const px = Math.random() * w, py = Math.random() * h, pr = w * rand(0.05, 0.12);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, 'rgba(0,0,0,0.15)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = _anisotropy;
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

export function buildSidewalkTexture(THREE, { size = 256 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8b8d92';
  ctx.fillRect(0, 0, size, size);

  // Fine speckle so slabs aren't a flat gray fill
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  const cells = 4;
  for (let i = 0; i <= cells; i++) {
    const p = (i / cells) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  // A handful of weathering stains within each slab — water runoff / grime,
  // kept soft so it reads at a distance without looking like dirt smears.
  for (let i = 0; i < 6; i++) {
    const px = Math.random() * size, py = Math.random() * size, pr = size * rand(0.04, 0.09);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, 'rgba(60,55,45,0.12)');
    grad.addColorStop(1, 'rgba(60,55,45,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = _anisotropy;
  return tex;
}
