/* Thalassa client — Race for the Golden Fleece.
 * Lobby, WebSocket protocol, HUD, battle/question/minigame UI.
 * The 3D fogged sea lives in scene.js; this file owns everything DOM. */
import { createWorld, DOMAIN_COLORS } from '/static/scene.js';
import { audio } from '/static/audio.js';

const $ = (id) => document.getElementById(id);
const KIND_LABEL = {
  shrine: 'Shrine Wager', battle: 'BATTLE', puzzle: 'Riddle of the Isle',
  riddle: 'Riddle of the Isle',
};
const MG_LABEL = {
  tetromino: 'Sigil of the Isle', nonogram: 'The Weaver’s Grid',
  simon: 'Echoes of the Muses', anagram: 'The Scattered Letters',
  ravens: 'The Pattern of Fate',
};
const MG_PROMPT = {
  tetromino: 'Fill the sigil completely with the given pieces. Tap a piece, rotate it, tap the grid to place. Tap a placed piece to lift it.',
  nonogram: 'Paint cells so every row and column matches its clue numbers.',
  simon: 'Watch the tiles sing… then repeat the sequence from memory.',
  anagram: 'Unscramble the letters into a word.',
  ravens: 'Find the rule. Choose the missing ninth tile.',
};
const TIER_ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

let ws = null;
let you = null;
let room = null;
let world = null;
let token = localStorage.getItem('thalassa_token');
if (!token) {
  token = crypto.randomUUID();
  localStorage.setItem('thalassa_token', token);
}

/* ── boot ────────────────────────────────────────────────────────────────── */
world = createWorld($('world'), (node) => {
  if (room && room.phase === 'sail' && room.turn === you && node in (room.reachable || {})) {
    send({ type: 'sail', node });
  }
});

$('nameInput').value = localStorage.getItem('thalassa_name') || '';

const muteBtn = $('muteBtn');
function paintMute() {
  muteBtn.textContent = audio.isMuted() ? '🔇' : '🔊';
  muteBtn.classList.toggle('off', audio.isMuted());
}
paintMute();
muteBtn.onclick = () => { audio.init(); audio.toggleMuted(); paintMute(); };

document.addEventListener('pointerdown', (e) => {
  audio.init();
  if (e.target.closest('.act, .opt, .big, .small, .mgcell, .mgpad, .glyphopt')) audio.sfx.click();
}, { passive: true });

$('joinBtn').onclick = () => { audio.init(); audio.startMusic(); audio.sfx.join(); connect(); };
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

function showLobbyErr(msg) { $('lobbyErr').textContent = msg; }

let pingInterval = null;

function connect() {
  const name = $('nameInput').value.trim() || 'Captain';
  localStorage.setItem('thalassa_name', name);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => send({ type: 'hello', token, name });
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    if (room && room.phase !== 'finished') {
      toast('Connection lost — reconnecting…', true);
      setTimeout(() => connect(), 1500);
    }
  };
  clearInterval(pingInterval);
  pingInterval = setInterval(() => { if (ws?.readyState === 1) send({ type: 'ping' }); }, 25000);
}

function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

/* ── message handling ────────────────────────────────────────────────────── */
let lastLogLine = null;

function handle(msg) {
  if (msg.type === 'snapshot') {
    const prev = room;
    you = msg.you;
    room = msg.room;
    window.__room = room;                 // debug/testing handle
    render();
    reactAudio(prev, room);
  } else if (msg.type === 'dice') {
    audio.sfx.dice();
    animateDie(msg.value);
  } else if (msg.type === 'error') {
    toast(msg.msg, true);
  }
}

/* ── sound reactions ─────────────────────────────────────────────────────── */
let sfxLastTurn = null, sfxPrevPhase = null, sfxAnnouncedWin = false;

function reactAudio(prev, next) {
  if (!next) return;
  if (next.phase === 'roll' && next.turn === you && sfxLastTurn !== next.turn) {
    audio.sfx.turn();
  }
  sfxLastTurn = next.phase === 'lobby' ? null : next.turn;

  if (next.phase === 'reveal' && sfxPrevPhase !== 'reveal' && next.reveal) {
    const rv = next.reveal;
    if (rv.kind === 'battle') {
      if (rv.was_correct) audio.sfx.hit(); else audio.sfx.hurt();
      if (rv.battle_over && rv.was_correct) setTimeout(() => audio.sfx.laurel(), 450);
    } else if (rv.was_correct) audio.sfx.correct();
    else audio.sfx.wrong();
  }
  if (next.phase === 'battle' && sfxPrevPhase !== 'battle' && sfxPrevPhase !== 'reveal') {
    audio.sfx.roar();
  }
  if (next.phase === 'finished' && !sfxAnnouncedWin) {
    audio.sfx.victory();
    sfxAnnouncedWin = true;
  }
  if (next.phase !== 'finished') sfxAnnouncedWin = false;
  audio.duck(['question', 'reveal', 'minigame'].includes(next.phase));
  sfxPrevPhase = next.phase;
}

/* ── rendering ───────────────────────────────────────────────────────────── */
function render() {
  world.update(room, you);
  const inLobby = room.phase === 'lobby';
  $('lobby').classList.toggle('hidden', !inLobby);
  $('hud').classList.toggle('hidden', inLobby);
  if (inLobby) return renderLobby();

  renderPlayers();
  renderGoal();
  renderTurnBanner();
  renderTray();
  renderBattle();
  renderQuestion();
  renderMinigame();
  renderModal();
  renderLog();
}

function renderLobby() {
  $('joinForm').classList.add('hidden');
  $('waitRoom').classList.remove('hidden');
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.bot ? '🤖 ' : ''}${esc(p.name)}` +
      (p.pid === room.host ? ' <em>(host)</em>' : '') +
      (you === room.host && p.pid !== you ? ` <button class="kick" data-pid="${p.pid}">✕</button>` : '');
    ul.appendChild(li);
  }
  ul.querySelectorAll('.kick').forEach((b) => {
    b.onclick = () => send({ type: 'kick', pid: b.dataset.pid });
  });
  const isHost = you === room.host;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = room.players.length < 1;
  $('startBtn').textContent = 'SET SAIL';
  $('addBotBtn').classList.toggle('hidden', !isHost || room.players.length >= 6);
  $('waitMsg').classList.toggle('hidden', isHost);
}
$('startBtn').onclick = () => send({ type: 'start' });
$('addBotBtn').onclick = () => send({ type: 'add_bot' });
$('copyLink').onclick = () => {
  navigator.clipboard?.writeText(location.href);
  $('copyLink').textContent = 'copied!';
  setTimeout(() => { $('copyLink').textContent = 'copy invite link'; }, 1200);
};

function hearts(p) {
  return '♥'.repeat(p.hull) + '<span class="dim">' + '♥'.repeat(Math.max(0, p.max_hull - p.hull)) + '</span>';
}

function renderPlayers() {
  const el = $('players');
  el.innerHTML = '';
  for (const p of room.players) {
    const div = document.createElement('div');
    div.className = 'pchip' + (p.pid === room.turn ? ' turn' : '') + (p.connected ? '' : ' gone');
    div.innerHTML =
      `<span class="dot" style="background:${p.color}"></span>` +
      `<span class="pname">${p.bot ? '🤖 ' : ''}${esc(p.name)}</span>` +
      (p.streak >= 2 ? `<span class="streak">🔥${p.streak}</span>` : '') +
      `<span class="hearts">${hearts(p)}</span>` +
      `<span class="stat">📜${p.scrolls}</span>` +
      (p.cargo ? `<span class="stat cargo">⚱${p.cargo}</span>` : '') +
      `<span class="stat banked">✦${p.banked}/${room.config.relics_to_win}</span>` +
      (you === room.host && p.pid !== you ? `<button class="kick" data-pid="${p.pid}">✕</button>` : '');
    el.appendChild(div);
  }
  el.querySelectorAll('.kick').forEach((b) => {
    b.onclick = () => send({ type: 'kick', pid: b.dataset.pid });
  });
}

function renderGoal() {
  const me = room.players.find((p) => p.pid === you);
  const el = $('goal');
  if (!me) { el.innerHTML = '<strong>✦ Goal:</strong> bank 3 relics, then claim the Golden Fleece'; return; }
  const n = room.config.relics_to_win;
  const pips = Array.from({ length: n }, (_, i) =>
    `<span class="pip ${i < me.banked ? 'on' : ''}">✦</span>`).join('');
  let hint;
  if (room.winner) hint = '';
  else if (me.banked >= n) hint = '⚡ <strong>THE FLEECE AWAITS</strong> — sail to the golden isle and slay its guardian!';
  else if (me.cargo > 0) hint = `⚱ Relic aboard — <strong>sail it home</strong> to bank it!`;
  else hint = 'Defeat lair guardians for relics · shrines pay scrolls · puzzle isles grant upgrades';
  el.innerHTML = `${pips} <span class="goaltext">${hint}</span>`;
}

function renderTurnBanner() {
  const p = room.players.find((x) => x.pid === room.turn);
  const el = $('turnBanner');
  if (!p || room.phase === 'finished') { el.textContent = ''; return; }
  el.innerHTML = room.turn === you ? '<strong>Your turn, captain</strong>' : `${esc(p.name)}'s turn`;
  el.style.borderColor = p.color;
}

function renderTray() {
  const tray = $('tray');
  tray.innerHTML = '';
  const mine = room.turn === you;

  const btn = (label, cls, onclick, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'act ' + cls;
    b.innerHTML = label;
    b.disabled = disabled;
    b.onclick = onclick;
    tray.appendChild(b);
    return b;
  };
  const hint = (text) => {
    const s = document.createElement('span');
    s.className = 'hint';
    s.innerHTML = text;
    tray.appendChild(s);
  };

  if (room.phase === 'finished') {
    const w = room.players.find((p) => p.pid === room.winner);
    hint(`🐏 <strong>${esc(w?.name || '?')}</strong> holds the Golden Fleece!`);
    if (you === room.host) btn('NEW VOYAGE', 'gold', () => send({ type: 'rematch' }));
    return;
  }
  if (!mine) {
    if (you === room.host && room.phase !== 'lobby') {
      btn('skip turn', 'ghost small', () => send({ type: 'skip' }));
    }
    return;
  }

  if (room.phase === 'roll') {
    btn('🎲 ROLL', 'gold big', () => send({ type: 'roll' }));
  } else if (room.phase === 'sail') {
    const me = room.players.find((p) => p.pid === you);
    const bonus = me?.upgrades.includes('sandals') ? ' (+1 sandals)' : '';
    hint(`You rolled <strong>${room.die}</strong>${bonus} — tap a glowing isle. Grey silhouettes are unexplored.`);
  } else if (room.phase === 'shrine') {
    const me = room.players.find((p) => p.pid === you);
    const node = (room.board.nodes || []).find((n) => n.id === me.node);
    const dom = node?.domain;
    const dinfo = dom ? room.board.domains[dom] : null;
    hint(`Shrine of <strong style="color:${DOMAIN_COLORS[dom]}">${dinfo?.field || '?'}</strong> · ${node?.charges} offering(s) left. Wager your wits:`);
    btn('Tier I<small>+1 scroll</small>', 'tier', () => send({ type: 'wager', tier: 1 }));
    btn('Tier II<small>+2 scrolls</small>', 'tier', () => send({ type: 'wager', tier: 2 }));
    btn('Tier III<small>+3 / lose 1</small>', 'tier hot', () => send({ type: 'wager', tier: 3 }));
    btn('pass', 'ghost', () => send({ type: 'pass' }));
  } else if (room.phase === 'haven') {
    const me = room.players.find((p) => p.pid === you);
    const missing = me.max_hull - me.hull;
    const afford = Math.min(missing, me.scrolls);
    hint('A quiet haven. Shipwrights work for scrolls.');
    btn(`⚒ REPAIR<small>+${afford} hull · ${afford} scrolls</small>`, 'build', () => send({ type: 'repair' }));
    btn('pass', 'ghost', () => send({ type: 'pass' }));
  }
}

/* ── battle card ─────────────────────────────────────────────────────────── */
function renderBattle() {
  const card = $('battleCard');
  const b = room.battle;
  const show = b && ['battle', 'question', 'reveal'].includes(room.phase) &&
               (room.phase !== 'reveal' || room.reveal?.kind === 'battle');
  card.classList.toggle('hidden', !show);
  if (!show) return;
  const mine = room.turn === you;
  const dcolor = DOMAIN_COLORS[b.domain] || '#888';
  const me = room.players.find((p) => p.pid === room.turn);
  const hp = '🔴'.repeat(Math.max(0, b.hp)) + '⚪'.repeat(Math.max(0, b.max_hp - b.hp));
  card.innerHTML = `
    <div class="mhead" style="border-color:${dcolor}">
      <span class="mname">${b.is_fleece ? '🐉 ' : b.is_lair ? '⚱ ' : '⚔ '}${esc(b.name)}</span>
      <span class="mdomain" style="color:${dcolor}">${room.board.domains[b.domain]?.field || ''}</span>
    </div>
    <div class="mstats">${hp} &nbsp;· power ${b.power} · asks tier ${TIER_ROMAN[b.tier] || b.tier}</div>
    <div class="mactions"></div>`;
  const actions = card.querySelector('.mactions');
  if (room.phase === 'battle' && mine) {
    const mk = (label, cls, fn) => {
      const bt = document.createElement('button');
      bt.className = 'act ' + cls;
      bt.innerHTML = label;
      bt.onclick = fn;
      actions.appendChild(bt);
    };
    mk('⚔ ATTACK<small>+1 dmg · miss hurts more</small>', 'tier hot', () => send({ type: 'stance', stance: 'attack' }));
    mk('🛡 GUARD<small>−1 dmg · miss hurts less</small>', 'tier', () => send({ type: 'stance', stance: 'guard' }));
    mk('🏃 FLEE<small>lose 1 hull, retreat</small>', 'ghost', () => send({ type: 'flee' }));
  } else if (room.phase === 'battle') {
    actions.innerHTML = `<span class="hint">${esc(me?.name || '')} chooses a stance…</span>`;
  }
}

/* ── question card ───────────────────────────────────────────────────────── */
let timerRAF = null;
let mySideAnswer = null;
let sideKey = null;

function renderQuestion() {
  const modal = $('qmodal');
  const isQ = room.phase === 'question' || (room.phase === 'reveal' && room.reveal);
  modal.classList.toggle('hidden', !isQ);
  if (!isQ) { cancelAnimationFrame(timerRAF); return; }

  const q = room.question;
  const rv = room.phase === 'reveal' ? room.reveal : null;
  const ctxDomain = q?.domain ?? rv?.domain;
  const ctxKind = q?.kind ?? rv?.kind;
  const dcolor = ctxDomain ? DOMAIN_COLORS[ctxDomain] : '#7d5ba6';
  const dinfo = ctxDomain ? room.board.domains[ctxDomain] : null;

  $('qhead').style.background = dcolor;
  $('qkind').textContent = ctxKind === 'shrine'
    ? `${KIND_LABEL.shrine} · Tier ${TIER_ROMAN[q?.tier ?? 1] || ''}`
    : (KIND_LABEL[ctxKind] || 'Challenge');
  $('qdomain').textContent = dinfo ? `${dinfo.name} · ${dinfo.field}` : 'Wits & Logic';

  // battle items (owl / lyre)
  const itemsRow = $('qitems');
  itemsRow.innerHTML = '';
  const me = room.players.find((p) => p.pid === you);
  if (room.phase === 'question' && ctxKind === 'battle' && room.turn === you && me && room.battle) {
    for (const item of ['owl', 'lyre']) {
      if (me.upgrades.includes(item) && !room.battle.used_items.includes(item)) {
        const b = document.createElement('button');
        b.className = 'act small itembtn';
        b.textContent = item === 'owl' ? '🦉 Owl: 50/50' : '🎼 Lyre: new question';
        b.onclick = () => send({ type: 'item', id: item });
        itemsRow.appendChild(b);
      }
    }
  }

  if (!q && !rv) {
    $('qtext').textContent = 'A herald fetches the question…';
    $('qopts').innerHTML = '';
    $('qnote').textContent = '';
    return;
  }

  const mine = room.turn === you;
  const amPlayer = !!me;
  if (room.phase === 'question') {
    const qkey = `${q.text}`.slice(0, 40);
    if (sideKey !== qkey) { sideKey = qkey; mySideAnswer = null; }
    $('qtext').textContent = q.text;
    const opts = $('qopts');
    opts.innerHTML = '';
    const alreadySide = (room.side_answered || []).includes(you) || mySideAnswer !== null;
    q.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.textContent = opt;
      if ((q.disabled || []).includes(i)) b.classList.add('ruled');
      if (mySideAnswer === i) b.classList.add('picked');
      b.disabled = (q.disabled || []).includes(i) ||
        (mine ? false : (!amPlayer || alreadySide));
      b.onclick = () => {
        if (mine) send({ type: 'answer', idx: i });
        else { mySideAnswer = i; send({ type: 'answer', idx: i }); render(); }
      };
      opts.appendChild(b);
    });
    $('qnote').textContent = mine ? '' :
      (amPlayer
        ? (alreadySide ? 'Answer locked in — right = +1 scroll.' : 'Answer too! Correct = +1 scroll.')
        : `${esc(room.players.find((p) => p.pid === room.turn)?.name || '')} is answering…`);
    startTimerBar(q.deadline, '#qtimerBar');
  } else {
    cancelAnimationFrame(timerRAF);
    $('qtimerBar').style.width = '0%';
    const opts = $('qopts');
    [...opts.children].forEach((b, i) => {
      b.disabled = true;
      if (i === rv.correct) b.classList.add('good');
      else if (i === rv.chosen) b.classList.add('bad');
      if (mySideAnswer === i && i !== rv.correct) b.classList.add('bad');
    });
    let note = rv.was_correct ? '✓ Correct! ' : (rv.chosen === -1 ? '⏳ Time expired. ' : '✗ Wrong. ');
    note += rv.note || '';
    const sideMine = rv.side?.[you];
    if (sideMine) note += sideMine.ok ? ' (Your side answer: +1 scroll!)' : ' (Your side answer missed.)';
    $('qnote').textContent = note;
    mySideAnswer = null;
  }
}

function startTimerBar(deadline, barId) {
  cancelAnimationFrame(timerRAF);
  const bar = document.querySelector(barId);
  if (!deadline) { bar.style.width = '100%'; return; }
  const total = deadline - Date.now() / 1000;
  const tick = () => {
    const left = deadline - Date.now() / 1000;
    const pct = Math.max(0, Math.min(1, left / total));
    bar.style.width = (pct * 100) + '%';
    bar.style.background = pct < 0.25 ? '#e4572e' : '';
    if (pct > 0 && (room.phase === 'question' || room.phase === 'minigame')) {
      timerRAF = requestAnimationFrame(tick);
    }
  };
  tick();
}

/* ── minigames ───────────────────────────────────────────────────────────── */
let mg = { key: null };          // client-side minigame scratch state

function renderMinigame() {
  const modal = $('mgmodal');
  const m = room.minigame;
  const show = room.phase === 'minigame' && m;
  modal.classList.toggle('hidden', !show);
  if (!show) { mg = { key: null }; return; }

  const mine = room.turn === you;
  const key = `${m.island}:${m.kind}:${m.deadline}`;
  const fresh = mg.key !== key;
  if (fresh) mg = { key, sel: null, rot: 0, cells: null, taps: [], watched: false, grid: null };

  $('mgkind').textContent = MG_LABEL[m.kind] || 'Trial';
  $('mgisle').textContent = (room.board.nodes.find((n) => n.id === m.island) || {}).name || '';
  $('mgprompt').textContent = mine ? MG_PROMPT[m.kind]
    : `${esc(room.players.find((p) => p.pid === room.turn)?.name || 'A rival')} attempts the trial…`;
  startTimerBar(m.deadline, '#mgtimerBar');
  $('mgnote').textContent = '';

  const board = $('mgboard');
  if (!fresh && !mine) return;                    // spectators: static board
  if (fresh) board.innerHTML = '';

  if (m.kind === 'tetromino') renderTetromino(board, m, mine, fresh);
  else if (m.kind === 'nonogram') renderNonogram(board, m, mine, fresh);
  else if (m.kind === 'simon') renderSimon(board, m, mine, fresh);
  else if (m.kind === 'anagram') renderAnagram(board, m, mine, fresh);
  else if (m.kind === 'ravens') renderRavens(board, m, mine, fresh);
}

/* tetromino — Talos-style sigil fill */
const PIECE_COLORS = ['#e4572e', '#2e86ab', '#f6ae2d', '#8e5572', '#33ca7f', '#6457a6', '#c9a227'];

function rotForm(form, times) {
  let cur = form.map(([x, y]) => [x, y]);
  for (let i = 0; i < times; i++) cur = cur.map(([x, y]) => [y, -x]);
  const xs = Math.min(...cur.map((c) => c[0])), ys = Math.min(...cur.map((c) => c[1]));
  return cur.map(([x, y]) => [x - xs, y - ys]);
}

function renderTetromino(board, m, mine, fresh) {
  if (fresh) {
    mg.cells = Array(m.w * m.h).fill(-1);
    mg.placed = {};                               // pieceIdx → cells
  }
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'mggrid';
  grid.style.gridTemplateColumns = `repeat(${m.w}, 1fr)`;
  for (let i = 0; i < m.w * m.h; i++) {
    const c = document.createElement('button');
    c.className = 'mgcell';
    const v = mg.cells[i];
    if (v >= 0) c.style.background = PIECE_COLORS[v % PIECE_COLORS.length];
    c.disabled = !mine;
    c.onclick = () => {
      if (mg.cells[i] >= 0) {                     // lift a placed piece
        const idx = mg.cells[i];
        for (const j of mg.placed[idx]) mg.cells[j] = -1;
        delete mg.placed[idx];
      } else if (mg.sel !== null && !(mg.sel in mg.placed)) {
        const form = rotForm(m.shapes[m.pieces[mg.sel]], mg.rot);
        const x0 = i % m.w, y0 = Math.floor(i / m.w);
        const cells = [];
        for (const [dx, dy] of form) {
          const x = x0 + dx, y = y0 + dy;
          if (x >= m.w || y >= m.h || mg.cells[y * m.w + x] >= 0) { cells.length = 0; break; }
          cells.push(y * m.w + x);
        }
        if (cells.length === 4) {
          for (const j of cells) mg.cells[j] = mg.sel;
          mg.placed[mg.sel] = cells;
          if (Object.keys(mg.placed).length === m.pieces.length) {
            send({ type: 'solve', payload: mg.cells });
          }
        } else {
          $('mgnote').textContent = 'It does not fit there.';
        }
      }
      renderTetromino(board, m, mine, false);
    };
    grid.appendChild(c);
  }
  board.appendChild(grid);

  const palette = document.createElement('div');
  palette.className = 'mgpalette';
  m.pieces.forEach((name, idx) => {
    const used = idx in (mg.placed || {});
    const pbtn = document.createElement('button');
    pbtn.className = 'mgpiece' + (mg.sel === idx ? ' sel' : '') + (used ? ' used' : '');
    pbtn.disabled = !mine || used;
    const form = rotForm(m.shapes[name], mg.sel === idx ? mg.rot : 0);
    const pw = Math.max(...form.map((c) => c[0])) + 1;
    const ph = Math.max(...form.map((c) => c[1])) + 1;
    pbtn.style.gridTemplateColumns = `repeat(${pw}, 8px)`;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const dot = document.createElement('i');
        if (form.some(([fx, fy]) => fx === x && fy === y)) {
          dot.style.background = PIECE_COLORS[idx % PIECE_COLORS.length];
        }
        pbtn.appendChild(dot);
      }
    }
    pbtn.onclick = () => {
      if (mg.sel === idx) mg.rot = (mg.rot + 1) % 4;    // tap again = rotate
      else { mg.sel = idx; mg.rot = 0; }
      renderTetromino(board, m, mine, false);
    };
    palette.appendChild(pbtn);
  });
  const tip = document.createElement('span');
  tip.className = 'hint';
  tip.textContent = 'tap selected piece again to rotate';
  palette.appendChild(tip);
  board.appendChild(palette);
}

/* nonogram */
function renderNonogram(board, m, mine, fresh) {
  if (fresh) mg.grid = Array(m.n * m.n).fill(0);
  board.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'nonowrap';
  const table = document.createElement('div');
  table.className = 'nonogrid';
  table.style.gridTemplateColumns = `auto repeat(${m.n}, 1fr)`;
  // corner + column clues
  table.appendChild(Object.assign(document.createElement('div'), { className: 'nclue' }));
  for (let c = 0; c < m.n; c++) {
    const d = document.createElement('div');
    d.className = 'nclue top';
    d.innerHTML = m.cols[c].join('<br>');
    table.appendChild(d);
  }
  for (let r = 0; r < m.n; r++) {
    const rc = document.createElement('div');
    rc.className = 'nclue left';
    rc.textContent = m.rows[r].join(' ');
    table.appendChild(rc);
    for (let c = 0; c < m.n; c++) {
      const i = r * m.n + c;
      const cell = document.createElement('button');
      cell.className = 'mgcell nono' + (mg.grid[i] ? ' on' : '');
      cell.disabled = !mine;
      cell.onclick = () => {
        mg.grid[i] ^= 1;
        cell.classList.toggle('on', !!mg.grid[i]);
        if (cluesMatch(m, mg.grid)) send({ type: 'solve', payload: mg.grid });
      };
      table.appendChild(cell);
    }
  }
  wrap.appendChild(table);
  board.appendChild(wrap);
}

function lineClues(line) {
  const out = [];
  let run = 0;
  for (const v of line) {
    if (v) run++;
    else if (run) { out.push(run); run = 0; }
  }
  if (run) out.push(run);
  return out.length ? out : [0];
}

function cluesMatch(m, grid) {
  for (let r = 0; r < m.n; r++) {
    if (JSON.stringify(lineClues(grid.slice(r * m.n, (r + 1) * m.n))) !== JSON.stringify(m.rows[r])) return false;
  }
  for (let c = 0; c < m.n; c++) {
    const col = [];
    for (let r = 0; r < m.n; r++) col.push(grid[r * m.n + c]);
    if (JSON.stringify(lineClues(col)) !== JSON.stringify(m.cols[c])) return false;
  }
  return true;
}

/* simon */
function renderSimon(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  const pad = document.createElement('div');
  pad.className = 'simonpad';
  const tiles = [];
  for (let i = 0; i < 9; i++) {
    const t = document.createElement('button');
    t.className = 'mgpad';
    t.disabled = true;
    t.onclick = () => {
      if (!mine || !mg.watched) return;
      flash(t);
      audio.sfx.click();
      mg.taps.push(i);
      if (mg.taps.length === m.seq.length) {
        send({ type: 'solve', payload: mg.taps });
        mg.taps = [];
        $('mgnote').textContent = '…';
      }
    };
    tiles.push(t);
    pad.appendChild(t);
  }
  board.appendChild(pad);
  const flash = (tile) => {
    tile.classList.add('lit');
    setTimeout(() => tile.classList.remove('lit'), 320);
  };
  // playback
  $('mgnote').textContent = 'Watch…';
  m.seq.forEach((tileIdx, k) => {
    setTimeout(() => {
      flash(tiles[tileIdx]);
      audio.sfx.click();
      if (k === m.seq.length - 1) {
        setTimeout(() => {
          mg.watched = true;
          tiles.forEach((t) => { t.disabled = !mine; });
          $('mgnote').textContent = mine ? 'Now repeat the sequence.' : '';
        }, 500);
      }
    }, 700 + k * 620);
  });
}

/* anagram */
function renderAnagram(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  const letters = document.createElement('div');
  letters.className = 'agletters';
  for (const ch of m.letters) {
    const t = document.createElement('span');
    t.className = 'agtile';
    t.textContent = ch;
    letters.appendChild(t);
  }
  board.appendChild(letters);
  if (mine) {
    const row = document.createElement('div');
    row.className = 'agrow';
    const input = document.createElement('input');
    input.className = 'aginput';
    input.maxLength = m.length;
    input.placeholder = `${m.length} letters`;
    input.autocomplete = 'off';
    const go = document.createElement('button');
    go.className = 'act';
    go.textContent = 'ANSWER';
    const submit = () => {
      if (input.value.trim().length === m.length) send({ type: 'solve', payload: input.value.trim() });
      else $('mgnote').textContent = `Needs ${m.length} letters.`;
    };
    go.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(input, go);
    board.appendChild(row);
    setTimeout(() => input.focus(), 100);
  }
}

/* raven's matrix */
function glyphSVG(g, size = 54) {
  const s = size, pad = 6;
  const cell = (s - pad * 2);
  const spots = { 1: [[0.5, 0.5]], 2: [[0.3, 0.3], [0.7, 0.7]],
                  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
                  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]] }[g.count] || [[0.5, 0.5]];
  const r = cell * (g.count === 1 ? 0.3 : 0.16);
  let inner = '';
  for (const [fx, fy] of spots) {
    const cx = pad + fx * cell, cy = pad + fy * cell;
    const fill = g.fill === 'full' ? '#16344a' : g.fill === 'half' ? 'url(#half)' : 'none';
    if (g.shape === 'circle') {
      inner += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="#16344a" stroke-width="2.5"/>`;
    } else if (g.shape === 'square') {
      inner += `<rect x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" fill="${fill}" stroke="#16344a" stroke-width="2.5"/>`;
    } else if (g.shape === 'triangle') {
      inner += `<polygon points="${cx},${cy - r} ${cx + r},${cy + r} ${cx - r},${cy + r}" fill="${fill}" stroke="#16344a" stroke-width="2.5"/>`;
    } else {
      inner += `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" fill="${fill}" stroke="#16344a" stroke-width="2.5"/>`;
    }
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <defs><linearGradient id="half" x1="0" y1="0" x2="0" y2="1">
      <stop offset="50%" stop-color="#16344a"/><stop offset="50%" stop-color="transparent"/>
    </linearGradient></defs>${inner}</svg>`;
}

function renderRavens(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'ravgrid';
  m.grid.forEach((g) => {
    const d = document.createElement('div');
    d.className = 'ravcell';
    d.innerHTML = glyphSVG(g);
    grid.appendChild(d);
  });
  const q = document.createElement('div');
  q.className = 'ravcell missing';
  q.textContent = '?';
  grid.appendChild(q);
  board.appendChild(grid);
  const opts = document.createElement('div');
  opts.className = 'ravopts';
  m.options.forEach((g, i) => {
    const b = document.createElement('button');
    b.className = 'glyphopt';
    b.disabled = !mine;
    b.innerHTML = glyphSVG(g, 46);
    b.onclick = () => send({ type: 'solve', payload: i });
    opts.appendChild(b);
  });
  board.appendChild(opts);
}

/* ── modal: upgrades · intro · winner ────────────────────────────────────── */
let introDismissed = false;

function renderModal() {
  const modal = $('modal');
  const body = $('modalBody');
  const show = (html) => { modal.classList.remove('hidden'); body.innerHTML = html; };

  if (room.phase !== 'lobby' && room.phase !== 'finished' && !introDismissed) {
    show(`<h2>🐏 The Race for the Golden Fleece</h2>
      <ol class="intro">
        <li><strong>Explore</strong> — roll and sail into the fog. Farther isles are harder and richer.</li>
        <li><strong>Earn</strong> — shrines pay scrolls for trivia; puzzle isles grant ship upgrades.</li>
        <li><strong>Fight</strong> — monsters guard relics: pick a stance, answer, roll damage. Hull 0 = shipwreck.</li>
        <li><strong>Bank 3 relics</strong> at Home Port — cargo at sea can be lost!</li>
        <li><strong>Claim the Fleece</strong> — its isle appears once you bank 3. Slay the dragon. Win.</li>
      </ol>
      <p class="tag">Answer on rivals' turns too — a correct side answer skims a scroll. Streaks of 3+ pay bonus scrolls.</p>
      <button id="introGo" class="big">TO THE SHIPS</button>`);
    $('introGo').onclick = () => { introDismissed = true; modal.classList.add('hidden'); render(); };
    return;
  }

  if (room.phase === 'upgrade_pick') {
    if (room.turn === you && room.upgrade_offer) {
      show('<h2>⚙ Choose your prize</h2><div class="upgrades"></div>');
      const wrap = body.querySelector('.upgrades');
      for (const id of room.upgrade_offer) {
        const info = room.upgrade_info[id];
        const b = document.createElement('button');
        b.className = 'upcard';
        b.innerHTML = `<strong>${esc(info.name)}</strong><span>${esc(info.desc)}</span>`;
        b.onclick = () => send({ type: 'pick', upgrade: id });
        wrap.appendChild(b);
      }
    } else {
      const p = room.players.find((x) => x.pid === room.turn);
      show(`<h2>⚙ Spoils</h2><p>${esc(p?.name || '')} chooses an upgrade…</p>`);
    }
    return;
  }

  if (room.phase === 'finished') {
    const w = room.players.find((p) => p.pid === room.winner);
    show(`<h2>🐏 The Golden Fleece</h2>
      <p><strong style="color:${w?.color}">${esc(w?.name || '?')}</strong> has slain the dragon and
      claimed the Fleece. The Aegean sings their name.</p>
      ${you === room.host ? '<button id="rematchGo" class="big">NEW VOYAGE (new sea)</button>' : '<p class="tag">the host may launch a new voyage</p>'}`);
    const rg = $('rematchGo');
    if (rg) rg.onclick = () => { introDismissed = false; send({ type: 'rematch' }); };
    return;
  }

  modal.classList.add('hidden');
}

/* ── single die ──────────────────────────────────────────────────────────── */
const DIE_ROT = {
  1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [180, 0],
};
let dieTimeout = null;

function buildCube(el) {
  if (el.dataset.built) return;
  el.dataset.built = '1';
  const faces = { front: 1, back: 6, top: 2, bottom: 5, right: 3, left: 4 };
  for (const [side, n] of Object.entries(faces)) {
    const f = document.createElement('div');
    f.className = `face ${side}`;
    for (let i = 0; i < n; i++) f.appendChild(document.createElement('i'));
    f.dataset.pips = n;
    el.appendChild(f);
  }
}

function animateDie(value) {
  const box = $('dice');
  box.classList.remove('hidden');
  const cube = $('die1').querySelector('.cube');
  buildCube(cube);
  // deterministic tumble: reset flat with no transition, then spin to the face
  cube.style.transition = 'none';
  cube.style.transform = 'rotateX(0deg) rotateY(0deg)';
  void cube.offsetWidth;                              // force reflow
  const [rx, ry] = DIE_ROT[value];
  cube.style.transition = 'transform 1.05s cubic-bezier(.25,.65,.3,1.02)';
  cube.style.transform = `rotateX(${720 + rx}deg) rotateY(${720 + ry}deg)`;
  clearTimeout(dieTimeout);
  dieTimeout = setTimeout(() => box.classList.add('hidden'), 4000);
}

/* ── toasts & log ────────────────────────────────────────────────────────── */
function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function renderLog() {
  const lines = room.log || [];
  const latest = lines[lines.length - 1];
  if (latest && latest !== lastLogLine) {
    lastLogLine = latest;
    toast(latest);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
