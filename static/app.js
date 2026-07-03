/* Thalassa client — lobby, WebSocket protocol, HUD, and question UI.
 * The 3D board lives in scene.js; this file owns everything DOM. */
import { createWorld, DOMAIN_COLORS } from '/static/scene.js';

const $ = (id) => document.getElementById(id);
const DOMAIN_ORDER = ['clio', 'athena', 'apollo', 'dionysos'];
const KIND_LABEL = {
  wager: 'Wager', trial: 'THE TRIAL', tuition: 'Tuition Challenge',
  oracle: 'THE PYTHIA SPEAKS', symposium: 'THE SYMPOSIUM OF DELOS',
};
const TIER_ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

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

$('joinBtn').onclick = () => connect();
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
    you = msg.you;
    room = msg.room;
    render();
  } else if (msg.type === 'dice') {
    animateDice(msg.d1, msg.d2);
  } else if (msg.type === 'error') {
    toast(msg.msg, true);
  } else if (msg.type === 'fatal') {
    showLobbyErr(msg.msg);
    $('lobby').classList.remove('hidden');
    $('hud').classList.add('hidden');
  }
}

/* ── rendering ───────────────────────────────────────────────────────────── */
function render() {
  world.update(room, you);
  const inLobby = room.phase === 'lobby';
  $('lobby').classList.toggle('hidden', !inLobby);
  $('hud').classList.toggle('hidden', inLobby);
  if (inLobby) return renderLobby();

  renderPlayers();
  renderTurnBanner();
  renderTray();
  renderQuestion();
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
  $('startBtn').disabled = room.players.length < 2;
  $('startBtn').textContent = room.players.length < 2 ? 'NEED 2+ CAPTAINS' : 'SET SAIL';
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

function renderPlayers() {
  const el = $('players');
  el.innerHTML = '';
  for (const p of room.players) {
    const div = document.createElement('div');
    div.className = 'pchip' + (p.pid === room.turn ? ' turn' : '') + (p.connected ? '' : ' gone');
    const scrolls = DOMAIN_ORDER.map((d) =>
      `<span class="scroll" style="background:${DOMAIN_COLORS[d]}" title="${d}">${p.scrolls[d]}</span>`).join('');
    const laurels = DOMAIN_ORDER.map((d) =>
      p.laurels.includes(d) ? `<span class="laurel" style="color:${DOMAIN_COLORS[d]}">🏆</span>` : '').join('');
    div.innerHTML =
      `<span class="dot" style="background:${p.color}"></span>` +
      `<span class="pname">${p.bot ? '🤖 ' : ''}${esc(p.name)}</span>${laurels}<span class="scrolls">${scrolls}</span>` +
      (you === room.host && p.pid !== you ? `<button class="kick" data-pid="${p.pid}">✕</button>` : '');
    el.appendChild(div);
  }
  el.querySelectorAll('.kick').forEach((b) => {
    b.onclick = () => send({ type: 'kick', pid: b.dataset.pid });
  });
}

function renderTurnBanner() {
  const p = room.players.find((x) => x.pid === room.turn);
  const el = $('turnBanner');
  if (!p || room.phase === 'finished') { el.textContent = ''; return; }
  const mine = room.turn === you;
  el.innerHTML = mine ? '<strong>Your turn, captain</strong>' : `${esc(p.name)}'s turn`;
  el.style.borderColor = p.color;
}

function renderTray() {
  const tray = $('tray');
  tray.innerHTML = '';
  const mine = room.turn === you;
  const cfg = room.config;

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
    hint(`🏛️ <strong>${esc(w?.name || '?')}</strong> rules the Aegean!`);
    if (you === room.host) btn('REMATCH', 'gold', () => send({ type: 'rematch' }));
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
    const [d1, d2] = room.dice;
    hint(`You rolled <strong>${d1}</strong> & <strong>${d2}</strong> — sail up to <strong>${Math.max(d1, d2)}</strong> lanes. Tap a glowing isle.`);
  } else if (room.phase === 'island') {
    const acts = room.actions || [];
    const me = room.players.find((p) => p.pid === you);
    const node = me.node;
    const isLib = acts.some((a) => a.startsWith('wager'));
    if (isLib) {
      const dom = room.library_domains[node];
      hint(`The library studies <strong style="color:${DOMAIN_COLORS[dom]}">${room.board.domains[dom].field}</strong>. Wager your wits:`);
      btn(`Tier I<small>+1 scroll</small>`, 'tier', () => send({ type: 'wager', tier: 1 }));
      btn(`Tier II<small>+2 scrolls</small>`, 'tier', () => send({ type: 'wager', tier: 2 }));
      btn(`Tier III<small>+3 / lose 1</small>`, 'tier hot', () => send({ type: 'wager', tier: 3 }));
      if (acts.includes('trial')) {
        btn(`⚜ TRIAL<small>${cfg.trial_cost} scrolls → laurel</small>`, 'gold', () => send({ type: 'trial' }));
      }
    }
    if (acts.includes('oracle')) {
      hint('The Pythia will speak — for a price.');
      btn(`CONSULT<small>pay 1 scroll · answer → take ${cfg.oracle_reward}</small>`, 'oracle', () => send({ type: 'oracle' }));
    }
    if (acts.includes('trade')) {
      hint('The merchants trade 3 scrolls for 1.');
      const row = document.createElement('div');
      row.className = 'tradeRow';
      const give = domainSelect('give');
      const get = domainSelect('get');
      const go = document.createElement('button');
      go.className = 'act';
      go.textContent = 'TRADE 3→1';
      go.onclick = () => send({ type: 'trade', give: give.value, get: get.value });
      row.append(give, document.createTextNode('→'), get, go);
      tray.appendChild(row);
    }
    if (acts.includes('academy')) {
      btn(`🏛 ACADEMY<small>${cfg.academy_cost} scrolls · earn tuition</small>`, 'build', () => send({ type: 'build', kind: 'academy' }));
    }
    if (acts.includes('harbor')) {
      btn(`⚓ HARBOR<small>${cfg.harbor_cost} scrolls · new home port</small>`, 'build', () => send({ type: 'build', kind: 'harbor' }));
    }
    btn('pass', 'ghost', () => send({ type: 'pass' }));
  }
}

function domainSelect(name) {
  const sel = document.createElement('select');
  sel.name = name;
  for (const d of DOMAIN_ORDER) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = room.board.domains[d].name;
    sel.appendChild(o);
  }
  return sel;
}

/* ── question card ───────────────────────────────────────────────────────── */
let timerRAF = null;

function renderQuestion() {
  const modal = $('qmodal');
  const isQ = room.phase === 'question' || room.phase === 'reveal';
  modal.classList.toggle('hidden', !isQ);
  if (!isQ) { cancelAnimationFrame(timerRAF); return; }

  const q = room.question;
  const rv = room.reveal;
  const ctxDomain = q?.domain ?? rv?.domain;
  const ctxKind = q?.kind ?? rv?.kind;
  const dcolor = DOMAIN_COLORS[ctxDomain] || '#888';
  const dinfo = room.board.domains[ctxDomain];

  $('qhead').style.background = dcolor;
  $('qkind').textContent = ctxKind === 'wager'
    ? `Wager · Tier ${TIER_ROMAN[q?.tier] || ''}` : (KIND_LABEL[ctxKind] || '');
  $('qdomain').textContent = dinfo ? `${dinfo.name} · ${dinfo.field}` : '';

  if (!q && !rv) {
    $('qtext').textContent = 'A herald fetches the question…';
    $('qopts').innerHTML = '';
    $('qnote').textContent = '';
    return;
  }

  const mine = room.turn === you;
  if (room.phase === 'question') {
    $('qtext').textContent = q.text;
    $('qnote').textContent = mine ? '' :
      `${esc(room.players.find((p) => p.pid === room.turn)?.name || '')} is answering…`;
    const opts = $('qopts');
    opts.innerHTML = '';
    q.options.forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'opt';
      b.textContent = opt;
      b.disabled = !mine;
      b.onclick = () => { send({ type: 'answer', idx: i }); };
      opts.appendChild(b);
    });
    startTimerBar(q.deadline);
  } else {                                    // reveal
    cancelAnimationFrame(timerRAF);
    $('qtimerBar').style.width = '0%';
    const opts = $('qopts');
    [...opts.children].forEach((b, i) => {
      b.disabled = true;
      if (i === rv.correct) b.classList.add('good');
      else if (i === rv.chosen) b.classList.add('bad');
    });
    let note = rv.was_correct ? '✓ Correct!' : (rv.chosen === -1 ? '⏳ Time expired.' : '✗ Wrong.');
    if (rv.note) note += ' ' + rv.note;
    const gained = Object.entries(rv.gained || {});
    if (gained.length) {
      note += ' ' + gained.map(([d, n]) => `+${n} ${room.board.domains[d].name}`).join(', ');
    }
    $('qnote').textContent = note;
  }
}

function startTimerBar(deadline) {
  cancelAnimationFrame(timerRAF);
  if (!deadline) { $('qtimerBar').style.width = '100%'; return; }
  const total = deadline - Date.now() / 1000;
  const tick = () => {
    const left = deadline - Date.now() / 1000;
    const pct = Math.max(0, Math.min(1, left / total));
    $('qtimerBar').style.width = (pct * 100) + '%';
    $('qtimerBar').style.background = pct < 0.25 ? '#e4572e' : '';
    if (pct > 0 && room.phase === 'question') timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

/* ── modal: symposium vote · oracle claim ───────────────────────────────── */
let claimPick = [];

function renderModal() {
  const modal = $('modal');
  const body = $('modalBody');
  const show = (html) => { modal.classList.remove('hidden'); body.innerHTML = html; };

  if (room.phase === 'symposium_vote') {
    const challenger = room.players.find((p) => p.pid === room.turn);
    if (you !== room.turn && room.players.some((p) => p.pid === you)) {
      show(`<h2>⚖ The Symposium</h2>
        <p><strong>${esc(challenger?.name)}</strong> stands before the gods of Delos.
        Choose the domain of their final question:</p><div class="domBtns"></div>
        <p class="tag">${room.votes_in} vote(s) cast</p>`);
      const btns = body.querySelector('.domBtns');
      for (const d of DOMAIN_ORDER) {
        const b = document.createElement('button');
        b.className = 'act';
        b.style.background = DOMAIN_COLORS[d];
        b.textContent = room.board.domains[d].field;
        b.onclick = () => send({ type: 'vote', domain: d });
        btns.appendChild(b);
      }
    } else {
      show(`<h2>⚖ The Symposium</h2><p>Your rivals choose your final domain…</p>
        <p class="tag">${room.votes_in} vote(s) cast</p>`);
    }
    return;
  }

  if (room.phase === 'oracle_claim' && room.oracle_claim_due === you) {
    show(`<h2>🔮 The Oracle's Boon</h2>
      <p>Choose ${room.config.oracle_reward} scrolls (tap domains, repeats allowed):</p>
      <div class="domBtns"></div><p id="claimList" class="tag"></p>
      <button id="claimGo" class="big" disabled>CLAIM</button>`);
    const btns = body.querySelector('.domBtns');
    for (const d of DOMAIN_ORDER) {
      const b = document.createElement('button');
      b.className = 'act';
      b.style.background = DOMAIN_COLORS[d];
      b.textContent = room.board.domains[d].name;
      b.onclick = () => {
        claimPick.push(d);
        claimPick = claimPick.slice(-room.config.oracle_reward);
        $('claimList').textContent = claimPick.map((x) => room.board.domains[x].name).join(' · ');
        $('claimGo').disabled = claimPick.length !== room.config.oracle_reward;
      };
      btns.appendChild(b);
    }
    $('claimGo').onclick = () => {
      send({ type: 'claim', domains: claimPick });
      claimPick = [];
    };
    return;
  }
  if (room.phase === 'oracle_claim') {
    const p = room.players.find((x) => x.pid === room.oracle_claim_due);
    show(`<h2>🔮 The Oracle's Boon</h2><p>${esc(p?.name)} claims their reward…</p>`);
    return;
  }

  if (room.phase === 'finished') {
    const w = room.players.find((p) => p.pid === room.winner);
    show(`<h2>🏛️ Victory</h2>
      <p><strong style="color:${w?.color}">${esc(w?.name || '?')}</strong> has triumphed at the
      Symposium of Delos and rules the Aegean.</p>
      ${you === room.host ? '<button id="rematchGo" class="big">REMATCH</button>' : '<p class="tag">the host may call a rematch</p>'}`);
    const rg = $('rematchGo');
    if (rg) rg.onclick = () => send({ type: 'rematch' });
    return;
  }

  modal.classList.add('hidden');
}

/* ── dice ────────────────────────────────────────────────────────────────── */
const PIP_ROT = {
  1: 'rotateX(0deg) rotateY(0deg)', 2: 'rotateX(-90deg) rotateY(0deg)',
  3: 'rotateY(-90deg)', 4: 'rotateY(90deg)',
  5: 'rotateX(90deg)', 6: 'rotateX(180deg)',
};
let diceTimeout = null;

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

function animateDice(d1, d2) {
  const box = $('dice');
  box.classList.remove('hidden');
  [['die1', d1], ['die2', d2]].forEach(([id, val], i) => {
    const cube = $(id).querySelector('.cube');
    buildCube(cube);
    cube.style.transition = 'none';
    cube.style.transform = `rotateX(${720 + Math.random() * 360}deg) rotateY(${720 + Math.random() * 360}deg)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cube.style.transition = `transform ${0.9 + i * 0.18}s cubic-bezier(.2,.7,.3,1.05)`;
      cube.style.transform = PIP_ROT[val];
    }));
  });
  clearTimeout(diceTimeout);
  diceTimeout = setTimeout(() => box.classList.add('hidden'), 4200);
}

/* ── toasts & log ────────────────────────────────────────────────────────── */
function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
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
