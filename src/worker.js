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
  mode: mode || null,                // 'omok' | 'draw' | 'alka' — fixed at room creation (first join)
  board: new Array(CELLS).fill(0),   // ── omok: 0 empty, 1 black, 2 white
  turn: 1, winner: 0, winLine: null, moves: 0, round: 1, last: -1,
  seats: { 1: null, 2: null },       //    {token,name,online} (shared by omok + alka)
  d: null,                           // ── draw: {players,order,drawer,word,roundN,roundEnd,phase,guessed}
  a: null,                           // ── alka: {stones,turn,winner,round,phase,moves}
  b: null,                           // ── beat: {players,order,phase,seed,startAt,roundN}
  tt: null,                          // ── tet:  {players,order,phase,seed,startAt,roundN}
});
const emptyDraw = () => ({ players: {}, order: [], drawer: null, word: null,
  roundN: 0, roundEnd: 0, phase: 'lobby', guessed: {} });
// alka: 5 black stones (role 1, bottom) vs 5 white (role 2, top) on a 600x600 board
const emptyAlka = () => ({ stones: (() => { const st = [];
    for (let k = 0; k < 5; k++) st.push({ x: 150 + k * 75, y: 140, o: 2, a: 1 });
    for (let k = 0; k < 5; k++) st.push({ x: 150 + k * 75, y: 460, o: 1, a: 1 });
    return st; })(),
  turn: 1, winner: 0, round: 1, phase: 'idle', moves: 0, wobble: 0 });   // wobble: aim-noise level 0-3
// beat (리듬): same seeded chart everywhere, judged LOCALLY; server only syncs start time + scores
const BEAT_D = 45_000;
const emptyBeat = () => ({ players: {}, order: [], phase: 'lobby', seed: 0, startAt: 0, roundN: 0 });
// tet (테트리스): same seeded 7-bag everywhere, played locally; server relays scores + garbage attacks
const TET_MAX = 600_000;   // hard cap per round (alarm forces results)
const emptyTet = () => ({ players: {}, order: [], phase: 'lobby', seed: 0, startAt: 0, roundN: 0 });

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
    const pub = (s, side) => s ? { name: s.name, online: !!s.online,
      mate: g.tm && g.tm.mates[side] ? { name: g.tm.mates[side].name, online: !!g.tm.mates[side].online } : null,
      up: this.upOf(g, side) } : null;
    return { 1: pub(g.seats[1], 1), 2: pub(g.seats[2], 2) };
  }
  isSolo(g) { return !!(g.seats[1] && g.seats[2] && g.seats[1].token === g.seats[2].token); }
  sideMembers(g, side) { const mem = []; if (g.seats[side]) mem.push(g.seats[side]);
    if (g.tm && g.tm.mates[side]) mem.push(g.tm.mates[side]); return mem; }
  upOf(g, side) { const n = this.sideMembers(g, side).length;
    return (g.tm && n > 1) ? g.tm.idx[side] % n : 0; }
  roster(g) {
    let watchers = 0;
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && !a.role) watchers++; }
    return { t: 'roster', seats: this.seatsPub(g), watchers, solo: this.isSolo(g) };
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
    if (g.mode === 'alka') {
      const a = g.a;
      return { t: 'state', mode: 'alka', role, seats: this.seatsPub(g), solo: this.isSolo(g),
               turn: a.turn, winner: a.winner, round: a.round, phase: a.phase, stones: a.stones,
               wobble: a.wobble | 0 };
    }
    if (g.mode === 'beat') {
      const b = g.b;
      return { t: 'state', mode: 'beat', phase: b.phase, seed: b.seed, startAt: b.startAt,
               now: Date.now(), roundN: b.roundN, players: this.beatPub(b) };
    }
    if (g.mode === 'tet') {
      const tt = g.tt;
      return { t: 'state', mode: 'tet', phase: tt.phase, seed: tt.seed, startAt: tt.startAt,
               now: Date.now(), roundN: tt.roundN, players: this.tetPub(tt) };
    }
    return { t: 'state', mode: 'omok', board: g.board.join(''), turn: g.turn, winner: g.winner, winLine: g.winLine,
             round: g.round, last: g.last, role, seats: this.seatsPub(g), solo: this.isSolo(g),
             youIdx: (g.tm && role && g.tm.mates[role] && g.tm.mates[role].token === token) ? 1 : 0 };
  }
  /* ---- draw-mode helpers ---- */
  drawPlayersPub(d) {
    return d.order.map(t => ({ name: d.players[t].name, score: d.players[t].score,
                               online: !!d.players[t].online, drawer: t === d.drawer }));
  }
  mask(word) { return word.split('').map(ch => ch === ' ' ? ' ' : '○').join(''); }
  /* ---- beat-mode helpers ---- */
  beatPub(b) {
    return b.order.map(t => { const p = b.players[t];
      return { name: p.name, online: !!p.online, playing: !!p.playing, finished: !!p.finished,
               score: p.score | 0, maxCombo: p.maxCombo | 0, acc: p.acc || 0 }; });
  }
  async beatResults(g) {
    const b = g.b;
    if (b.phase !== 'playing') return;
    b.phase = 'lobby';
    await this.save();
    const list = b.order.filter(t => b.players[t].playing)
      .map(t => { const p = b.players[t];
        return { name: p.name, score: p.score | 0, maxCombo: p.maxCombo | 0, acc: p.acc || 0, finished: !!p.finished }; })
      .sort((x, y) => y.score - x.score);
    this.bcast({ t: 'bres', roundN: b.roundN, list });
  }
  /* ---- tet-mode helpers ---- */
  tetPub(tt) {
    return tt.order.map(t => { const p = tt.players[t];
      return { name: p.name, online: !!p.online, playing: !!p.playing, finished: !!p.finished,
               score: p.score | 0, lines: p.lines | 0 }; });
  }
  async tetResults(g) {
    const tt = g.tt;
    if (tt.phase !== 'playing') return;
    tt.phase = 'lobby';
    await this.save();
    const list = tt.order.filter(t => tt.players[t].playing)
      .map(t => { const p = tt.players[t];
        return { name: p.name, score: p.score | 0, lines: p.lines | 0 }; })
      .sort((x, y) => y.score - x.score);
    this.bcast({ t: 'tres', roundN: tt.roundN, list });
  }
  async startRound(g) {
    const d = g.d;
    const online = d.order.filter(t => d.players[t].online);
    if (online.length < 1) {                     // 1 player = solo practice sketching
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
    const now = Date.now();
    if (g.mode === 'alka' && g.a) {              // settle watchdog
      if (g.a.phase === 'sim') {
        if (now >= (g.a.simSince || 0) + 9_500) { g.a.phase = 'idle'; await this.save(); this.bcast({ t: 'abort' }); }
        else await this.ctx.storage.setAlarm((g.a.simSince || now) + 10_000);
      }
      return;
    }
    if (g.mode === 'beat' && g.b) {              // force results if a player never sent finish
      if (g.b.phase === 'playing') {
        if (now >= g.b.startAt + BEAT_D + 7_000) await this.beatResults(g);
        else await this.ctx.storage.setAlarm(g.b.startAt + BEAT_D + 8_000);
      }
      return;
    }
    if (g.mode === 'tet' && g.tt) {              // round hard cap
      if (g.tt.phase === 'playing') {
        if (now >= g.tt.startAt + TET_MAX - 1_000) await this.tetResults(g);
        else await this.ctx.storage.setAlarm(g.tt.startAt + TET_MAX);
      }
      return;
    }
    if (g.mode !== 'draw' || !g.d) return;
    const d = g.d;
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
      if (!g.mode) { g.mode = ['draw', 'alka', 'beat', 'tet'].includes(m.mode) ? m.mode : 'omok';
        if (g.mode === 'draw') g.d = emptyDraw();
        else if (g.mode === 'alka') g.a = emptyAlka();
        else if (g.mode === 'beat') g.b = emptyBeat();
        else if (g.mode === 'tet') g.tt = emptyTet(); dirty = true; }
      if (g.mode === 'draw' || g.mode === 'beat' || g.mode === 'tet') {   // pool games: everyone plays
        const pool = g.mode === 'draw' ? g.d : g.mode === 'beat' ? g.b : g.tt;
        const live = this.liveTokens(ws);
        for (const t of pool.order) if (pool.players[t].online && !live.has(t)) { pool.players[t].online = false; dirty = true; }
        let wasHere = false;
        if (!pool.players[token]) {
          pool.players[token] = g.mode === 'draw'
            ? { name, score: 0, online: true }
            : g.mode === 'beat'
            ? { name, online: true, playing: false, finished: false, score: 0, maxCombo: 0, acc: 0 }
            : { name, online: true, playing: false, finished: false, score: 0, lines: 0 };
          pool.order.push(token); dirty = true;
        } else { const p = pool.players[token]; wasHere = p.online === true && live.has(token);
                 if (!p.online || p.name !== name) { p.online = true; p.name = name; dirty = true; } }
        ws.serializeAttachment({ token, name, role: 0 });
        if (dirty) await this.save();
        ws.send(JSON.stringify(this.stateFor(g, 0, token)));
        this.bcast({ t: 'players', players: g.mode === 'draw' ? this.drawPlayersPub(pool)
                     : g.mode === 'beat' ? this.beatPub(pool) : this.tetPub(pool) }, ws);
        if (!wasHere) this.bcast({ t: 'sys', text: `${name} 입장` }, ws);
        return;
      }
      // reconcile stale presence: deploys/evictions kill sockets WITHOUT firing webSocketClose
      const live = this.liveTokens(ws);
      for (const s of [1, 2]) if (g.seats[s] && g.seats[s].online && !live.has(g.seats[s].token)) {
        g.seats[s].online = false; dirty = true;
      }
      if (g.tm) for (const s of [1, 2]) { const mt = g.tm.mates[s];
        if (mt && mt.online && !live.has(mt.token)) { mt.online = false; dirty = true; } }
      let role = 0, isMate = false;
      for (const s of [1, 2]) if (g.seats[s] && g.seats[s].token === token) role = s;   // reclaim my seat
      if (!role && g.tm) for (const s of [1, 2]) if (!role && g.tm.mates[s] && g.tm.mates[s].token === token) {
        role = s; isMate = true;                                                        // reclaim my TEAM slot
        if (!g.tm.mates[s].online || g.tm.mates[s].name !== name) { g.tm.mates[s].online = true; g.tm.mates[s].name = name; dirty = true; }
      }
      const midGame = g.mode === 'alka' ? (g.a.moves > 0 && !g.a.winner) : (g.moves > 0 && !g.winner);
      if (!role) for (const s of [1, 2]) if (!role && !g.seats[s]) {                    // empty seats first
        g.seats[s] = { token, name, online: true }; role = s; dirty = true;
      }
      if (!role && !midGame) for (const s of [1, 2]) if (!role && !g.seats[s].online) { // offline seats only when no live game
        g.seats[s] = { token, name, online: true }; role = s; dirty = true;
      }
      const wasHere = (role && !isMate) ? (g.seats[role].online === true && g.seats[role].name === name) : live.has(token);
      if (role && !isMate && (!g.seats[role].online || g.seats[role].name !== name)) {
        g.seats[role].online = true; g.seats[role].name = name; dirty = true;
      }
      ws.serializeAttachment({ token, name, role, mate: isMate });
      if (dirty) await this.save();
      ws.send(JSON.stringify(this.stateFor(g, role, token)));
      if (dirty || !wasHere) this.bcast(this.roster(g));
      if (!wasHere) this.bcast({ t: 'sys', text: `${name} 입장 ${role ? (isMate ? (role === 1 ? '(흑팀)' : '(백팀)') : (role === 1 ? '(흑)' : '(백)')) : '(관전)'}` }, ws);
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

    if (m.t === 'begin') {                        // draw/beat: any member starts a round
      if (!att.token) return;
      if (g.mode === 'draw' && g.d && g.d.players[att.token]) {
        if (g.d.phase === 'drawing') return;
        await this.startRound(g);
        return;
      }
      if (g.mode === 'beat' && g.b && g.b.players[att.token]) {
        const b = g.b;
        if (b.phase === 'playing') return;
        b.roundN++; b.seed = (Math.random() * 0x7fffffff) | 0; b.startAt = Date.now() + 3500; b.phase = 'playing';
        for (const t of b.order) { const p = b.players[t];
          p.playing = !!p.online; p.finished = false; p.score = 0; p.maxCombo = 0; p.acc = 0; }
        await this.save();
        await this.ctx.storage.setAlarm(b.startAt + BEAT_D + 8_000);   // force results if someone never finishes
        this.bcast({ t: 'bstart', seed: b.seed, startAt: b.startAt, now: Date.now(),
                     roundN: b.roundN, players: this.beatPub(b) });
        return;
      }
      if (g.mode === 'tet' && g.tt && g.tt.players[att.token]) {
        const tt = g.tt;
        if (tt.phase === 'playing') return;
        tt.roundN++; tt.seed = (Math.random() * 0x7fffffff) | 0; tt.startAt = Date.now() + 3500; tt.phase = 'playing';
        for (const t of tt.order) { const p = tt.players[t];
          p.playing = !!p.online; p.finished = false; p.score = 0; p.lines = 0; }
        await this.save();
        await this.ctx.storage.setAlarm(tt.startAt + TET_MAX);
        this.bcast({ t: 'tstart', seed: tt.seed, startAt: tt.startAt, now: Date.now(),
                     roundN: tt.roundN, players: this.tetPub(tt) });
        return;
      }
      return;
    }
    if (m.t === 'tscore') {                       // tet: live score/lines relay
      if (g.mode !== 'tet' || !g.tt || g.tt.phase !== 'playing') return;
      const p = g.tt.players[att.token];
      if (!p || !p.playing || p.finished) return;
      p.score = Math.max(0, Math.min(9_999_999, m.s | 0));
      p.lines = Math.max(0, Math.min(9999, m.l | 0));
      this.bcast({ t: 'tscore', name: att.name, s: p.score, l: p.lines }, ws);
      return;
    }
    if (m.t === 'tgarb') {                        // tet: garbage attack -> everyone else
      if (g.mode !== 'tet' || !g.tt || g.tt.phase !== 'playing') return;
      const p = g.tt.players[att.token];
      if (!p || !p.playing || p.finished) return;
      const n = Math.max(1, Math.min(8, m.n | 0));
      this.bcast({ t: 'tgarb', n, from: att.name }, ws);
      return;
    }
    if (m.t === 'tfin') {                         // tet: player topped out
      if (g.mode !== 'tet' || !g.tt || g.tt.phase !== 'playing') return;
      const tt = g.tt, p = tt.players[att.token];
      if (!p || !p.playing || p.finished) return;
      p.finished = true;
      p.score = Math.max(0, Math.min(9_999_999, m.s | 0));
      p.lines = Math.max(0, Math.min(9999, m.l | 0));
      await this.save();
      const waiting = tt.order.filter(t => tt.players[t].playing && tt.players[t].online && !tt.players[t].finished);
      if (!waiting.length) await this.tetResults(g);
      return;
    }
    if (m.t === 'bscore') {                       // beat: live score relay (judged locally)
      if (g.mode !== 'beat' || !g.b || g.b.phase !== 'playing') return;
      const p = g.b.players[att.token];
      if (!p || !p.playing || p.finished) return;
      p.score = Math.max(0, Math.min(9_999_999, m.s | 0));
      this.bcast({ t: 'bscore', name: att.name, s: p.score, c: Math.max(0, m.c | 0) }, ws);
      return;
    }
    if (m.t === 'bfin') {                         // beat: player finished their chart
      if (g.mode !== 'beat' || !g.b || g.b.phase !== 'playing') return;
      const b = g.b, p = b.players[att.token];
      if (!p || !p.playing || p.finished) return;
      p.finished = true;
      p.score = Math.max(0, Math.min(9_999_999, m.s | 0));
      p.maxCombo = Math.max(0, m.mc | 0);
      p.acc = Math.max(0, Math.min(100, +m.acc || 0));
      await this.save();
      const waiting = b.order.filter(t => b.players[t].playing && b.players[t].online && !b.players[t].finished);
      if (!waiting.length) await this.beatResults(g);
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

    if (m.t === 'solo') {                        // omok/alka: take BOTH seats and play alone
      if (g.mode !== 'omok' && g.mode !== 'alka') return;
      if (att.role !== 1 && att.role !== 2 || att.mate) return;
      if (g.tm) return;                          // not in team mode
      const other = att.role === 1 ? 2 : 1;
      const started = g.mode === 'alka' ? g.a.moves > 0 : g.moves > 0;
      if (started) return;                       // only from a fresh board
      if (g.seats[other] && g.seats[other].online && g.seats[other].token !== att.token) return;
      g.seats[other] = { token: att.token, name: att.name + '·2P', online: true };
      await this.save();
      this.bcast(this.roster(g));
      this.bcast({ t: 'sys', text: `${att.name}님이 혼자 두기를 시작했어요 (양쪽 조작)` });
      return;
    }
    if (m.t === 'joinTeam') {                    // omok: become a side's teammate (pair play, alternate moves)
      if (g.mode !== 'omok' || !att.token || !att.name) return;
      const side = m.side === 2 ? 2 : 1;
      if (this.isSolo(g) || !g.seats[side]) return;
      if ((g.seats[1] && g.seats[1].token === att.token) || (g.seats[2] && g.seats[2].token === att.token)) return;
      g.tm = g.tm || { mates: { 1: null, 2: null }, idx: { 1: 0, 2: 0 } };
      const cur = g.tm.mates[side], oth = g.tm.mates[side === 1 ? 2 : 1];
      if (cur && cur.online && cur.token !== att.token) return;    // slot taken
      if (oth && oth.token === att.token) return;                  // already on the other team
      g.tm.mates[side] = { token: att.token, name: att.name, online: true };
      ws.serializeAttachment({ ...att, role: side, mate: true });
      await this.save();
      ws.send(JSON.stringify(this.stateFor(g, side, att.token)));
      this.bcast(this.roster(g));
      this.bcast({ t: 'sys', text: `${att.name}님이 ${side === 1 ? '흑' : '백'}팀에 합류 — 팀원이 번갈아 둡니다` });
      return;
    }

    if (m.t === 'wobble') {                       // alka: aim-noise level (0 정확 .. 3 대삑), players only
      if (g.mode !== 'alka' || (att.role !== 1 && att.role !== 2)) return;
      const v = Math.max(0, Math.min(3, m.v | 0));
      if (g.a.wobble === v) return;
      g.a.wobble = v;
      await this.save();
      this.bcast({ t: 'wobble', v });
      const names = ['🎯 정확', '살짝삑 (±3°)', '삑사리 (±6°)', '대삑 (±10°)'];
      this.bcast({ t: 'sys', text: `${att.name}님이 조준 모드를 [${names[v]}]로 변경` });
      return;
    }
    if (m.t === 'flick') {                        // alka: turn player launches ONE of their stones
      if (g.mode !== 'alka') return;
      const a = g.a;
      if (a.winner || a.phase !== 'idle') return;
      if (!g.seats[1] || !g.seats[2]) return;
      if (!g.seats[a.turn] || g.seats[a.turn].token !== att.token) return;   // token-based: supports solo
      const i = m.i | 0, s = a.stones[i];
      if (!s || !s.a || s.o !== a.turn) return;
      const vx = Math.max(-1300, Math.min(1300, +m.vx || 0));
      const vy = Math.max(-1300, Math.min(1300, +m.vy || 0));
      if (Math.hypot(vx, vy) < 20) return;
      a.phase = 'sim'; a.simSince = Date.now();
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + 10_000);   // safety: unstick if settle never arrives
      this.bcast({ t: 'flick', i, vx, vy }, ws);  // others replay the same impulse locally
      return;
    }
    if (m.t === 'settle') {                       // alka: flicker reports authoritative rest positions
      if (g.mode !== 'alka') return;
      const a = g.a;
      if (a.phase !== 'sim') return;
      if (!g.seats[a.turn] || g.seats[a.turn].token !== att.token) return;   // token-based: supports solo
      const arr = m.stones;
      if (!Array.isArray(arr) || arr.length !== a.stones.length) return;
      for (let k = 0; k < arr.length; k++) {
        const e = arr[k], s = a.stones[k];
        if (!Array.isArray(e) || e.length < 3) return;
        const alive = s.a && e[2] ? 1 : 0;        // stones can't resurrect
        s.a = alive;
        if (alive) { s.x = Math.max(-40, Math.min(640, Math.round(+e[0] || 0)));
                     s.y = Math.max(-40, Math.min(640, Math.round(+e[1] || 0))); }
      }
      a.moves++;
      const c1 = a.stones.filter(s => s.a && s.o === 1).length;
      const c2 = a.stones.filter(s => s.a && s.o === 2).length;
      if (c2 === 0 && c1 > 0) a.winner = 1;
      else if (c1 === 0 && c2 > 0) a.winner = 2;
      else if (c1 === 0 && c2 === 0) a.winner = a.turn === 1 ? 2 : 1;    // killed your own last stone too
      else a.turn = a.turn === 1 ? 2 : 1;
      a.phase = 'idle';
      await this.save();
      this.bcast({ t: 'settle', stones: a.stones, turn: a.turn, winner: a.winner });
      return;
    }

    if (m.t === 'move') {
      if (g.mode !== 'omok') return;
      const i = m.i | 0;
      if (g.winner) return;
      if (i < 0 || i >= CELLS || g.board[i] !== 0) return;
      if (!g.seats[1] || !g.seats[2]) return;    // wait for both players
      const side = g.turn, mem = this.sideMembers(g, side);
      const mi = mem.findIndex(p => p.token === att.token);
      if (mi < 0) return;                        // not this side's player (solo: one token holds both seats)
      if (mem.length > 1) {                      // team: members alternate within the side
        const up = g.tm.idx[side] % mem.length;
        if (mi !== up && mem[up].online !== false) return;   // (an offline teammate may be covered)
      }
      g.board[i] = side; g.moves++; g.last = i;
      const win = winLine(g.board, i);
      if (win) { g.winner = side; g.winLine = win; }
      else if (g.moves === CELLS) g.winner = 3;  // draw
      else g.turn = side === 1 ? 2 : 1;
      if (g.tm) g.tm.idx[side]++;
      await this.save();
      this.bcast({ t: 'move', i, stone: side, turn: g.turn, winner: g.winner, winLine: g.winLine,
                   ups: { 1: this.upOf(g, 1), 2: this.upOf(g, 2) } });
      return;
    }

    if (m.t === 'restart' && g.mode === 'alka') {  // alka rematch: reset stones, swap who starts
      if (att.role !== 1 && att.role !== 2) return;
      if (!g.a.winner) return;
      const s1 = g.seats[1], s2 = g.seats[2];
      g.seats[1] = s2; g.seats[2] = s1;
      g.a = { ...emptyAlka(), round: (g.a.round || 1) + 1 };
      await this.save();
      for (const w of this.ctx.getWebSockets()) {
        const at = w.deserializeAttachment() || {}; let role = 0;
        for (const s of [1, 2]) if (g.seats[s] && g.seats[s].token === at.token) role = s;
        w.serializeAttachment({ ...at, role });
        try { w.send(JSON.stringify(this.stateFor(g, role, at.token))); } catch {}
      }
      this.bcast({ t: 'sys', text: `${att.name}님이 새 판을 시작했어요 (선공 교대)` });
      return;
    }
    if (m.t === 'restart') {                     // omok players only, after a finished game
      if (g.mode !== 'omok') return;
      if (att.role !== 1 && att.role !== 2) return;
      if (!g.winner) return;                     // also makes a racing duplicate restart a no-op
      const s1 = g.seats[1], s2 = g.seats[2];
      const ng = emptyGame('omok');              // keep the room an omok room (was a mode:null bug)
      ng.seats[1] = s2; ng.seats[2] = s1;        // swap colors each round
      ng.round = (g.round || 1) + 1;
      ng.tm = g.tm ? { mates: { 1: g.tm.mates[2], 2: g.tm.mates[1] }, idx: { 1: 0, 2: 0 } } : null;  // teams swap too
      this.game = ng;
      await this.save();
      for (const w of this.ctx.getWebSockets()) {         // roles may have swapped -> fresh state for everyone
        const a = w.deserializeAttachment() || {}; let role = 0, mate = false;
        for (const s of [1, 2]) {
          if (ng.seats[s] && ng.seats[s].token === a.token) { role = s; mate = false; }
          else if (!role && ng.tm && ng.tm.mates[s] && ng.tm.mates[s].token === a.token) { role = s; mate = true; }
        }
        w.serializeAttachment({ ...a, role, mate });
        try { w.send(JSON.stringify(this.stateFor(ng, role, a.token))); } catch {}
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
    if (g.mode === 'beat' && g.b) {
      const b = g.b;
      if (!still && b.players[att.token]) { b.players[att.token].online = false; await this.save(); }
      this.bcast({ t: 'players', players: this.beatPub(b) });
      if (att.name && !still) this.bcast({ t: 'sys', text: `${att.name} 퇴장` });
      if (b.phase === 'playing') {               // everyone left mid-song still finishes the round
        const waiting = b.order.filter(t => b.players[t].playing && b.players[t].online && !b.players[t].finished);
        if (!waiting.length) await this.beatResults(g);
      }
      return;
    }
    if (g.mode === 'tet' && g.tt) {
      const tt = g.tt;
      if (!still && tt.players[att.token]) { tt.players[att.token].online = false; await this.save(); }
      this.bcast({ t: 'players', players: this.tetPub(tt) });
      if (att.name && !still) this.bcast({ t: 'sys', text: `${att.name} 퇴장` });
      if (tt.phase === 'playing') {
        const waiting = tt.order.filter(t => tt.players[t].playing && tt.players[t].online && !tt.players[t].finished);
        if (!waiting.length) await this.tetResults(g);
      }
      return;
    }
    if (!still && att.role && !att.mate && g.seats[att.role] && g.seats[att.role].token === att.token) {
      g.seats[att.role].online = false; await this.save();
    } else if (!still && att.mate && g.tm && g.tm.mates[att.role] && g.tm.mates[att.role].token === att.token) {
      g.tm.mates[att.role].online = false; await this.save();
    }
    // alka: if the flicker vanished mid-simulation, unstick the room (positions stay at last settle)
    if (g.mode === 'alka' && g.a && g.a.phase === 'sim' && !still && att.role === g.a.turn) {
      g.a.phase = 'idle'; await this.save();
      this.bcast({ t: 'abort' });
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
