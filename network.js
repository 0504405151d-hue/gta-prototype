// WebSocket client: sends our own car's transform, name, and destruction
// events; receives the same from everyone else. Handles automatic
// reconnection with backoff (a dropped wifi connection shouldn't end the
// session) and measures round-trip latency via a small app-level ping.

const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 6000;
const PING_INTERVAL_MS = 3000;

export class Network {
  constructor({
    onWelcome, onJoin, onLeave, onState, onHit, onRest, onName, onCar, onConnectionChange, onPing, onChat,
    // Round 6: version sync (so a stale/cached client is visible instead of
    // guessed at), and real server-authoritative admin/moderation/economy
    // events. All optional — main.js wires up only what it needs.
    onVersion, onMoney, onAdminAuth, onModeration, onMuted,
  }) {
    this.onWelcome = onWelcome;
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.onState = onState;
    this.onHit = onHit;
    this.onRest = onRest;
    this.onName = onName;
    this.onCar = onCar;
    this.onConnectionChange = onConnectionChange;
    this.onPing = onPing;
    this.onChat = onChat;
    this.onVersion = onVersion;
    this.onMoney = onMoney;
    this.onAdminAuth = onAdminAuth;
    this.onModeration = onModeration;
    this.onMuted = onMuted;

    this.ws = null;
    this.id = null;
    this.connected = false;
    this._pendingName = '';
    // Round-5 (remote players should show the vehicle type their driver
    // actually picked, not always a generic body): mirrors _pendingName's
    // "resend on (re)connect" behavior exactly, since a dropped/reconnected
    // socket forgets everything the server knew about this player.
    this._pendingCarId = '';
    // Round-6: same resend-on-reconnect story for the build version string.
    this._pendingVersion = '';
    this._reconnectDelay = RECONNECT_MIN_MS;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._closedByUser = false;
    this.rttMs = null;
  }

  connect() {
    this._closedByUser = false;
    this._open();
  }

  disconnect() {
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    if (this.ws) this.ws.close();
  }

  setName(name) {
    this._pendingName = name || '';
    if (this.connected) this._send({ type: 'setName', name: this._pendingName });
  }

  setCar(carId) {
    this._pendingCarId = carId || '';
    if (this.connected) this._send({ type: 'setCar', carId: this._pendingCarId });
  }

  setVersion(version) {
    this._pendingVersion = version || '';
    if (this.connected) this._send({ type: 'setVersion', version: this._pendingVersion });
  }

  // --- Round 6: admin / moderation / economy -------------------------------
  adminLogin(password) { this._send({ type: 'adminLogin', password }); }
  adminLogout() { this._send({ type: 'adminLogout' }); }
  adminKick(targetId) { this._send({ type: 'adminKick', targetId }); }
  adminBan(targetId) { this._send({ type: 'adminBan', targetId }); }
  adminMute(targetId, muted) { this._send({ type: 'adminMute', targetId, muted }); }
  adminGiveMoney(targetId, amount) { this._send({ type: 'adminGiveMoney', targetId, amount }); }

  _open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this._reconnectDelay = RECONNECT_MIN_MS;
      if (this._pendingName) this._send({ type: 'setName', name: this._pendingName });
      if (this._pendingCarId) this._send({ type: 'setCar', carId: this._pendingCarId });
      if (this._pendingVersion) this._send({ type: 'setVersion', version: this._pendingVersion });
      this._pingTimer = setInterval(() => this._send({ type: 'ping', t: performance.now() }), PING_INTERVAL_MS);
      this.onConnectionChange && this.onConnectionChange(true);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.onConnectionChange && this.onConnectionChange(false);
      if (!this._closedByUser) this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' fires right after in browsers; reconnection is handled there.
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'welcome':
          this.id = msg.id;
          this.onWelcome && this.onWelcome(msg);
          break;
        case 'join':
          this.onJoin && this.onJoin(msg);
          break;
        case 'leave':
          this.onLeave && this.onLeave(msg);
          break;
        case 'state':
          this.onState && this.onState(msg);
          break;
        case 'hit':
          this.onHit && this.onHit(msg);
          break;
        case 'rest':
          this.onRest && this.onRest(msg);
          break;
        case 'name':
          this.onName && this.onName(msg);
          break;
        case 'car':
          this.onCar && this.onCar(msg);
          break;
        case 'pong':
          if (typeof msg.t === 'number') {
            this.rttMs = performance.now() - msg.t;
            this.onPing && this.onPing(this.rttMs);
          }
          break;
        case 'chat':
          this.onChat && this.onChat(msg);
          break;
        case 'version':
          this.onVersion && this.onVersion(msg);
          break;
        case 'money':
          this.onMoney && this.onMoney(msg);
          break;
        case 'adminAuth':
          this.onAdminAuth && this.onAdminAuth(msg);
          break;
        case 'moderation':
          // A kick/ban/mute event, either about me (kicked/banned close the
          // socket right after) or a notice about someone else for the
          // admin's own log.
          this.onModeration && this.onModeration(msg);
          break;
        case 'muted':
          this.onMuted && this.onMuted(msg);
          break;
      }
    });
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._open(), this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.7, RECONNECT_MAX_MS);
  }

  _send(data) {
    if (!this.connected || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(data));
  }

  sendState(state) {
    this._send({ type: 'state', state });
  }

  sendHit(payload) {
    this._send({ type: 'hit', payload });
  }

  sendRest(payload) {
    this._send({ type: 'rest', payload });
  }

  sendChat(text) {
    this._send({ type: 'chat', text });
  }
}
