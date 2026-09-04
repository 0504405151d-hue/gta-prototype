/**
 * City Drive Multiplayer - server
 *
 * - Serves the static client (Three.js + cannon-es, loaded via CDN import map)
 *   straight out of this same directory — everything lives flat at the repo
 *   root (no server/public split) so the project can be uploaded to GitHub's
 *   web UI in one single drag-and-drop, no folder-structure gymnastics.
 * - Relays player transforms over WebSocket to all other connected clients.
 * - Keeps a lightweight AUTHORITATIVE record of shared-world destruction state
 *   (which crates have been shattered, and the last known resting pose of
 *   knocked-over props) so a player who joins mid-session sees the same
 *   wrecked city everyone else does, instead of a pristine one. Full physics
 *   is still simulated client-side (this stays a casual co-op prototype, not
 *   a cheat-proof authoritative-physics server) — this layer only fixes the
 *   "new player sees an untouched world" gap.
 * - Detects and drops dead connections with a ping/pong heartbeat so a
 *   crashed tab doesn't linger as a ghost player forever.
 *
 * Run: npm install && npm start
 * Then open http://localhost:3000 in one or more browser tabs/machines.
 */
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HEARTBEAT_MS = 25000;
const MAX_NAME_LEN = 16;

const app = express();
// Everything (index.html, main.js, city.js, ...) sits right next to this file.
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CAR_COLORS = [0xff3b30, 0x34c759, 0x0a84ff, 0xffcc00, 0xaf52de, 0xff9500, 0x5ac8fa, 0xff2d55];

/** @type {Map<string, {ws: import('ws').WebSocket, id: string, color: number, name: string, state: any, isAlive: boolean}>} */
const players = new Map();
let nextId = 1;

// ---------------------------------------------------------------------------
// Shared world destruction state (authoritative-ish: last write wins).
// ---------------------------------------------------------------------------
const shatteredIds = new Set();               // prop ids permanently destroyed
const propRest = new Map();                   // prop id -> { p:[x,y,z], q:[x,y,z,w] } last known resting pose

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) continue;
    if (ch === '<' || ch === '>' || ch === '&' || ch === '"' || ch === "'" || ch === '`') continue;
    out += ch;
    if (out.length >= MAX_NAME_LEN) break;
  }
  return out.trim();
}

function broadcast(data, exceptId) {
  const msg = JSON.stringify(data);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const color = CAR_COLORS[(id - 1) % CAR_COLORS.length];
  const player = { ws, id, color, name: '', state: null, isAlive: true };
  players.set(id, player);

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Bring the new player up to speed: who else is here, and the full history
  // of world destruction so far.
  send(ws, {
    type: 'welcome',
    id,
    color,
    players: Array.from(players.values())
      .filter((p) => p.id !== id && p.state)
      .map((p) => ({ id: p.id, color: p.color, name: p.name, state: p.state })),
    shatteredIds: Array.from(shatteredIds),
    propRest: Array.from(propRest.entries()).map(([pid, t]) => ({ id: pid, ...t })),
  });

  broadcast({ type: 'join', id, color }, id);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'setName': {
        player.name = sanitizeName(msg.name);
        broadcast({ type: 'name', id, name: player.name }, id);
        break;
      }
      case 'state': {
        if (!msg.state || !Array.isArray(msg.state.p) || !Array.isArray(msg.state.q)) return;
        player.state = msg.state;
        broadcast({ type: 'state', id, state: msg.state }, id);
        break;
      }
      case 'hit': {
        const payload = msg.payload;
        if (!payload || typeof payload.id !== 'number') return;
        if (payload.shatter) {
          shatteredIds.add(payload.id);
          propRest.delete(payload.id); // gone for good, no resting pose to track
        }
        broadcast({ type: 'hit', id, payload }, id);
        break;
      }
      case 'rest': {
        const payload = msg.payload;
        if (!payload || typeof payload.id !== 'number' || shatteredIds.has(payload.id)) return;
        propRest.set(payload.id, { p: payload.p, q: payload.q });
        broadcast({ type: 'rest', id, payload }, id);
        break;
      }
      case 'ping': {
        // app-level RTT probe, echoed straight back to the sender only
        if (typeof msg.t === 'number') send(ws, { type: 'pong', t: msg.t });
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id }, id);
  });

  ws.on('error', () => {
    players.delete(id);
  });
});

// Drop connections that stopped answering pings (crashed tab, network drop, …)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`City Drive Multiplayer running at http://localhost:${PORT}`);
});
