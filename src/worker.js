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
const ROUND_MS = 90_000, REVEAL_MS = 6_000, MAX_STROKES = 600;   // draw-mode round timing / resync cap
const WORDS = ['사과','바나나','수박','포도','딸기','피자','햄버거','라면','김밥','치킨','커피','아이스크림','케이크',
  '강아지','고양이','토끼','코끼리','기린','사자','호랑이','판다','펭귄','돌고래','상어','문어','나비','거미','공룡',
  '자동차','버스','기차','비행기','헬리콥터','자전거','오토바이','로켓','잠수함','배',
  '집','학교','병원','다리','탑','등대','텐트','눈사람','무지개','번개','태양','달','별','구름','산','바다','섬',
  '나무','꽃','선인장','버섯','축구','야구','농구','골프','볼링','수영','스키','낚시',
  '기타','피아노','드럼','바이올린','마이크','안경','모자','신발','양말','장갑','우산','시계','열쇠','가위','망치','사다리',
  '책','연필','컴퓨터','핸드폰','카메라','텔레비전','냉장고','세탁기','선풍기','의자','침대','거울','칫솔','치약','컵',
  '숟가락','젓가락','왕관','반지','풍선','선물','로봇','유령','천사','해적','마법사','경찰','소방관','의사','요리사'];
const norm = s => String(s).replace(/\s+/g, '').toLowerCase();

const emptyGame = (mode) => ({
  mode: mode || null,                // 'omok' | 'draw' — fixed at room creation (first join)
  board: new Array(CELLS).fill(0),   // ── omok: 0 empty, 1 black, 2 white
  turn: 1, winner: 0, winLine: null, moves: 0, round: 1, last: -1,
  seats: { 1: null, 2: null },       //    {token,name,online}
  d: null,                           // ── draw: {players,order,drawer,word,roundN,roundEnd,phase,guessed}
});
const emptyDraw = () => ({ players: {}, order: [], drawer: null, word: null,
  roundN: 0, roundEnd: 0, phase: 'lobby', guessed: {} });

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx; this.game = null;
    this.strokes = [];   // draw-mode stroke log, in-memory only (relayed live; resync is best-effort)
    // keepalive answered at the runtime layer — doesn't wake a hibernated DO
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async load() {
    if (!this.game) {
      let g = await this.ctx.storage.get('game');
      if (g && !('mode' in g)) { g.mode = 'omok'; g.d = null; }   // legacy shape
      this.game = g || emptyGame();
    }
    return this.game;
  }
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
  stateFor(g, role, token) {
    if (g.mode === 'draw') {
      const d = g.d;
      return { t: 'state', mode: 'draw', phase: d.phase, roundN: d.roundN, roundEnd: d.roundEnd,
               players: this.drawPlayersPub(d), youDrawer: token === d.drawer,
               mask: d.word ? this.mask(d.word) : '',
               word: (token === d.drawer || d.phase === 'reveal') ? d.word : null,
               strokes: this.strokes };
    }
    return { t: 'state', mode: 'omok', board: g.board.join(''), turn: g.turn, winner: g.winner, winLine: g.winLine,
             round: g.round, last: g.last, role, seats: this.seatsPub(g) };
  }
  /* ---- draw-mode helpers ---- */
  drawPlayersPub(d) {
    return d.order.map(t => ({ name: d.players[t].name, score: d.players[t].score,
                               online: !!d.players[t].online, drawer: t === d.drawer }));
  }
  mask(word) { return word.split('').map(ch => ch === ' ' ? ' ' : '○').join(''); }
  async startRound(g) {
    const d = g.d;
    const online = d.order.filter(t => d.players[t].online);
    if (online.length < 2) {
      d.phase = 'lobby'; d.drawer = null; d.word = null; await this.save();
      this.bcast({ t: 'phase', phase: 'lobby', players: this.drawPlayersPub(d) });
      return;
    }
    const idx = d.drawer ? d.order.indexOf(d.drawer) : -1;
    let next = null;
    for (let k = 1; k <= d.order.length && !next; k++) {
      const t = d.order[(idx + k) % d.order.length];
      if (d.players[t].online) next = t;
    }
    d.drawer = next; d.word = WORDS[(Math.random() * WORDS.length) | 0];
    d.roundN++; d.guessed = {}; d.phase = 'drawing'; d.roundEnd = Date.now() + ROUND_MS;
    this.strokes = [];
    await this.save(); await this.ctx.storage.setAlarm(d.roundEnd);
    for (const w of this.ctx.getWebSockets()) {                 // word goes ONLY to the drawer's sockets
      const a = w.deserializeAttachment() || {};
      try { w.send(JSON.stringify({ t: 'round', roundN: d.roundN, roundEnd: d.roundEnd,
        mask: this.mask(d.word), drawer: d.players[d.drawer].name,
        you: a.token === d.drawer, word: a.token === d.drawer ? d.word : null,
        players: this.drawPlayersPub(d) })); } catch {}
    }
  }
  async endRound(g, reason) {
    const d = g.d;
    if (d.phase !== 'drawing') return;
    d.phase = 'reveal'; d.roundEnd = Date.now() + REVEAL_MS;
    await this.save(); await this.ctx.storage.setAlarm(d.roundEnd);
    this.bcast({ t: 'reveal', word: d.word, reason, players: this.drawPlayersPub(d) });
  }
  async alarm() {
    const g = await this.load();
    if (g.mode !== 'draw' || !g.d) return;
    const d = g.d, now = Date.now();
    if (now < d.roundEnd - 250) { await this.ctx.storage.setAlarm(d.roundEnd); return; }  // stale alarm
    if (d.phase === 'drawing') await this.endRound(g, 'time');
    else if (d.phase === 'reveal') await this.startRound(g);
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
      if (!g.mode) { g.mode = m.mode === 'draw' ? 'draw' : 'omok'; if (g.mode === 'draw') g.d = emptyDraw(); dirty = true; }
      if (g.mode === 'draw') {                                  // draw: everyone is a player
        const d = g.d;
        const live = this.liveTokens(ws);
        for (const t of d.order) if (d.players[t].online && !live.has(t)) { d.players[t].online = false; dirty = true; }
        let wasHere = false;
        if (!d.players[token]) { d.players[token] = { name, score: 0, online: true }; d.order.push(token); dirty = true; }
        else { const p = d.players[token]; wasHere = p.online === true && live.has(token);
               if (!p.online || p.name !== name) { p.online = true; p.name = name; dirty = true; } }
        ws.serializeAttachment({ token, name, role: 0 });
        if (dirty) await this.save();
        ws.send(JSON.stringify(this.stateFor(g, 0, token)));
        this.bcast({ t: 'players', players: this.drawPlayersPub(d) }, ws);
        if (!wasHere) this.bcast({ t: 'sys', text: `${name} 입장` }, ws);
        return;
      }
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
      if (g.mode === 'draw' && g.d && g.d.phase === 'drawing' && g.d.word) {   // guess check
        const d = g.d;
        if (att.token === d.drawer) {
          if (norm(text).includes(norm(d.word))) return;      // drawer can't leak the word
        } else if (att.token && d.players[att.token] && !d.guessed[att.token] && norm(text) === norm(d.word)) {
          d.guessed[att.token] = true;
          const bonus = Math.max(0, Math.round(50 * (d.roundEnd - Date.now()) / ROUND_MS));
          d.players[att.token].score += 100 + bonus;
          if (d.players[d.drawer]) d.players[d.drawer].score += 30;
          await this.save();
          this.bcast({ t: 'correct', name: att.name, players: this.drawPlayersPub(d) });
          const guessers = d.order.filter(t => d.players[t].online && t !== d.drawer);
          if (guessers.length && guessers.every(t => d.guessed[t])) await this.endRound(g, 'all');
          return;
        }
      }
      this.bcast({ t: 'chat', name: att.name, text });
      return;
    }

    if (m.t === 'begin') {                        // draw: any member starts a round
      if (g.mode !== 'draw' || !g.d || !att.token || !g.d.players[att.token]) return;
      if (g.d.phase === 'drawing') return;
      await this.startRound(g);
      return;
    }
    if (m.t === 'stroke') {                       // draw: drawer streams line segments
      if (g.mode !== 'draw' || !g.d || g.d.phase !== 'drawing' || att.token !== g.d.drawer) return;
      const p = m.p;
      if (!Array.isArray(p) || p.length < 4 || p.length > 256 || p.length % 2) return;
      const s = { t: 'stroke', p: p.map(v => Math.max(0, Math.min(600, v | 0))),
                  c: (m.c | 0) % 8, w: Math.max(2, Math.min(24, m.w | 0)) };
      if (this.strokes.length < MAX_STROKES) this.strokes.push(s);
      this.bcast(s, ws);                          // no storage write per stroke
      return;
    }
    if (m.t === 'clear') {
      if (g.mode !== 'draw' || !g.d || g.d.phase !== 'drawing' || att.token !== g.d.drawer) return;
      this.strokes = [];
      this.bcast({ t: 'clear' }, ws);
      return;
    }

    if (m.t === 'move') {
      if (g.mode !== 'omok') return;
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

    if (m.t === 'restart') {                     // omok players only, after a finished game
      if (g.mode !== 'omok') return;
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
    if (g.mode === 'draw' && g.d) {
      const d = g.d;
      if (!still && d.players[att.token]) { d.players[att.token].online = false; await this.save(); }
      this.bcast({ t: 'players', players: this.drawPlayersPub(d) });
      if (att.name && !still) this.bcast({ t: 'sys', text: `${att.name} 퇴장` });
      if (!still && att.token === d.drawer && d.phase === 'drawing') await this.endRound(g, 'drawer-left');
      return;
    }
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
