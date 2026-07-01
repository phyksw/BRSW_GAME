// games — multiplayer rooms on Cloudflare Workers + Durable Objects.
// Routing: /ws/:CODE (WebSocket) -> GameRoom DO named CODE; everything else -> static assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4,8})$/);
    if (m) return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
    return env.ASSETS.fetch(request);
  }
};

const SIZE = 15, CELLS = SIZE * SIZE, MAX_CONN = 20;
const emptyGame = () => ({
  board: new Array(CELLS).fill(0),   // 0 empty, 1 black, 2 white
  turn: 1, winner: 0, winLine: null, moves: 0, round: 1, last: -1,
  seats: { 1: null, 2: null },       // {token,name,online}
});

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx; this.game = null;
    // keepalive answered at the runtime layer — doesn't wake a hibernated DO
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async load() { if (!this.game) this.game = (await this.ctx.storage.get('game')) || emptyGame(); return this.game; }
  save() { return this.ctx.storage.put('game', this.game); }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('WebSocket expected', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_CONN)
      return new Response('room full', { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);          // hibernation-friendly accept
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  bcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(s); } catch {} }
  }
  seatsPub(g) {
    const pub = s => s ? { name: s.name, online: !!s.online } : null;
    return { 1: pub(g.seats[1]), 2: pub(g.seats[2]) };
  }
  roster(g) {
    let watchers = 0;
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && !a.role) watchers++; }
    return { t: 'roster', seats: this.seatsPub(g), watchers };
  }
  stateFor(g, role) {
    return { t: 'state', board: g.board.join(''), turn: g.turn, winner: g.winner, winLine: g.winLine,
             round: g.round, last: g.last, role, seats: this.seatsPub(g) };
  }
  liveTokens(except) {                 // tokens with an actually-connected socket
    const live = new Set();
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = w.deserializeAttachment(); if (a && a.token) live.add(a.token);
    }
    return live;
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;              // JSON.parse('null') passes the try/catch
    // cheap per-socket flood guard (in-memory, best effort)
    this.rl ||= new WeakMap();
    const now = Date.now(); let rl = this.rl.get(ws);
    if (!rl || now - rl.t > 10000) { rl = { n: 0, t: now }; this.rl.set(ws, rl); }
    if (++rl.n > 40) return;

    const g = await this.load();
    const att = ws.deserializeAttachment() || {};

    if (m.t === 'join') {
      const name = String(m.name || '').slice(0, 12).trim() || '???';
      const token = String(m.token || '').slice(0, 40);
      if (!token) return;
      let dirty = false;
      // reconcile stale presence: deploys/evictions kill sockets WITHOUT firing webSocketClose
      const live = this.liveTokens(ws);
      for (const s of [1, 2]) if (g.seats[s] && g.seats[s].online && !live.has(g.seats[s].token)) {
        g.seats[s].online = false; dirty = true;
      }
      let role = 0;
      for (const s of [1, 2]) if (g.seats[s] && g.seats[s].token === token) role = s;   // reclaim my seat
      const midGame = g.moves > 0 && !g.winner;
      if (!role) for (const s of [1, 2]) if (!role && !g.seats[s]) {                    // empty seats first
        g.seats[s] = { token, name, online: true }; role = s; dirty = true;
      }
      if (!role && !midGame) for (const s of [1, 2]) if (!role && !g.seats[s].online) { // offline seats only when no live game
        g.seats[s] = { token, name, online: true }; role = s; dirty = true;
      }
      const wasHere = role ? (g.seats[role].online === true && g.seats[role].name === name) : live.has(token);
      if (role && (!g.seats[role].online || g.seats[role].name !== name)) {
        g.seats[role].online = true; g.seats[role].name = name; dirty = true;
      }
      ws.serializeAttachment({ token, name, role });
      if (dirty) await this.save();
      ws.send(JSON.stringify(this.stateFor(g, role)));
      if (dirty || !wasHere) this.bcast(this.roster(g));
      if (!wasHere) this.bcast({ t: 'sys', text: `${name} 입장 ${role ? (role === 1 ? '(흑)' : '(백)') : '(관전)'}` }, ws);
      return;
    }

    if (m.t === 'chat') {
      const text = String(m.text || '').slice(0, 200);
      if (!text.trim() || !att.name) return;
      this.bcast({ t: 'chat', name: att.name, text });
      return;
    }

    if (m.t === 'move') {
      const i = m.i | 0;
      if (g.winner || att.role !== g.turn) return;
      if (i < 0 || i >= CELLS || g.board[i] !== 0) return;
      if (!g.seats[1] || !g.seats[2]) return;    // wait for both players
      g.board[i] = att.role; g.moves++; g.last = i;
      const win = winLine(g.board, i);
      if (win) { g.winner = att.role; g.winLine = win; }
      else if (g.moves === CELLS) g.winner = 3;  // draw
      else g.turn = att.role === 1 ? 2 : 1;
      await this.save();
      this.bcast({ t: 'move', i, stone: att.role, turn: g.turn, winner: g.winner, winLine: g.winLine });
      return;
    }

    if (m.t === 'restart') {                     // players only, after a finished game
      if (att.role !== 1 && att.role !== 2) return;
      if (!g.winner) return;                     // also makes a racing duplicate restart a no-op
      const s1 = g.seats[1], s2 = g.seats[2];
      this.game = emptyGame();
      this.game.seats[1] = s2; this.game.seats[2] = s1;   // swap colors each round
      this.game.round = (g.round || 1) + 1;
      await this.save();
      for (const w of this.ctx.getWebSockets()) {         // roles may have swapped -> fresh state for everyone
        const a = w.deserializeAttachment() || {}; let role = 0;
        for (const s of [1, 2]) if (this.game.seats[s] && this.game.seats[s].token === a.token) role = s;
        w.serializeAttachment({ ...a, role });
        try { w.send(JSON.stringify(this.stateFor(this.game, role))); } catch {}
      }
      this.bcast({ t: 'sys', text: `${att.name}님이 새 판을 시작했어요 (흑백 교대)` });
      return;
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    const g = await this.load();
    const still = this.liveTokens(ws).has(att.token);   // same player may have another tab open
    if (!still && att.role && g.seats[att.role] && g.seats[att.role].token === att.token) {
      g.seats[att.role].online = false; await this.save();
    }
    this.bcast(this.roster(g));
    if (att.name && !still) this.bcast({ t: 'sys', text: `${att.name} 퇴장` });
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}

function winLine(b, i) {
  const x = i % SIZE, y = (i / SIZE) | 0, v = b[i];
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [i];
    for (const s of [1, -1]) {
      let nx = x + dx * s, ny = y + dy * s;
      while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && b[ny * SIZE + nx] === v) {
        line.push(ny * SIZE + nx); nx += dx * s; ny += dy * s;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}
