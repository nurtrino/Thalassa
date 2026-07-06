/*
 * app.js — Thalassa client logic (Agent E).
 *
 * Owns everything DOM: net layer, lobby, HUD, tray, compass, shop, battle
 * screen, question scroll, the five minigames, modals, dice, toasts, log.
 * The 3D sea lives in scene.js; icons/escaping live in ui.js.
 *
 * Contract notes:
 * - createWorld(container, {onNodeClick, onStageChange}) — sail clicks are
 *   gated here (phase/turn/reachable); onStageChange drives the realm banner
 *   and the document accent (--accent + data-realm on <html>).
 * - Targeting an enemy is a DOM affair (.ecard.targetable); the 3D pulse
 *   ring rides along via world.battlePlay('targeted', {idx}) which scene.js
 *   forwards to the battle stage's setTargeted.
 * - Battle beats keep the legacy 900/1500/2200/2600ms feel; every pending
 *   beat timer is cancelled when a new reveal/phase arrives.
 */
import { createWorld } from './scene.js';
import { DOMAIN_COLORS, REALM_INFO } from './themes.js';
import { audio } from './audio.js';
import { esc, stripEmoji, icon, glyphSVG } from './ui.js';

const $ = (id) => document.getElementById(id);

const KIND_LABEL = {
  shrine: 'Shrine Wager', battle: 'Battle', puzzle: 'Riddle of the Isle',
  riddle: 'Riddle of the Isle',
};
const MG_LABEL = {
  tetromino: 'Sigil of the Isle', nonogram: 'The Weaver’s Grid',
  simon: 'Echoes of the Muses', anagram: 'The Scattered Letters',
  ravens: 'The Pattern of Fate', riddle: 'Riddle of the Isle',
  sequence: 'The Fates’ Thread', lights_out: 'The Gorgon’s Gaze',
  sliding: 'The Shifting Mosaic', memory: 'The Muses’ Whisper',
  visual_memory: 'The Mnemosyne Board',
};
const MG_PROMPT = {
  tetromino: 'Drag each piece onto the grid. No rotating — they fit as given.',
  nonogram: 'Match every row and column to its clue numbers. Bronze cells are given.',
  simon: 'Watch the sequence, then repeat it. One wrong note fails it.',
  anagram: 'Unscramble the word.',
  ravens: 'Find the pattern. Pick the missing tile.',
  riddle: 'Read the riddle and type your answer.',
  sequence: 'Read the thread and type the next number.',
  lights_out: 'Tap to toggle a stone and its neighbours. Darken them all.',
  sliding: 'Slide the tiles into order, 1 to 8, blank last.',
  memory: 'Watch the four, then echo them back. One wrong note fails it.',
  visual_memory: 'Memorise the lit tiles, then click them all back. Three misses and it fails.',
};
const TIER_ROMAN = { 1: 'I', 2: 'II', 3: 'III' };
const UP_ICON = {
  ram: 'strike', hull_plates: 'hull', star_chart: 'compass', sandals: 'flee',
  owl: 'owl', lyre: 'lyre', trident: 'magic', aegis: 'aegis',
  golden_fleece: 'laurel', poseidon_favor: 'anchor',
  titan_ram: 'strike', oracle_eye: 'owl',
};
const ITEM_ORDER = ['planks', 'gale', 'horn', 'hint', 'aegis_charm'];
const SHOP_ICON = {
  fitting: 'fitting', hint: 'hint', gale: 'gale', planks: 'planks',
  aegis_charm: 'aegis', horn: 'horn',
  golden_fleece: 'laurel', poseidon_favor: 'anchor',
  titan_ram: 'strike', oracle_eye: 'owl',
};

/* ── state ──────────────────────────────────────────────────────────────── */
let ws = null;
let you = null;
let room = null;
let lastFlashSeq = 0;
let world = null;
let joined = false;             // the player pressed JOIN at least once
let reconnectN = 0;
let lastHeard = 0;        // last time ANYTHING arrived on the socket
let reconnectTimer = null;
let pingInterval = null;

let token = localStorage.getItem('thalassa_token');
if (!token) {
  token = crypto.randomUUID();
  localStorage.setItem('thalassa_token', token);
}

/* transient UI state (reset on reconnect) */
let pendingMove = null;          // 'attack'|'magic'|'guard' while picking a target
let pendingHeal = false;         // true while the HEAL spell picks its lore/domain
let myStance = null;             // last stance I sent (labels the reveal beat)
let mySideAnswer = null;
let sideKey = null;
let shopClosed = false;
let shopRemote = false;   // the ship's trader, called up before a roll
let mg = { key: null };          // minigame scratch
let beatTimers = [];
let revealCardDropped = false;   // battle reveal card auto-hides mid-beats
let timerRAF = null;
let dieTimeout = null;
let lastLogSig = '';
let lastBattleSnap = null;       // survives the killing-blow reveal
// persisted: seasoned captains don't get the rules card again (survives
// reloads and reconnects; a fresh browser sees it once)
let introDismissed = localStorage.getItem('thalassa_intro') === '1';

function resetTransient() {
  clearBeats();
  cancelAnimationFrame(timerRAF);
  pendingMove = null;
  pendingHeal = false;
  mySideAnswer = null;
  sideKey = null;
  mg = { key: null };
  shopClosed = false;
}

/* ── boot ───────────────────────────────────────────────────────────────── */
let devUnlocked = false;
world = createWorld($('world'), {
  onNodeClick(nodeId, walkArrow) {
    if (devUnlocked) { devTeleport(nodeId, false); return; }   // dev: click to jump
    if (!room || room.phase !== 'sail' || room.turn !== you) return;
    const trails = room.walk?.options || [];
    // a golden Vale arrow (or a ground tap resolved to a branch): walk it —
    // the roll glides down that trail, pausing at the next fork
    if (walkArrow && trails.includes(nodeId)) {
      audio.sfx.sail();
      send({ type: 'walk', node: nodeId });
      return;
    }
    if (nodeId in (room.reachable || {})) {
      audio.sfx.sail();
      send({ type: 'sail', node: nodeId });
      return;
    }
    // tapping a branch's first STOP (its stone, its clearing) also takes it —
    // people tap where they want to go, not only the skinny arrows
    if (trails.includes(nodeId)) {
      audio.sfx.sail();
      send({ type: 'walk', node: nodeId });
    }
  },
  onStageChange(stageId) {
    applyStage(stageId);
  },
  onTourCaption(cap) {
    renderTourCaption(cap);
  },
  onLoadStart(total) {
    // the loading beat is the first frame of the cinematic — clear the desk
    introDismissed = true;
    localStorage.setItem('thalassa_intro', '1');
    $('modal').classList.add('hidden');
    renderLoading(0, total);
  },
  onLoadProgress(done, total) {
    renderLoading(done, total);
  },
  onLoadDone() {
    const ov = document.getElementById('loadOv');
    if (ov) {
      ov.classList.add('lgone');
      setTimeout(() => ov.remove(), 600);
    }
  },
  onTourState(active) {
    document.body.classList.toggle('touring', !!active);
    if (active) {
      // the tour IS the rules briefing — no wall-of-text modal needed
      introDismissed = true;
      localStorage.setItem('thalassa_intro', '1');
      $('modal').classList.add('hidden');
    } else if (room) render();
  },
  onArrive() {
    // the boat has reached its island — now reveal whatever waits there,
    // and fire the audio reaction we held back while it was still sailing
    if (room) render();
    if (audioDeferred && room && !world.arriving()) {
      audioDeferred = false;
      reactAudio(null, room);
    }
  },
});

/* ── dev teleport panel — double-tap the T in THALASSA, enter code 783 ─────
 * Unlocks a floating bar to jump between regions, and turns every node click
 * into a teleport (server accepts the dev message when the 783 code rides
 * along). Meant for the game's owner to hop around while testing. */
const DEV_REGIONS = [
  ['hub', 'Isles of Peace'], ['ice', 'Frostfang Reach'],
  ['desert', 'Bleached Reach'], ['jungle', 'Verdigris Deep'],
  ['autumn', 'Amber Vale'], ['pharos', 'The Pharos'],
];
function devRegionNode(region) {
  const nodes = room?.board?.nodes || [];
  const pick = (pred) => nodes.find(pred)?.id;
  if (region === 'hub') return pick((n) => n.type === 'home') || pick((n) => !n.region);
  if (region === 'pharos') return pick((n) => n.type === 'pharos');
  for (const t of ['haven', 'shrine', 'home', 'sea', 'gate']) {
    const id = pick((n) => n.region === region && n.type === t);
    if (id) return id;
  }
  return pick((n) => n.region === region);
}
function devSend(extra) {
  if (!ws || ws.readyState !== 1) return;
  send(Object.assign({ type: 'dev', code: '783' }, extra));
}
function devTeleport(node, land, region) {
  if (!ws || ws.readyState !== 1) return;
  // a region without a node lets the server pick the landing spot (the dev
  // bar jumps by REGION; a clicked stop still passes its node directly)
  if (!node && !region) return;
  send({ type: 'dev', node: node || '', land: !!land, region: region || '', code: '783' });
}
let devAutoWalk = true;      // gate carry-through; dev can freeze it to stay put
function devMkBtn(label, onclick) {
  const b = document.createElement('button');
  b.className = 'dev-btn';
  b.textContent = label;
  b.onclick = onclick;
  return b;
}
function buildDevBar() {
  if (document.getElementById('devBar')) { document.getElementById('devBar').remove(); return; }
  const bar = document.createElement('div');
  bar.id = 'devBar';
  bar.innerHTML = '<div class="dev-title">DEV · teleport</div>';
  for (const [reg, label] of DEV_REGIONS) {
    bar.appendChild(devMkBtn(label, () => devTeleport(devRegionNode(reg), false, reg)));
  }
  const hint = document.createElement('div');
  hint.className = 'dev-hint';
  hint.textContent = 'Click any stop, or open the chart (M) and click an isle, to jump there.';
  bar.appendChild(hint);

  // ── dev powers ─────────────────────────────────────────────────────────
  const title = document.createElement('div');
  title.className = 'dev-title';
  title.textContent = 'DEV · powers';
  bar.appendChild(title);

  const walkBtn = devMkBtn('', null);
  const paintWalk = () => {
    walkBtn.textContent = 'auto-walk: ' + (devAutoWalk ? 'ON' : 'OFF');
    walkBtn.classList.toggle('dev-off', !devAutoWalk);
  };
  walkBtn.onclick = () => { devAutoWalk = !devAutoWalk; devSend({ autowalk: devAutoWalk }); paintWalk(); };
  paintWalk();
  bar.appendChild(walkBtn);

  bar.appendChild(devMkBtn('simulate fight…', () => toggleDevFightMenu(bar)));
  bar.appendChild(devMkBtn('give all relics + seals', () => devSend({ relics: true })));
  bar.appendChild(devMkBtn('unlock sword quest', () => devSend({ sword: true })));
  bar.appendChild(devMkBtn('exit dev mode', () => lockDev()));

  document.body.appendChild(bar);
}
function toggleDevFightMenu(bar) {
  const open = document.getElementById('devFightMenu');
  if (open) { open.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'devFightMenu';
  const add = (label, spec) => menu.appendChild(devMkBtn(label, () => {
    devSend({ fight: spec });
    menu.remove();
  }));
  const best = room?.config?.dev_bestiary;
  const depths = ['shallow', 'mid', 'deep'];
  if (best) {
    add('⚔ Warden · ' + best.warden, { kind: 'boss', region: 'warden' });
    for (const [reg, info] of Object.entries(best.regions || {})) {
      add('👑 ' + info.boss, { kind: 'boss', region: reg });
      (info.tiers || []).forEach((names, ti) =>
        names.forEach((nm, ri) =>
          add(`· ${nm} (${depths[ti] || ti})`, { kind: 'pack', region: reg, tier: ti, row: ri })));
    }
  }
  add('· Sea rabble (light)', { kind: 'pack', region: '', tier: 0 });
  add('· Sea rabble (heavy)', { kind: 'pack', region: '', tier: 1 });
  bar.appendChild(menu);
}
function unlockDev() {
  devUnlocked = true;
  document.body.classList.add('dev');
  buildDevBar();
}
function lockDev() {
  // fully back to a normal player: no teleport-on-click, no bar, and the
  // server-side dev toggles (frozen auto-walk, forced battle deck) are cleared
  // — exactly as if dev mode had never been turned on.
  devUnlocked = false;
  devAutoWalk = true;
  document.body.classList.remove('dev');
  document.getElementById('devFightMenu')?.remove();
  document.getElementById('devBar')?.remove();
  devSend({ reset: true });
  if (room) render();
}
(function devUnlockInit() {
  // triple-click the "You" chip in the turn banner, then enter the code
  const bar = document.getElementById('turnBanner');
  if (bar) {
    let clicks = 0, timer = null;
    bar.addEventListener('click', (e) => {
      if (!e.target.closest('.tocap.me')) return;      // only the local player's chip
      clicks += 1;
      clearTimeout(timer);
      timer = setTimeout(() => { clicks = 0; }, 1600);
      if (clicks >= 3) {
        clicks = 0;
        // the code is a TOGGLE: enter it locked → unlock; enter it unlocked →
        // exit dev entirely (back to a plain player, as if never turned on)
        if (prompt(devUnlocked ? 'Dev code (to exit):' : 'Dev code:') === '783') {
          devUnlocked ? lockDev() : unlockDev();
        }
      }
    });
  }
  // once unlocked: open the aerial chart (M) and click any island to jump to it
  const mapBox = document.getElementById('mapIcons');
  if (mapBox) {
    mapBox.addEventListener('click', (e) => {
      if (!devUnlocked) return;
      const chip = e.target.closest('.mapchip');
      if (!chip || !chip.dataset.key) return;
      devTeleport(chip.dataset.key, false);
      toggleMap(false);
    });
  }
})();

$('nameInput').value = localStorage.getItem('thalassa_name') || '';

const muteBtn = $('muteBtn');
function paintMute() {
  muteBtn.classList.toggle('off', audio.isMuted());
  muteBtn.title = audio.isMuted() ? 'Sound is off' : 'Sound is on';
}
paintMute();
muteBtn.onclick = () => { audio.init(); audio.toggleMuted(); paintMute(); };

/* first interaction of any kind wakes the audio context AND the menu music */
document.addEventListener('pointerdown', (e) => {
  audio.init();
  audio.startMusic();
  if (e.target.closest('.act, .opt, .big, .small, .buy, .battlebtn, .itemslot, .mgcell, .mgpad, .glyphopt, .upcard'))
    audio.sfx.click();
}, { passive: true });
document.addEventListener('keydown', () => { audio.init(); audio.startMusic(); }, { passive: true });

$('joinBtn').onclick = () => { audio.init(); audio.startMusic(); audio.sfx.join(); joined = true; connect(); };
$('resetBtn').onclick = () => {
  if (!confirm('Reset the table? This ends any game in progress and returns everyone to a fresh, empty lobby.')) return;
  fetch('/reset', { method: 'POST' }).finally(() => location.reload());
};
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
$('startBtn').onclick = () => send({ type: 'start' });
$('addBotBtn').onclick = () => send({ type: 'add_bot' });
$('mapBtn').onclick = () => toggleMap(true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && world.tourActive?.()) world.endTour();
  else if (e.key === 'Escape' && document.getElementById('valeChart')) {
    document.getElementById('valeChart').remove();   // the '?' card obeys Esc too
  } else if (e.key === 'Escape' && mapOpen) toggleMap(false);
  else if ((e.key === 'm' || e.key === 'M') && room && room.phase !== 'lobby'
           && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) toggleMap();
});

/* ── net layer ──────────────────────────────────────────────────────────── */
function connect() {
  clearTimeout(reconnectTimer);
  const name = $('nameInput').value.trim() || 'Captain';
  localStorage.setItem('thalassa_name', name);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws?.close(); } catch (e) { /* stale socket */ }
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectN = 0;
    setConnVeil(false);
    send({ type: 'hello', token, name });
  };
  lastHeard = Date.now();
  ws.onmessage = (ev) => { lastHeard = Date.now(); handle(JSON.parse(ev.data)); };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { /* onclose follows */ };
  clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (ws?.readyState !== 1) return;
    // a HALF-DEAD socket (phone lock, network hop) never fires onclose: the
    // board freezes live-looking — "A herald fetches…" forever. Ping often,
    // and if NOTHING has come back for 30s, kill the socket ourselves so the
    // reconnect path takes over and pulls a fresh snapshot.
    if (Date.now() - lastHeard > 30000) {
      try { ws.close(); } catch (e) { /* reconnect follows */ }
      scheduleReconnect();
      return;
    }
    send({ type: 'ping' });
  }, 10000);
}

/* waking the tab (phone unlock, app switch-back) checks the line at once —
   never sit on a frozen board waiting for the next ping cycle */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !joined) return;
  if (!ws || ws.readyState > 1) connect();
  else if (ws.readyState === 1) send({ type: 'ping' });
});

function scheduleReconnect() {
  if (!joined) return;
  if (room && room.phase === 'finished') return;
  const delay = Math.min(15000, 900 * Math.pow(2, reconnectN++));
  if (reconnectN === 1) toast('Connection lost — reconnecting…', true);
  setConnVeil(true);        // the board must not look alive while taps go nowhere
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    resetTransient();       // stale timers/targets must not survive the gap
    connect();
  }, delay);
}

/* a persistent veil while the socket is down: one transient toast wasn't
   enough — during a long outage the board looked live and taps died silently */
let connVeilEl = null;
function setConnVeil(on) {
  if (!on) { connVeilEl?.remove(); connVeilEl = null; return; }
  if (connVeilEl) return;
  const d = document.createElement('div');
  connVeilEl = d;
  d.id = 'connVeil';
  d.innerHTML = '<div class="plaque" style="padding:12px 22px">' +
    'Connection lost — reconnecting…</div>';
  document.body.appendChild(d);
}

function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }
window.__send = send;                 // debug/testing handles
window.__room = null;
window.__you = null;
window.__world = world;               // scene api: arriving()/animating()/currentStage()
window.__beginSphinxAmbush = () => beginSphinxAmbush();   // QA: replay her intro
window.__audio = audio;               // music scene lives on audio._scene
window.__pharosCine = () => playPharosCutscene();   // preview the seal cutscene
window.__winPreview = () => {                        // preview the victory sequence
  room = {
    phase: 'finished', winner: 'W',
    upgrade_info: room?.upgrade_info || {},
    config: room?.config || { shop_items: {}, relics_to_win: 3 },
    players: [
      { pid: 'W', name: 'Achilles', color: '#e8c27a', banked: 3, cargo: 0, scrolls: 12,
        hull: 5, max_hull: 6, upgrades: ['hull_plates', 'aegis'], items: { planks: 2, horn: 1 } },
      { pid: 'B', name: 'Odysseus', color: '#6cc6ff', banked: 2, cargo: 1, scrolls: 9,
        hull: 6, max_hull: 6, upgrades: ['sandals'], items: {}, bot: true },
      { pid: 'C', name: 'Ajax', color: '#9be07a', banked: 1, cargo: 0, scrolls: 20,
        hull: 3, max_hull: 6, upgrades: [], items: { gale: 1 } },
    ],
  };
  you = 'C';
  victoryShown = false;
  renderVictory();
};

function handle(msg) {
  if (msg.type === 'snapshot') {
    const prev = room;
    you = msg.you;
    room = msg.room;
    window.__room = room;
    window.__you = you;
    // entering a battle reveal: freeze BOTH sides' shown HP at the pre-blow
    // values (the server snapshot is already post-hit) — the beats release
    // each side exactly when its blow lands on screen
    if (room.phase === 'reveal' && prev?.phase !== 'reveal' && room.reveal?.kind === 'battle') {
      bPreReveal = prev?.battle ? JSON.parse(JSON.stringify(prev.battle)) : null;
      bEnemyFrozen = !!bPreReveal;
      const pf = prev?.players?.find((q) => q.pid === prev.turn);
      bHullShown = pf ? pf.hull : null;
    }
    render();
    reactAudio(prev, room);
    if (room.flash && room.flash.seq !== lastFlashSeq) {
      lastFlashSeq = room.flash.seq;
      showVerdictBanner(room.flash.ok, room.flash.text);
    }
  } else if (msg.type === 'dice') {
    audio.sfx.dice();
    animateDie(msg.value);
  } else if (msg.type === 'error') {
    if (!room || room.phase === 'lobby') $('lobbyErr').textContent = msg.msg;
    toast(msg.msg, true);
  }
}

/* ── stage accent + realm banner ────────────────────────────────────────── */
let lastStage = null;
// realms with their own overworld soundtrack (static/music/<realm>.mp3); the
// open-sea scene plays the current realm's theme, falling back to game.mp3.
const REALM_MUSIC = new Set(['hub', 'ice', 'desert', 'jungle', 'autumn']);
let curRealm = 'hub';

/* Overworld tracks (static/music/<realm>.mp3). Realms with a SECOND
   uploaded theme rotate it per visit — the long-lost option tracks were
   recovered from the release branch: desert2 ("deser music option
   backround") and hub2 ("backround option 2"). First visit plays the
   base theme; each re-entry flips. audio.setScene's base-name fallback
   (desert2 → desert) keeps a missing file harmless. */
const MUSIC_ALTS = { desert: 2, hub: 2 };
let musicWhere = null;      // which realm's theme is playing (visit edge)
const musicPick = {};       // realm → variant index for the current visit
function realmMusic(realm) {
  if (musicWhere !== realm) {
    musicWhere = realm;
    if (MUSIC_ALTS[realm]) {
      musicPick[realm] = musicPick[realm] === undefined
        ? 0 : (musicPick[realm] + 1) % MUSIC_ALTS[realm];
    }
  }
  const k = musicPick[realm] || 0;
  return k ? `${realm}${k + 1}` : realm;
}

function applyStage(stageId) {
  const realm = stageId === 'battle' ? (room?.battle?.region || 'hub') : stageId;
  curRealm = realm;
  const info = REALM_INFO[realm] || REALM_INFO.hub;
  document.documentElement.style.setProperty('--accent', info.accent);
  document.documentElement.dataset.realm = realm;
  if (stageId !== 'battle' && room && room.phase !== 'lobby' && lastStage !== stageId
      && !world.tourActive?.()) {          // the tour carries its own captions
    showRealmBanner(info);
    if (stageId !== 'hub') audio.sfx.oracle();
  }
  if (stageId !== 'battle') lastStage = stageId;
  // switch the overworld track the instant a realm's stage engages, so the music
  // matches where you actually are through the gate (not a snapshot later)
  if (stageId !== 'battle' && room && REALM_MUSIC.has(realm)
      && !['question', 'minigame', 'reveal', 'upgrade_pick', 'lobby'].includes(room.phase)) {
    // the opening fly-over cycles every stage — play base themes under it
    // and don't let it burn 'visits', so your first real landfall opens on
    // each realm's primary track
    audio.setScene(world.tourActive?.() ? realm : realmMusic(realm));
  }
  renderMapBtn();
}

let bannerEl = null;
function showRealmBanner(info) {
  bannerEl?.remove();
  const d = document.createElement('div');
  bannerEl = d;
  d.style.cssText =
    'position:fixed;left:50%;top:26%;transform:translateX(-50%);z-index:18;' +
    'pointer-events:none;text-align:center;opacity:0;' +
    // a translucent dark scrim so the accent stays readable on ANY stage —
    // gold on sand and ice-blue on sun glare both failed without it
    'padding:10px 26px;border-radius:12px;background:rgba(6,10,16,.42);' +
    '-webkit-backdrop-filter:blur(2.5px);backdrop-filter:blur(2.5px)';
  d.innerHTML =
    `<div style="font-family:var(--disp,serif);font-weight:800;font-size:clamp(22px,4.6vw,42px);` +
    `letter-spacing:.24em;text-transform:uppercase;color:${info.accent};` +
    `text-shadow:0 2px 14px rgba(3,6,10,.95),0 0 34px ${info.accent}55;white-space:nowrap">${esc(info.name)}</div>` +
    `<div style="margin:6px auto 0;width:180px;height:1px;` +
    `background:linear-gradient(90deg,transparent,${info.accent},transparent)"></div>`;
  document.body.appendChild(d);
  d.animate(
    [{ opacity: 0, transform: 'translateX(-50%) translateY(14px)' },
     { opacity: 1, transform: 'translateX(-50%) translateY(0)', offset: 0.18 },
     { opacity: 1, transform: 'translateX(-50%) translateY(0)', offset: 0.78 },
     { opacity: 0, transform: 'translateX(-50%) translateY(-10px)' }],
    { duration: 3400, easing: 'ease-out' },
  ).onfinish = () => { d.remove(); if (bannerEl === d) bannerEl = null; };
}

/* a punchy centre-screen callout — used to announce a fight the moment it
   begins (ambush, boss trial, the final confrontation). Separate element from
   the realm banner so the two can never clobber each other. */
let announceEl = null;
function showAnnounce(title, sub, color, dur = 2600) {
  announceEl?.remove();
  const d = document.createElement('div');
  announceEl = d;
  d.style.cssText =
    'position:fixed;left:50%;top:32%;transform:translateX(-50%);z-index:19;' +
    'pointer-events:none;text-align:center;opacity:0';
  d.innerHTML =
    `<div style="font-family:var(--disp,serif);font-weight:800;font-size:clamp(26px,6vw,58px);` +
    `letter-spacing:.16em;text-transform:uppercase;color:${color};` +
    `text-shadow:0 3px 18px rgba(3,6,10,.95),0 0 40px ${color}66;white-space:nowrap">${esc(title)}</div>` +
    (sub ? `<div style="margin:8px auto 0;font-family:var(--disp,serif);font-weight:700;` +
      `font-size:clamp(13px,2.4vw,19px);letter-spacing:.14em;text-transform:uppercase;` +
      `color:#e7eef5;text-shadow:0 2px 10px rgba(3,6,10,.9)">${esc(sub)}</div>` : '');
  document.body.appendChild(d);
  d.animate(
    [{ opacity: 0, transform: 'translateX(-50%) scale(1.22)' },
     { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.16 },
     { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.74 },
     { opacity: 0, transform: 'translateX(-50%) scale(1.04) translateY(-8px)' }],
    { duration: dur, easing: 'cubic-bezier(.2,.9,.2,1)' },
  ).onfinish = () => { d.remove(); if (announceEl === d) announceEl = null; };
}

/* ── the Sphinx's ambush: a staged intro before her riddle ────────────────
   She springs from the dunes ("THE SPHINX AMBUSHES YOU"), then the diorama
   holds on her — no controls — while she poses her terms, and only THEN does
   the riddle scroll unfurl. Purely a client-side beat; the server already has
   the riddle live the instant we land. */
let sphinxIntro = false;
let sphinxLine = '';
let sphinxSpeakEl = null;
const sphinxTimers = [];
function clearSphinxTimers() {
  while (sphinxTimers.length) clearTimeout(sphinxTimers.pop());
}
function showSphinxSpeak(text) {
  hideSphinxSpeak();
  const d = document.createElement('div');
  sphinxSpeakEl = d;
  d.className = 'sphinxspeak';
  d.innerHTML =
    `<div class="ssname">${icon('crown', 15)} The Sphinx</div>` +
    `<div class="ssline">${esc(text)}</div>`;
  document.body.appendChild(d);
  requestAnimationFrame(() => d.classList.add('in'));
}
function hideSphinxSpeak() {
  sphinxSpeakEl?.remove();
  sphinxSpeakEl = null;
}
function beginSphinxAmbush() {
  clearSphinxTimers();
  sphinxIntro = true;
  sphinxLine = '';
  audio.sfx.oracle();
  // 1) she springs — a brief flash held about half a second
  showAnnounce('THE SPHINX AMBUSHES YOU', '', '#e8c27a', 1000);
  render();                                   // hide the riddle, hold on her
  // 2) …the diorama sits on the Sphinx, then she names her terms
  sphinxTimers.push(setTimeout(() => {
    audio.sfx.oracle?.();
    showSphinxSpeak('Solve my riddle, or face my pride.');
    render();
  }, 1000));
  // 3) …and only now does the riddle scroll unfurl
  sphinxTimers.push(setTimeout(() => {
    sphinxIntro = false;
    hideSphinxSpeak();
    render();
  }, 2900));
}

/* The end of a fight gets its own full-screen beat — a gold VICTORY when the
   last foe falls, a red YOU DIED when your hull gives out — held over the
   diorama while the killing blow settles, then cleared as the scene cuts. */
let battleEndEl = null;
function showBattleEnd(kind, sub) {
  battleEndEl?.remove();
  const win = kind === 'win';
  const color = win ? '#f0c674' : '#e0472f';
  // a LIGHT vignette, not a curtain: the diorama stays fully visible behind
  // the word — the fight's last frame is the backdrop of its own ending
  const inner = win ? 'rgba(20,14,2,.10)' : 'rgba(40,4,4,.24)';
  const outer = win ? 'rgba(4,5,9,.46)' : 'rgba(24,2,2,.60)';
  const d = document.createElement('div');
  battleEndEl = d;
  d.style.cssText =
    'position:fixed;inset:0;z-index:24;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;pointer-events:none;opacity:0;' +
    `background:radial-gradient(ellipse at center, ${inner}, ${outer})`;
  d.innerHTML =
    `<div style="font-family:var(--disp,serif);font-weight:800;` +
    `font-size:clamp(46px,12vw,128px);letter-spacing:.14em;text-transform:uppercase;` +
    `color:${color};text-shadow:0 5px 34px rgba(0,0,0,.92),0 0 52px ${color}55">` +
    (win ? 'Victory' : 'You Died') + '</div>' +
    (sub ? `<div style="margin-top:12px;font-family:var(--disp,serif);font-weight:700;` +
      `font-size:clamp(14px,2.6vw,21px);letter-spacing:.12em;text-transform:uppercase;` +
      `color:#ece4d5;text-shadow:0 2px 12px rgba(0,0,0,.9)">${esc(sub)}</div>` : '');
  document.body.appendChild(d);
  d.animate([{ opacity: 0, transform: 'scale(1.08)' },
             { opacity: 1, transform: 'scale(1)' }],
    { duration: 550, fill: 'forwards', easing: 'ease-out' });
}
function clearBattleEnd() {
  const d = battleEndEl;
  if (!d) return;
  battleEndEl = null;
  d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: 'forwards' })
    .onfinish = () => d.remove();
}

/* The Pharos ceremony — triggered by the ENTER button once you stand at the
   tower door. The captain sets each earned seal into the door (a chime rings
   as it seats), the bronze leaves grind open with a rumble, and darkness pours
   out of the tower; then `onDone` fires and the Dark Presence battle takes
   over. Runs entirely as a 2D overlay — NO 3D door object is placed in scene. */
let pharosCeremonyRunning = false;
function playPharosCeremony(seals, onDone) {
  if (pharosCeremonyRunning) return;
  pharosCeremonyRunning = true;
  document.getElementById('pharosCine')?.remove();
  seals = Math.max(1, Math.min(3, (seals | 0) || 3));
  const slots = Array.from({ length: seals },
    (_, i) => `<span class="pcsig" style="--i:${i}"></span>`).join('');
  const d = document.createElement('div');
  d.id = 'pharosCine';
  const wisps = Array.from({ length: 7 },
    (_, i) => `<span class="pcine-wisp" style="--w:${i}"></span>`).join('');
  d.innerHTML =
    `<div class="pcine-in">` +
      `<div class="pcine-kicker">Set the seals</div>` +
      `<div class="pcine-door"><i class="leaf l"></i><i class="leaf r"></i>` +
        `<span class="pcine-glow"></span><span class="pcine-dark"></span>` +
        `<span class="pcine-wisps">${wisps}</span>` +
        slots +
      `</div>` +
      `<div class="pcine-title">Darkness Spills Forth</div>` +
    `</div>`;
  document.body.appendChild(d);
  const door = d.querySelector('.pcine-door');
  const sigs = d.querySelectorAll('.pcsig');
  // set each seal in turn — a mystical chime rings as it seats into the door
  sigs.forEach((s, i) => setTimeout(() => {
    s.classList.add('lit');
    audio.sfx?.oracle?.();
  }, 500 + i * 650));
  const doorAt = 500 + seals * 650 + 300;
  // the bronze leaves grind open with a rumble and darkness pours out
  setTimeout(() => {
    door.classList.add('open', 'rumble');
    audio.sfx?.roar?.();
  }, doorAt);
  setTimeout(() => d.querySelector('.pcine-title').classList.add('show'), doorAt + 750);
  setTimeout(() => {
    d.classList.add('done');
    setTimeout(() => d.remove(), 900);
    pharosCeremonyRunning = false;
    onDone?.();
  }, doorAt + 2000);
}
function playPharosCutscene() { playPharosCeremony(3, null); }   // preview only

/* ── the opening tour's caption card (bottom center, cinematic) ─────────── */
let tourCapEl = null;
function renderTourCaption(cap) {
  tourCapEl?.remove();
  tourCapEl = null;
  if (!cap) return;
  const d = document.createElement('div');
  tourCapEl = d;
  d.id = 'tourCap';
  d.innerHTML =
    `<div class="tc-title">${esc(cap.title)}</div>` +
    `<div class="tc-body">${esc(cap.body)}</div>` +
    `<div class="tc-skip">tap anywhere to skip</div>`;
  document.body.appendChild(d);
  d.animate(
    [{ opacity: 0, transform: 'translateX(-50%) translateY(14px)' },
     { opacity: 1, transform: 'translateX(-50%) translateY(0)' }],
    { duration: 450, easing: 'ease-out' });
}

/* pre-tour loading beat: a bar that fills while every GLB is fetched, so the
 * grand fly-over never shows islands with props still popping in */
function renderLoading(done, total) {
  let ov = document.getElementById('loadOv');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'loadOv';
    ov.innerHTML =
      '<div class="lwrap">' +
        '<div class="ltitle">Charting the Isles of Peace…</div>' +
        '<div class="lbar"><div class="lfill"></div></div>' +
        '<div class="lcount"></div>' +
      '</div>';
    document.body.appendChild(ov);
  }
  const pct = total ? Math.round((done / total) * 100) : 100;
  ov.querySelector('.lfill').style.width = pct + '%';
  ov.querySelector('.lcount').textContent = `${done} / ${total} treasures aboard`;
}

/* a big centred CORRECT / WRONG banner (the Kraken's riddles announce their
 * verdict this way) — flashes green or red, plays the matching sting, fades */
function showVerdictBanner(ok, text) {
  (ok ? audio.sfx.correct : audio.sfx.wrong)?.();
  const d = document.createElement('div');
  d.className = 'verdictBanner ' + (ok ? 'good' : 'bad');
  if (text && text.length > 14) d.classList.add('long');   // shrink for a full sentence
  d.textContent = text;
  document.body.appendChild(d);
  // a correct verdict just blips (0.5s, no hang); a wrong one lingers so the
  // revealed answer can actually be read
  const dur = ok ? 500 : 2200;
  d.animate(
    [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.8)' },
     { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.18 },
     { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.8 },
     { opacity: 0, transform: 'translate(-50%,-50%) scale(1.03)' }],
    { duration: dur, easing: 'ease-out' }).onfinish = () => d.remove();
}

/* what to shout when a battle opens */
function announceBattle(b) {
  if (!b) return;
  if (b.is_pharos) {
    // the ceremony (seals + door + darkness) already played on ENTER — the
    // door is open, so go straight to naming the foe waiting within
    showAnnounce('The Dark Presence', 'The final trial', '#a36cff');
  } else if (b.is_lair) {
    const sub = b.escalation > 0 ? `Risen ×${b.escalation} — a rival came before you` : 'Your trial';
    showAnnounce(b.name, sub, '#ffb454');
  } else if (b.ambush) {
    showAnnounce('Ambush!', b.name, '#e0553a');
  } else {
    showAnnounce(b.name, 'Bars the way', '#e0553a');
  }
}

/* ── sound reactions + battle beats ─────────────────────────────────────── */
let sfxLastTurn = null, sfxPrevPhase = null, sfxAnnouncedWin = false;
let lastMgTag = null;      // dedupes kraken/sphinx announcements
let audioDeferred = false;

function reactAudio(prev, next) {
  if (!next) return;
  // Hold the whole audio reaction — the puzzle/battle music, the roar, the
  // reveal beats — until the captain's boat actually lands. Otherwise the
  // scene switches the moment the server does, and you hear a puzzle before
  // you've reached the island. onArrive replays this once the boat parks.
  if (world.arriving()) { audioDeferred = true; return; }
  audioDeferred = false;
  if (next.phase !== sfxPrevPhase && sfxPrevPhase === 'reveal') clearBeats();

  if (next.phase === 'roll' && next.turn === you && sfxLastTurn !== next.turn) {
    audio.sfx.turn();
  }
  sfxLastTurn = next.phase === 'lobby' ? null : next.turn;

  if (next.phase === 'reveal' && sfxPrevPhase !== 'reveal' && next.reveal) {
    clearBeats();
    const rv = next.reveal;
    revealCardDropped = false;
    if (rv.kind === 'battle') {
      const enemyTurn = !!rv.enemy_phase?.enemy_turn;
      if (enemyTurn) {
        // the ENEMY-TURN reveal: no card, no verdict chime — the foe has
        // wound up (the dodge beat just passed) and the blow lands now
        revealCardDropped = true;
        renderQuestion(); renderBattle();
        playBattleBeats(rv);
      } else {
        // 1) the VERDICT: right or wrong, shown plainly on its own…
        if (rv.was_correct) audio.sfx.correct(); else audio.sfx.wrong();
        if (rv.challenge === 'puzzle') {
          revealCardDropped = true;           // puzzle rounds have no card
          setBTurn(rv.was_correct
            ? `${icon('laurel', 16)} <strong>PUZZLE SOLVED!</strong>`
            : `${icon('skull', 16)} the puzzle stands — <strong>you falter…</strong>`);
        }
        // 2) …then half a beat later the card clears and YOUR move plays
        beat(500, () => { revealCardDropped = true; renderQuestion(); renderBattle(); playBattleBeats(rv); });
      }
    } else if (rv.was_correct) audio.sfx.correct();
    else audio.sfx.wrong();
  }
  if (next.phase === 'battle' && sfxPrevPhase !== 'battle' && sfxPrevPhase !== 'reveal') {
    audio.sfx.roar();
    announceBattle(next.battle);
  }
  const mgTag = next.phase !== 'minigame' ? null
    : next.minigame?.kraken ? 'kraken' + (next.minigame.kraken_no || 1)
    : next.minigame?.sphinx ? 'sphinx' : null;
  if (mgTag && mgTag !== lastMgTag) {
    if (mgTag === 'kraken1') {
      audio.sfx.roar();
      showAnnounce('THE KRAKEN', 'three riddles of the mind — or lose a turn', '#3fb6c8');
    } else if (mgTag === 'sphinx') {
      beginSphinxAmbush();
    }
  } else if (!mgTag && lastMgTag === 'sphinx') {
    // left the Sphinx (answered, or swept into her fight): drop any lingering
    // intro state so a stale flag can't hide a later riddle modal
    sphinxIntro = false;
    clearSphinxTimers();
    hideSphinxSpeak();
  }
  lastMgTag = mgTag;
  if (next.phase === 'finished' && !sfxAnnouncedWin) {
    audio.sfx.victory();
    sfxAnnouncedWin = true;
  }
  if (next.phase !== 'finished') sfxAnnouncedWin = false;

  /* soundtrack scenes: lobby / battle / puzzle / endgame / per-realm open sea */
  const battleish = next.phase === 'battle' || next.phase === 'dodge' ||
    next.phase === 'jchoose' ||
    (next.phase === 'question' && next.question?.kind === 'battle') ||
    (next.phase === 'minigame' && (next.minigame?.battle || next.minigame?.sphinx)) ||
    (next.phase === 'reveal' && next.reveal?.kind === 'battle');
  const puzzleish = next.phase === 'minigame' ||
    (next.phase === 'question' && ['puzzle', 'riddle'].includes(next.question?.kind)) ||
    (next.phase === 'reveal' && next.reveal?.kind === 'puzzle') ||
    next.phase === 'upgrade_pick';
  let scene;
  if (next.phase === 'lobby') scene = 'lobby';
  // the Dark Presence gets its own theme ("The Escape") — every other fight
  // shares the common battle track
  else if (battleish) scene = next.battle?.is_pharos ? 'finalbattle' : 'battle';
  else if (puzzleish) scene = 'puzzle';
  // the endgame theme is the WINNER'S music — it waits until the Dark Presence
  // is actually down (phase 'finished'), NOT the moment the Pharos opens. With
  // the seals banked you keep sailing the hub to its own theme until you win.
  else if (next.phase === 'finished') scene = 'endgame';
  else {
    // open sea → the realm's own theme (desert alternates). Prefer the LIVE
    // active stage over curRealm so the track can't lag or flip mid-crossing.
    const stg = world.currentStage?.();
    const realm = REALM_MUSIC.has(stg) ? stg
      : (REALM_MUSIC.has(curRealm) ? curRealm : null);
    if (realm) scene = realmMusic(realm);
  }
  audio.setScene(scene);

  /* duck under trivia cards — and under Simon, whose tones need the spotlight */
  audio.duck((next.phase === 'question' && !puzzleish && !battleish) ||
             (next.phase === 'minigame' && ['simon', 'memory'].includes(next.minigame?.kind)));
  sfxPrevPhase = next.phase;
}

function beat(ms, fn) { beatTimers.push(setTimeout(fn, ms)); }
function clearBeats() {
  beatTimers.forEach(clearTimeout);
  beatTimers = [];
  bHullShown = null;
  bEnemyFrozen = false;
  bPreReveal = null;
}

/* During a reveal the server's hull is already the POST-hit value, but the
 * blow lands ~1.4s later in the choreography. Hold the hearts at the pre-hit
 * count until the strike actually connects, so they never drop early. */
let bHullShown = null;
let bPreReveal = null;      // enemy ranks as they stood before the blow
let bEnemyFrozen = false;   // true until YOUR strike visibly lands
function refreshBHearts() {
  const fighter = room && room.players.find((p) => p.pid === room.turn);
  const el = $('bship');
  if (!fighter || !el) return;
  const hp = bHullShown != null ? bHullShown : fighter.hull;
  el.innerHTML = `<div class="bsub"><strong>${esc(fighter.name)}</strong></div>${heartRow(hp, fighter.max_hull)}`;
}

function flashScreen(color) {
  const f = $('flash');
  f.className = color;
  requestAnimationFrame(() => { f.className = color + ' fade'; });
  setTimeout(() => { f.className = ''; }, 650);
}

function shake(heavy = false) {
  document.body.classList.remove('shake');
  void document.body.offsetWidth;
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), heavy ? 700 : 500);
  if (heavy) setTimeout(() => flashScreen('red'), 180);
}

function setBTurn(text) {
  const el = $('bturn');
  if (el) el.innerHTML = text;
}

/* A battle exchange now plays across TWO reveals with the DODGE beat wedged
 * between them, so it never blurs together:
 *   1) YOUR MOVE reveal — the verdict (right/wrong) and your strike, shown
 *      plainly. If a counter is coming, ep.pending is set and we STOP here.
 *   2) …the foe winds up → the DODGE action command → the ENEMY-TURN reveal
 *      (ep.enemy_turn), where the blow actually lands.
 * Backfires and clean evades have no counter, so they still play in one go. */
function playBattleBeats(rv) {
  const ep = rv.enemy_phase || {};
  // if a blow is about to land on the hero, hold the hearts at the pre-hit
  // count now (the server hull is already docked) and drop them when it hits
  const fighter = room && room.players.find((p) => p.pid === room.turn);
  const heroDmg = ep.dmg > 0 ? ep.dmg : 0;
  bHullShown = (heroDmg && fighter) ? fighter.hull + heroDmg : null;
  const landHit = () => { bHullShown = null; refreshBHearts(); renderPlayers(); };
  refreshBHearts();
  const idx = ep.target_idx ?? 0;
  const stance = (room?.turn === you && myStance)
    ? myStance
    : (ep.dealt >= 3 ? 'magic' : 'attack');
  const foe = esc(ep.attacker || 'the beast');
  const blowText = ep.blocked
    ? `${foe} strikes — <strong>your aegis turns it aside!</strong>`
    : ep.dodged
      ? `${foe} ${ep.heavy ? 'swings a <strong>HEAVY BLOW</strong>' : 'strikes'} — <strong>you twist aside!</strong> `
        + (ep.dmg > 0 ? `Only <strong>${ep.dmg}</strong> gets through`
                      : '<strong>Nothing</strong> gets through!')
      : `${foe} ${ep.heavy ? 'lands a <strong>HEAVY BLOW</strong>' : 'strikes'} for <strong>${ep.dmg}</strong>!`;

  /* ── the ENEMY-TURN reveal: the wound-up blow lands (the dodge just passed) ── */
  if (ep.enemy_turn) {
    bEnemyFrozen = false;
    setBTurn(`ENEMY MOVE — ${blowText}`);
    beat(150, () => {
      if (ep.dmg > 0) world.battlePlay('enemy_attack', { dmg: ep.dmg, heavy: ep.heavy });
      else world.battlePlay('enemy_miss');
    });
    beat(500, () => {
      if (ep.dmg > 0) {
        audio.sfx.hurt();
        if (ep.heavy) audio.sfx.roar();
        flashScreen('red');
        shake(ep.heavy);
      } else {
        audio.sfx.sail();               // a perfect read / block — the blow whiffs
      }
      landHit();
    });
    if (rv.battle_over && rv.player_dead) {
      beat(1100, () => {
        world.battlePlay('defeat');
        setBTurn(`${icon('skull', 16)} <strong>SHIPWRECK…</strong>`);
        showBattleEnd('death', 'The sea takes you back to your last haven.');
      });
      return;
    }
    if (room?.battle?.charging) {
      beat(1300, () => { world.battlePlay('charge_telegraph'); audio.sfx.roar(); });
    }
    return;
  }

  /* ── the YOUR-MOVE reveal ─────────────────────────────────────────────────── */
  let chargeAt = 2200;
  if (rv.was_correct && ep.healed != null) {
    /* HEAL — a mending hymn: NO strike/hit animation, just knit the hearts */
    bEnemyFrozen = false;
    audio.sfx.correct?.();
    renderPlayers(); refreshBHearts(); renderBattle();
    setBTurn(ep.healed > 0
      ? `${icon('heart', 16)} YOUR MOVE — the hymn mends <strong>${ep.healed}</strong>!`
      : `${icon('heart', 16)} YOUR MOVE — the hull is already whole`);
    if (ep.pending) return;
  } else if (rv.was_correct) {
    /* STRIKE / MAGIC lands */
    bEnemyFrozen = false;                   // your blow lands NOW
    audio.sfx.hit();
    flashScreen('gold');
    world.battlePlay('player_hit', { idx, dmg: ep.dealt, stance });
    renderBattle();
    setBTurn(`${icon(stance === 'magic' ? 'magic' : 'strike', 16)} YOUR MOVE — you hit for <strong>${ep.dealt}</strong>!`);
    if (ep.killed) beat(500, () => world.battlePlay('enemy_die', { idx }));

    if (rv.battle_over && !rv.player_dead) {
      beat(900, () => audio.sfx.laurel());
      beat(1300, () => { world.battlePlay('victory'); showBattleEnd('win'); });
      beat(1900, () => setBTurn(`${icon('laurel', 18)} <strong>VICTORY!</strong>`));
      return;
    }
    // every foe now counters — the blow comes after the dodge beat (no evade)
    if (ep.pending) return;
  } else if (ep.backfire) {
    bEnemyFrozen = false;
    setBTurn(`${icon('magic', 16)} YOUR MOVE — the spell fizzles…`);
    beat(900, () => {
      setBTurn(`It <strong>backfires</strong> for <strong>${ep.dmg}</strong> damage!`);
      world.battlePlay('backfire');
      audio.sfx.hurt();
      flashScreen('red');
      shake();
      landHit();
    });
    chargeAt = 2200;
  } else if (ep.pending) {
    /* a miss — your move fails; the foe winds up for the dodge beat to come */
    bEnemyFrozen = false;
    setBTurn('YOUR MOVE — the answer escapes you…');
    return;
  } else {
    /* a blocked-by-aegis / no-counter round: nothing lands */
    bEnemyFrozen = false;
    setBTurn('YOUR MOVE — the moment slips past…');
  }

  if (room?.battle?.charging) {
    beat(chargeAt, () => {
      world.battlePlay('charge_telegraph');
      audio.sfx.roar();
    });
  }
}

/* ── the DODGE action beat (Paper-Mario style) ──────────────────────────────
 * When a foe strikes back, the server holds the blow in the 'dodge' phase.
 * A ring collapses onto a target; tap (or hit space) EXACTLY as they meet
 * and half the blow is nulled. One attempt, tight window, no second chances
 * — miss the beat or freeze up and it lands full. */
let dodgeState = null;   // {raf, t0, done, key}

function renderDodge() {
  const el = $('dodgeQte');
  const d = room?.dodge;
  const active = room.phase === 'dodge' && d;
  if (!active) {
    if (dodgeState) {
      cancelAnimationFrame(dodgeState.raf);
      removeEventListener('keydown', dodgeState.key);
      dodgeState = null;
    }
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const mine = room.turn === you;
  const key = `${d.deadline || d.attacker}`;       // one beat per incoming blow
  if (dodgeState?.id === key) return;              // already running this beat
  if (dodgeState) { cancelAnimationFrame(dodgeState.raf); removeEventListener('keydown', dodgeState.key); }
  el.classList.remove('hidden');

  // a big warning banner over the telegraphed heavy blow, so the dodge for
  // the bigger hit never takes you by surprise
  const warn = d.heavy
    ? `<div class="dodgewarn heavy">${icon('guard', 15)} HEAVY BLOW</div>`
    : '';

  if (!mine) {
    const fighter = room.players.find((p) => p.pid === room.turn);
    el.innerHTML = warn + `<div class="dodgecap">${esc(d.attacker)} strikes — ` +
      `${esc(fighter?.name || 'the captain')} reads the blow…</div>`;
    dodgeState = { id: key, raf: 0, key: () => {} };
    return;
  }

  // the timing wheel: a white clock hand sweeps the circle; a gold arc is
  // shaded onto the ring at a random position each beat. Tap while the hand
  // is inside the gold and the dodge lands. The arc is narrow and the hand
  // is quick — not easy, and never in the same place twice.
  const ARC = 42;                       // gold window, degrees (~135ms of hand)
  const CORE = 15;                       // bright core inside the gold: a PERFECT
  const PERIOD = 1150;                  // ms per revolution
  const WINDUP = 450;                   // arc shown, hand held at 12 o'clock
  const REVS = 2;                       // two laps, then the blow lands
  const arcStart = 100 + Math.random() * 200;   // degrees clockwise from 12
  const coreOff = (ARC - CORE) / 2;             // core centred in the gold band

  el.innerHTML = warn +
    `<div class="dodgecap">${esc(d.attacker)} strikes! <strong>DODGE!</strong></div>` +
    '<div class="dodgewheel">' +
    // gold band = twist aside for HALF; the pale core at its centre = a clean,
    // FULL dodge (the only way clear of a boss's heavy blow)
    `<div class="dq-arc" style="background:conic-gradient(from ${arcStart}deg,` +
    'rgba(240,208,96,.92) 0deg,' +
    `rgba(240,208,96,.92) ${coreOff}deg,` +
    `rgba(255,248,214,1) ${coreOff}deg,` +
    `rgba(255,248,214,1) ${coreOff + CORE}deg,` +
    `rgba(240,208,96,.92) ${coreOff + CORE}deg,` +
    `rgba(240,208,96,.92) ${ARC}deg,` +
    `transparent ${ARC}deg)"></div>` +
    '<div class="dq-hand"></div><div class="dq-verdict"></div></div>' +
    `<div class="dodgehint">${d.heavy
      ? 'nail the bright core to slip the heavy blow — the gold only softens it'
      : 'tap when the hand crosses the gold'}</div>`;
  const hand = el.querySelector('.dq-hand');
  const verdict = el.querySelector('.dq-verdict');

  const t0 = performance.now();
  const angleAt = (t) =>                // degrees clockwise from 12 o'clock
    Math.max(0, (t - t0 - WINDUP)) / PERIOD * 360;
  const relAt = (a) => ((a - arcStart) % 360 + 360) % 360;
  const inGold = (a) => relAt(a) <= ARC;
  const inCore = (a) => { const r = relAt(a); return r >= coreOff && r <= coreOff + CORE; };
  const st = { id: key, done: false, raf: 0, key: null };
  const finish = (hit, full, label) => {
    if (st.done) return;
    st.done = true;
    send({ type: 'dodge', hit, full });
    verdict.textContent = label;
    verdict.className = 'dq-verdict ' + (hit ? 'hit' : 'miss');
    if (hit) audio.sfx.sail(); else audio.sfx.hurt();
    el.classList.add(hit ? 'dodged' : 'flubbed');
  };
  const tick = (now) => {
    if (st.done) return;
    const a = angleAt(now);
    hand.style.transform = `rotate(${(a % 360).toFixed(2)}deg)`;
    hand.style.opacity = now - t0 < WINDUP ? '0.45' : '1';
    if (a >= REVS * 360) { finish(false, false, 'TOO LATE'); return; }
    st.raf = requestAnimationFrame(tick);
  };
  const attempt = () => {
    if (st.done) return;
    const t = performance.now();
    if (t - t0 < WINDUP) return;                   // hand not moving yet
    const a = angleAt(t);
    const full = inCore(a);
    const hit = inGold(a);
    finish(hit, full, full ? 'PERFECT!' : hit ? 'DODGED!' : 'MISSED');
  };
  el.onpointerdown = (e) => { e.preventDefault(); attempt(); };
  st.key = (e) => { if (e.code === 'Space') { e.preventDefault(); attempt(); } };
  addEventListener('keydown', st.key);
  st.raf = requestAnimationFrame(tick);
  dodgeState = st;
}

/* ── the JEOPARDY! category board ───────────────────────────────────────────
 * A jeopardy round opens on a board of four categories (STRIKE deals $200/$400,
 * MAGIC $800/$1000). Tap a tile to lock that clue in; it becomes the typed
 * question. Its own RAF drives the countdown so it never fights the shared
 * question timer. */
let jbTimerRAF = 0;
function renderJboard() {
  const el = $('jboard');
  const b = room?.jboard;
  const active = room.phase === 'jchoose' && b && !world.arriving();
  if (!active) {
    cancelAnimationFrame(jbTimerRAF); jbTimerRAF = 0;
    el.classList.add('hidden'); el.classList.remove('picked');
    el.innerHTML = ''; el.dataset.key = '';
    return;
  }
  const mine = room.turn === you;
  const fighter = room.players.find((p) => p.pid === room.turn);
  const key = 'jb#' + b.cells.map((c) => c.category + c.value).join('|') + (mine ? '#me' : '');
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    // a NEW board is live again: clear the lock from the previous pick, or
    // #jboard.picked { pointer-events:none } leaves every later board dead
    el.classList.remove('hidden', 'picked');
    const title = b.band === 'high' ? 'MAGIC · $800 / $1000' : 'STRIKE · $200 / $400';
    el.innerHTML =
      `<div class="jbhead">${icon('scroll', 18)} JEOPARDY! — ` +
      `${mine ? 'pick a category' : esc(fighter?.name || 'the captain') + ' is choosing…'}</div>` +
      `<div class="jbsub">${title}</div>` +
      '<div class="jbtimer"><div class="jbtimerBar"></div></div>' +
      '<div class="jbgrid">' +
      b.cells.map((c, i) =>
        `<button class="jbcell${mine ? '' : ' disabled'}" data-idx="${i}"${mine ? '' : ' disabled'}>` +
        `<span class="jbval">$${c.value}</span>` +
        `<span class="jbcat">${esc(c.category)}</span></button>`).join('') +
      '</div>';
    if (mine) {
      el.querySelectorAll('.jbcell').forEach((btn) => {
        btn.onclick = () => {
          if (el.classList.contains('picked')) return;
          el.classList.add('picked');
          send({ type: 'jpick', idx: parseInt(btn.dataset.idx, 10) });
        };
      });
    } else {
      el.classList.remove('picked');
    }
  }
  // own countdown bar (server deadline vs the client clock)
  const bar = el.querySelector('.jbtimerBar');
  cancelAnimationFrame(jbTimerRAF);
  if (bar && b.deadline) {
    if (bar.dataset.deadline !== String(b.deadline)) {
      bar.dataset.deadline = String(b.deadline);
      bar.dataset.total = String(Math.max(0.001, b.deadline - Date.now() / 1000));
    }
    const total = parseFloat(bar.dataset.total);
    const tick = () => {
      const pct = Math.max(0, Math.min(1, (b.deadline - Date.now() / 1000) / total));
      bar.style.width = (pct * 100) + '%';
      bar.style.background = pct < 0.25 ? '#e4572e' : '';
      if (pct > 0 && room.phase === 'jchoose') jbTimerRAF = requestAnimationFrame(tick);
    };
    tick();
  }
}

/* ── rendering ──────────────────────────────────────────────────────────── */
function render() {
  if (!room) return;
  // keep the 3D diorama rendered through the whole battle reveal — the
  // VICTORY / YOU DIED card plays OVER the fight, not the board it left.
  // (Set before world.update so the stage picker sees it this frame.)
  world.holdBattleStage(room.phase === 'reveal' && room.reveal?.kind === 'battle');
  world.update(room, you);
  // the VICTORY / YOU DIED beat lives only over the closing battle reveal
  if (room.phase !== 'reveal') clearBattleEnd();
  const inLobby = room.phase === 'lobby';
  $('lobby').classList.toggle('hidden', !inLobby);
  $('hud').classList.toggle('hidden', inLobby);
  if (inLobby) {
    lastStage = null;
    lastBattleSnap = null;
    $('modal').classList.add('hidden');
    $('qmodal').classList.add('hidden');
    $('mgmodal').classList.add('hidden');
    $('battleHud').classList.add('hidden');
    $('uppanel').classList.add('hidden');
    $('shopPanel').classList.add('hidden');
    $('mapBtn').classList.add('hidden');
    if (mapOpen) toggleMap(false);
    document.body.classList.remove('battling');
    renderLobby();
    return;
  }
  renderPlayers();
  renderTurnBanner();
  renderMapBtn();
  renderTray();
  renderShop();
  maybeSwordClaim();
  renderItembelt();
  renderBattle();
  renderDodge();
  renderJboard();
  renderQuestion();
  renderMinigame();
  renderModal();
  renderVictory();
  renderLog();
}

/* ── lobby ──────────────────────────────────────────────────────────────── */
function renderLobby() {
  $('joinForm').classList.add('hidden');
  $('waitRoom').classList.remove('hidden');
  $('lobbyErr').textContent = '';
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="dot" style="background:${p.color}"></span>` +
      (p.bot ? icon('bot', 14) + ' ' : '') +
      `<span>${esc(p.name)}</span>` +
      (p.pid === room.host ? ` <em class="laurel-mark">${icon('laurel', 12)} host</em>` : '<em></em>') +
      (you === room.host && p.pid !== you
        ? `<button class="kick" data-pid="${p.pid}" title="Remove">${icon('kick', 12)}</button>` : '');
    ul.appendChild(li);
  }
  ul.querySelectorAll('.kick').forEach((b) => {
    b.onclick = () => send({ type: 'kick', pid: b.dataset.pid });
  });
  const isHost = you === room.host;
  const humans = room.players.filter((p) => !p.bot).length;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = room.players.length < 1;
  // once a second (human) captain joins, drop the fill-with-AI button
  $('addBotBtn').classList.toggle('hidden', !isHost || room.players.length >= 6 || humans > 1);
  $('waitMsg').classList.toggle('hidden', isHost);
}

/* ── captain cards (top-left) ───────────────────────────────────────────── */
function nodeOf(p) {
  return (room.board.nodes || []).find((n) => n.id === p.node);
}

function hullPips(p) {
  // the fighter's pips hold at the pre-blow count until the hit lands on
  // screen — the same freeze the battle hearts use
  const hull = (bHullShown != null && p.pid === room.turn) ? bHullShown : p.hull;
  let s = '<span class="hullpips">';
  for (let i = 0; i < p.max_hull; i++) s += `<i class="${i < hull ? '' : 'dim'}"></i>`;
  return s + '</span>';
}

function relicPips(p) {
  const n = room.config.relics_to_win;
  let s = '<span class="relicpips">';
  for (let i = 0; i < n; i++) s += `<span class="pip ${i < p.banked ? 'on' : ''}"></span>`;
  return s + '</span>';
}

function renderPlayers() {
  const el = $('players');
  el.innerHTML = '';
  for (const p of room.players) {
    const node = nodeOf(p);
    const realm = node?.region;
    const div = document.createElement('div');
    div.className = 'pchip' + (p.pid === room.turn ? ' turn' : '') +
      (p.connected ? '' : ' gone') + (p.pid === you ? ' me' : '');
    div.title = `${p.name} — hull ${p.hull}/${p.max_hull}, ${p.scrolls} scrolls, ` +
      `${p.banked}/${room.config.relics_to_win} seals banked. Click to inspect.`;
    div.innerHTML =
      `<span class="dot" style="background:${p.color}"></span>` +
      `<span class="pname">${p.bot ? icon('bot', 12) + ' ' : ''}${esc(p.name)}</span>` +
      (realm
        ? `<span class="realmbadge" data-realm="${realm}" title="${esc(REALM_INFO[realm]?.name || realm)}">${realm[0].toUpperCase()}</span>`
        : '') +
      (p.streak >= 2 ? `<span class="streak" title="Answer streak">${icon('streak')}${p.streak}</span>` : '') +
      hullPips(p) +
      `<span class="stat" title="Scrolls">${icon('scroll')}${p.scrolls}</span>` +
      (p.cargo ? `<span class="stat cargo" title="Sigil seal aboard — unbanked!">${icon('cargo')}${p.cargo}</span>` : '') +
      relicPips(p) +
      (you === room.host && p.pid !== you
        ? `<button class="kick" data-pid="${p.pid}" title="Remove">${icon('kick', 12)}</button>` : '');
    div.onclick = (e) => {
      if (e.target.closest('.kick')) return;
      showInspector(p.pid);
    };
    el.appendChild(div);
  }
  el.querySelectorAll('.kick').forEach((b) => {
    b.onclick = () => send({ type: 'kick', pid: b.dataset.pid });
  });
}

/* ── player inspector (#uppanel) ────────────────────────────────────────── */
function showInspector(pid) {
  const p = room.players.find((x) => x.pid === pid);
  if (!p) return;
  const panel = $('uppanel');
  const ups = p.upgrades || [];
  const stock = room.config?.shop_items || {};
  const charms = Object.entries(p.items || {}).filter(([, n]) => n > 0);
  const node = nodeOf(p);
  const where = node ? node.name : '?';
  panel.innerHTML =
    `<h3><span class="dot" style="background:${p.color}"></span>${esc(p.name)}'s ship</h3>` +
    `<p class="tag">${esc(where)}${node?.region ? ' · ' + esc(REALM_INFO[node.region]?.name || '') : ''}` +
    ` · hull ${p.hull}/${p.max_hull} · ${p.scrolls} scrolls · ${p.banked}/${room.config.relics_to_win} seals banked` +
    (p.cargo ? ` · <strong>${p.cargo} seal${p.cargo > 1 ? 's' : ''} aboard</strong>` : '') + '</p>' +
    '<h3>Fittings</h3>' +
    (ups.length
      ? ups.map((u) => {
          const info = room.upgrade_info[u] || { name: u, desc: '' };
          return `<div class="uprow"><span class="upic">${icon(UP_ICON[u] || 'fitting')}</span>
            <div><strong>${esc(info.name)}</strong><br><small>${esc(info.desc)}</small></div></div>`;
        }).join('')
      : '<p class="tag">No fittings yet — puzzle spires and shipwrights sell them.</p>') +
    (charms.length
      ? '<h3>Charms</h3>' + charms.map(([id, n]) => {
          const info = stock[id] || { name: id, desc: '' };
          return `<div class="uprow"><span class="upic">${icon(SHOP_ICON[id] || 'relic')}</span>
            <div><strong>${esc(info.name)} ×${n}</strong><br><small>${esc(info.desc)}</small></div></div>`;
        }).join('')
      : '') +
    '<button class="small" id="upclose">Close</button>';
  panel.classList.remove('hidden');
  $('upclose').onclick = () => panel.classList.add('hidden');
}


function renderTurnBanner() {
  const el = $('turnBanner');
  const players = room.players || [];
  const ti = players.findIndex((x) => x.pid === room.turn);
  if (ti < 0 || room.phase === 'finished' || room.phase === 'lobby') {
    el.innerHTML = ''; el.style.display = 'none'; return;
  }
  el.style.display = '';
  // rotate so the active captain leads — the strip then reads left-to-right
  // in the exact order the captains will take their turns
  const order = players.slice(ti).concat(players.slice(0, ti));
  const short = (s) => (s.length > 10 ? esc(s.slice(0, 9)) + '…' : esc(s));
  el.innerHTML = '<div class="turnorder">' + order.map((p, i) => {
    const me = p.pid === you;
    const cls = ['tocap', i === 0 ? 'active' : '', me ? 'me' : '',
                 p.connected === false ? 'gone' : ''].filter(Boolean).join(' ');
    const name = i === 0 && me ? 'You' : short(p.name);
    return `<span class="${cls}" title="${esc(p.name)}${me ? ' (you)' : ''}` +
      `${i === 0 ? " — now" : i === 1 ? ' — next' : ''}">` +
      `<span class="dot" style="background:${p.color}"></span>` +
      `<span class="toname">${name}</span>` +
      (p.bot ? icon('bot', 11) : '') + '</span>';
  }).join('<span class="toarrow">›</span>') + '</div>';
}

/* ── the chart: a live AERIAL view of the region you are in ─────────────── */
/* WASD / arrows and right-click-drag pan (locked within the mountains),
   the wheel zooms, icons float over every isle — hover one to name it. */
let mapOpen = false;
let mapRAF = 0;

const MAP_POI = {
  home:   { icon: 'home',    label: 'Home Port',            cls: 'home' },
  gate:   { icon: 'flag',    label: 'Mountain Pass',        cls: 'gate' },
  shrine: { icon: 'laurel',  label: 'Oracle — trivia wagers', cls: 'shrine' },
  shop:   { icon: 'market',  label: 'Trader — market isle', cls: 'shop' },
  puzzle: { icon: 'fitting', label: 'Puzzle Spire',         cls: 'puzzle' },
  haven:  { icon: 'anchor',  label: 'Haven — checkpoint',   cls: 'haven' },
  monster:{ icon: 'skull',   label: 'Hunting Grounds',      cls: 'foe' },
  lair:   { icon: 'skull',   label: 'Boss Lair',            cls: 'lair' },
  pharos: { icon: 'crown',   label: 'The Pharos',           cls: 'pharos' },
  sword:  { icon: 'sword',   label: 'The sword in the stone', cls: 'swordx' },
};

function mapChipLabel(p) {
  if (p.player) return '';
  if (p.type === 'sword') return '?';
  const poi = MAP_POI[p.type] || {};
  let name = p.name || poi.label || p.type;
  if (p.type === 'gate' && p.region) name = `Pass to ${REALM_INFO[p.region]?.name || p.region}`;
  if (p.type === 'lair') name = `${p.boss_name || 'The tyrant'}${p.defeated ? ' · slain' : ''} — boss lair`;
  if (p.type === 'haven') name = `${p.name} — haven (checkpoint)`;
  if (p.type === 'shrine') name = `${p.name} — oracle`;
  if (p.type === 'shop') name = `${p.name} — trader`;
  if (p.type === 'puzzle') name = `${p.name} — puzzle spire${p.solved ? ' (solved)' : ''}`;
  return name;
}

function renderMapBtn() {
  $('mapBtn').classList.toggle('hidden', !room || room.phase === 'lobby');
  // modal phases and battles reclaim the screen — the chart rolls itself up
  if (['question', 'minigame', 'reveal', 'upgrade_pick', 'finished', 'battle']
      .includes(room?.phase) || world.battleActive()) {
    document.getElementById('valeChart')?.remove();
    if (mapOpen) toggleMap(false);
  }
}

/* The Amber Vale's "chart": a question mark. The Vale is DIFFERENT FOR
   EVERY CAPTAIN — a private labyrinth read by lantern light, so the chart
   has nothing to show. Any tap (or the map key again) dismisses it. */
function showValeChart() {
  let ov = document.getElementById('valeChart');
  if (ov) { ov.remove(); return; }
  audio.sfx?.click?.();
  ov = document.createElement('div');
  ov.id = 'valeChart';
  ov.innerHTML = `
    <div class="vc-card">
      <div class="vc-mark">?</div>
      <div class="vc-line">The Amber Vale is different for every captain.</div>
      <div class="vc-sub">No chart can hold it — walk it by lantern light,
        and steer for the golden beacon.</div>
    </div>`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

function toggleMap(open) {
  const want = open ?? !mapOpen;
  if (want === mapOpen) return;
  if (want) {
    // the Amber Vale is different for every captain — the chart is just a
    // question mark there. (DEV mode keeps the real chart for testing.)
    if (world.currentStage?.() === 'autumn' && !devUnlocked) {
      showValeChart();
      return;
    }
    if (!world.enterMapView(devUnlocked)) return;
    mapOpen = true;
    audio.sfx?.click?.();
    $('mapIcons').classList.remove('hidden');
    $('mapHint').classList.remove('hidden');
    $('mapBtn').classList.add('on');
    mapTick();
  } else {
    mapOpen = false;
    world.exitMapView();
    cancelAnimationFrame(mapRAF);
    $('mapIcons').classList.add('hidden');
    $('mapIcons').innerHTML = '';
    $('mapHint').classList.add('hidden');
    $('mapBtn').classList.remove('on');
    document.body.classList.remove('shop-aside');   // the stall slides back in
  }
}

function mapTick() {
  if (!mapOpen) return;
  const pts = world.mapProject() || [];
  const box = $('mapIcons');
  const seen = new Set();
  for (const p of pts) {
    const key = p.player ? 'pl:' + p.player : p.id;
    seen.add(key);
    let el = box.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.dataset.key = key;
      if (p.player) {
        const pl = room.players.find((q) => q.pid === p.player);
        el.className = 'mapav' + (p.player === you ? ' you' : '');
        el.style.setProperty('--pc', pl?.color || '#888');
        el.textContent = (pl?.name || '?').slice(0, 1).toUpperCase();
        el.title = pl ? `${pl.name}${p.player === you ? ' (you)' : ''}` : '';
      } else if (p.type === 'sword') {
        // the trader's mark: a red X that descends onto the islet, labelled "?"
        const drop = !swordDropSeen; swordDropSeen = true;
        el.className = 'mapchip swordx' + (drop ? ' drop' : '');
        el.innerHTML = `<span class="mi mapx">✕</span><span class="ml">?</span>`;
      } else {
        const poi = MAP_POI[p.type] || { icon: 'relic', cls: '' };
        el.className = `mapchip ${poi.cls}${p.type === 'lair' && p.defeated ? ' done' : ''}`;
        el.innerHTML = `<span class="mi">${icon(poi.icon)}</span>` +
          `<span class="ml">${esc(mapChipLabel(p))}</span>`;
      }
      box.appendChild(el);
    }
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  }
  for (const el of [...box.children]) {
    if (!seen.has(el.dataset.key)) el.remove();
  }
  mapRAF = requestAnimationFrame(mapTick);
}

/* ── action tray (bottom-center) ────────────────────────────────────────── */
function trayBtn(tray, label, cls, onclick, disabled = false) {
  const b = document.createElement('button');
  b.className = 'act ' + cls;
  b.innerHTML = label;
  b.disabled = disabled;
  b.onclick = onclick;
  tray.appendChild(b);
  return b;
}

function trayHint(tray, text) {
  const s = document.createElement('span');
  s.className = 'hint';
  s.innerHTML = text;
  tray.appendChild(s);
}

function renderTray() {
  const tray = $('tray');
  tray.innerHTML = '';
  const mine = room.turn === you;
  const me = room.players.find((p) => p.pid === you);

  if (room.phase === 'finished') {
    const w = room.players.find((p) => p.pid === room.winner);
    trayHint(tray, `${icon('crown', 15)} <strong>${esc(w?.name || '?')}</strong> holds the Pharos!`);
    if (you === room.host) trayBtn(tray, 'NEW VOYAGE', 'gold', () => send({ type: 'rematch' }));
    return;
  }
  if (!mine) {
    const cur = room.players.find((p) => p.pid === room.turn);
    if (cur?.veiled) {
      trayHint(tray, `${icon('anchor', 14)} <strong>${esc(cur.name)}</strong> walks their own Amber Vale — the fog keeps their trail.`);
    }
    if (you === room.host) {
      trayBtn(tray, 'skip turn', 'ghost small', () => send({ type: 'skip' }));
    }
    return;
  }

  // on foot in the desert/vale the flavour is a trek, not a voyage
  const foot = ['desert', 'autumn'].includes(nodeOf(me)?.region);
  if (room.phase === 'roll') {
    // the previous captain may still be moving on-screen — don't hand the
    // dice over until they've actually stopped
    if (world.animating()) {
      trayHint(tray, foot
        ? `${icon('anchor', 14)} The dust still settles — hold a moment…`
        : `${icon('anchor', 14)} The wake still runs — hold until the tide settles…`);
    } else {
      trayBtn(tray, `${icon('dice', 17)} ROLL`, 'gold big', () => send({ type: 'roll' }));
    }
  } else if (room.phase === 'trade' && !world.arriving()) {
    // the end-of-turn beat: a last word with the trader before the dice pass
    trayHint(tray, foot
      ? `${icon('market', 14)} The trader catches you before you move on…`
      : `${icon('market', 14)} The trader hails you before the tide turns…`);
    trayBtn(tray, `${icon('market', 14)} TRADER`, 'build',
            () => { shopRemote = !shopRemote; shopClosed = false; renderShop(); });
    trayBtn(tray, 'END TURN', 'gold big', () => send({ type: 'pass' }));
  } else if (room.phase === 'sail' && room.walk
             && !Object.keys(room.reachable || {}).length) {
    // mid arrow-walk: committed to the trail, steering fork by fork
    if (room.walk.options && room.walk.options.length) {
      trayHint(tray, `${icon('anchor', 14)} The trail forks — <strong>tap a golden arrow</strong> · ${room.walk.steps} step${room.walk.steps === 1 ? '' : 's'} left.`);
    } else {
      trayHint(tray, `${icon('anchor', 14)} You press on through the trees…`);
    }
  } else if (room.phase === 'sail') {
    const bonus = me?.upgrades?.includes('sandals') ? ' <small>(+1 sandals)</small>' : '';
    trayHint(tray, room.walk
      ? `Rolled <strong>${room.die ?? '?'}</strong>${bonus} — <strong>tap a golden arrow</strong> to walk a trail, or tap a lit stop.`
      : `Rolled <strong>${room.die ?? '?'}</strong>${bonus} — ${foot ? 'walk' : 'sail'} exactly that far. Tap a glowing stop.`);
  } else if (world.arriving()) {
    // my own avatar is still moving up to this stop — hold the menu
    // (shrine wager / haven repair / trader's stall) until it arrives
    trayHint(tray, foot ? `${icon('anchor', 14)} Making your way…`
                        : `${icon('anchor', 14)} Making landfall…`);
  } else if (room.phase === 'shrine') {
    const node = nodeOf(me);
    const dom = node?.domain;
    const dinfo = dom ? room.board.domains[dom] : null;
    trayHint(tray, `Temple of <strong style="color:${DOMAIN_COLORS[dom] || 'var(--gilt)'}">` +
      `${esc(dinfo?.field || '?')}</strong> · ${node?.charges ?? 0} offering${node?.charges === 1 ? '' : 's'} left`);
    trayBtn(tray, 'Tier I<small>+1 scroll</small>', 'tier', () => send({ type: 'wager', tier: 1 }));
    trayBtn(tray, 'Tier II<small>+2 scrolls</small>', 'tier', () => send({ type: 'wager', tier: 2 }));
    trayBtn(tray, 'Tier III<small>+3 · miss loses 1</small>', 'tier hot', () => send({ type: 'wager', tier: 3 }));
    trayBtn(tray, 'pass', 'ghost', () => send({ type: 'pass' }));
  } else if (room.phase === 'haven') {
    const missing = me.max_hull - me.hull;
    const afford = Math.min(missing, me.scrolls);
    trayHint(tray, 'A quiet haven — checkpoint set. Repairs cost 1 scroll per hull.');
    trayBtn(tray, `REPAIR<small>+${afford} hull · ${afford} scroll${afford === 1 ? '' : 's'}</small>`, 'build',
            () => send({ type: 'repair' }), afford <= 0);
    trayBtn(tray, 'pass', 'ghost', () => send({ type: 'pass' }));
  } else if (room.phase === 'shop') {
    trayHint(tray, 'A market isle — the trader spreads his wares.');
    if (shopClosed) trayBtn(tray, 'BROWSE THE STALL', 'build', () => { shopClosed = false; renderShop(); });
    trayBtn(tray, 'set sail on', 'ghost', () => send({ type: 'pass' }));
  } else if (room.phase === 'pharos') {
    const need = room.config?.relics_to_win ?? 3;
    const seals = Math.min(me?.banked ?? 0, need);
    if (seals >= need && room.pharos_open) {
      // the tower door: ENTER plays the seal ceremony, then steps you through
      // into the final trial against the Dark Presence
      trayHint(tray, `${icon('crown', 15)} The Pharos looms — set your ${seals} seal${seals === 1 ? '' : 's'} and enter the tower.`);
      trayBtn(tray, `${icon('crown', 14)} ENTER THE PHAROS`, 'gold big', () => {
        if (pharosCeremonyRunning) return;
        playPharosCeremony(seals, () => send({ type: 'pharos_enter' }));
      });
    } else {
      // anyone may land on the shore — but the door is just sealed bronze:
      // three empty sockets, no handle, no way in
      trayHint(tray, `${icon('crown', 15)} The great door is SEALED — three empty sockets stare back. (${seals}/${need} seals banked)`);
      trayBtn(tray, 'TURN AWAY', 'gold big', () => send({ type: 'pass' }));
    }
  }
}

/* ── shop bottom sheet ──────────────────────────────────────────────────── */
/* Two stalls: the LAND market (phase 'shop' — full stock incl. fittings and
   legendary relics) and the SHIP'S TRADER (opened from the roll tray —
   consumables only, the shipwright stays ashore). */
function renderShop() {
  const panel = $('shopPanel');
  // the ship's trader answers in the TRADE beat at the end of your turn —
  // never before you roll, never during someone else's
  const remote = shopRemote && room.phase === 'trade' && room.turn === you
    && !world.arriving();
  const mine = remote ||
    (room.phase === 'shop' && room.turn === you && !world.arriving());
  if (room.phase !== 'trade') shopRemote = false;
  if (!mine || shopClosed) {
    panel.classList.add('hidden');
    updateMapTab(null, false);
    if (room.phase !== 'shop') shopClosed = false;
    return;
  }
  const me = room.players.find((p) => p.pid === you);
  const cap = room.config?.item_cap ?? 2;
  const stock = Object.entries(room.config?.shop_items || {})
    .filter(([id]) => !remote || id !== 'fitting');
  const relics = remote ? {} : (room.config?.relics || {});
  const owns = new Set(me.upgrades || []);
  panel.classList.remove('hidden');
  const shopRows = stock.map(([id, it]) => {
    const n = me.items?.[id] ?? 0;
    const capped = id !== 'fitting' && n >= cap;
    const owned = id === 'fitting'
      ? `${(me.upgrades || []).length} fitted`
      : `carried ×${n}/${cap}`;
    const cant = capped || me.scrolls < it.cost;
    return `<div class="shoprow ${cant ? 'cant' : ''}">
      <span class="sicon">${icon(SHOP_ICON[id] || 'relic')}</span>
      <div><div class="sname">${esc(it.name)}</div>
        <div class="sdesc">${esc(it.desc)} · ${owned}</div></div>
      <span class="price">${capped ? 'FULL' : `${it.cost} ${icon('scroll', 11)}`}</span>
      <button class="buy" data-item="${id}" ${cant ? 'disabled' : ''}>Buy</button>
    </div>`;
  }).join('');
  const relicRows = Object.entries(relics).map(([id, it]) => {
    const have = owns.has(id);
    const cant = !have && me.scrolls < it.cost;
    return `<div class="shoprow relicrow ${have ? 'have' : ''} ${cant ? 'cant' : ''}">
      <span class="sicon">${icon(SHOP_ICON[id] || 'relic')}</span>
      <div><div class="sname">${esc(it.name)}</div>
        <div class="sdesc">${esc(it.desc)}</div></div>
      ${have
        ? '<span class="price owned">Aboard</span>'
        : `<span class="price">${it.cost} ${icon('scroll', 11)}</span>
           <button class="buy" data-item="${id}" ${cant ? 'disabled' : ''}>Buy</button>`}
    </div>`;
  }).join('');
  // a little map symbol on the stall — the trader's chart to the Sword of
  // Damocles islet. Ashore only, and only until you bear the sword. Buying it
  // (30 scrolls) marks the islet with a permanent X on YOUR board map. The tab
  // itself is a persistent body-level element (see updateMapTab) so its
  // pull-out state survives the panel re-render.
  panel.innerHTML =
    `<div class="stallhead">${icon('market')} ${remote ? "Ship's Trader" : "Trader's Stall"}` +
    `<em>your scrolls: ${me.scrolls}</em>` +
    `<button class="kick" id="shopClose" title="Close">${icon('kick', 12)}</button></div>` +
    (remote ? `<div class="stallnote">Charms only at sea — the shipwright's fittings and relics are sold ashore.</div>` : '') +
    shopRows +
    (relicRows ? `<div class="relicsplit">${icon('relic', 12)} Legendary Relics</div>${relicRows}` : '');
  updateMapTab(me, !remote && !owns.has('sword_of_damocles'));
  $('shopClose').onclick = () => {
    if (remote) shopRemote = false; else shopClosed = true;
    updateMapTab(null, false);
    renderShop(); renderTray();
  };
  panel.querySelectorAll('.buy').forEach((b) => {
    b.onclick = () => { audio.sfx.build(); send({ type: 'shop_buy', item: b.dataset.item }); };
  });
}

/* the trader's chart: a scrap of paper peeking from UNDER the stall's top-right
 * corner. Click it → the trader's price (a charge prompt) → the chart unfolds to
 * screen-centre as a dashed "X marks the spot" map → click that and the stall
 * slides aside, your board map opens, and the X descends onto the islet.
 * Body-level + a rAF tracker so it stays glued under the corner through the
 * panel's slide-in and its frequent re-renders. */
let mapTabEl = null;
let mapTabRAF = 0;
let swordDropSeen = true;                 // set false to arm the X's descend on the next map open
function positionMapTab() {
  const panel = $('shopPanel');
  if (!mapTabEl || !mapTabEl.parentNode || !panel || panel.classList.contains('hidden')) {
    mapTabRAF = 0;                                   // stop — the tab is gone
    return;
  }
  const r = panel.getBoundingClientRect();
  mapTabEl.style.left = (r.right - 27) + 'px';
  mapTabEl.style.top = (r.top - 4) + 'px';
  mapTabRAF = requestAnimationFrame(positionMapTab);
}
function updateMapTab(me, show) {
  if (!show || !me) {
    if (mapTabEl && mapTabEl.parentNode) mapTabEl.remove();
    return;
  }
  if (!mapTabEl) {
    mapTabEl = document.createElement('button');
    mapTabEl.id = 'mapTab';
    mapTabEl.onclick = onMapTabClick;
  }
  const tab = mapTabEl;
  if (tab.parentNode !== document.body) document.body.appendChild(tab);
  const bought = !!me.map_bought;
  tab.className = 'mapTab' + (bought ? ' got' : '');
  tab.style.setProperty('--pull', 0);                // always tucked under the corner
  tab.innerHTML = icon(bought ? 'compass' : 'scroll', 15);
  tab.title = bought
    ? 'Your chart — open the map (an X marks the islet)'
    : 'A scrap of paper pokes from under the corner…';
  positionMapTab();                                   // place it right away, then keep tracking
}
function onMapTabClick() {
  const me = room?.players?.find((p) => p.pid === you);
  if (!me) return;
  // a little tug first — the paper wiggles free before it opens
  const tab = document.getElementById('mapTab');
  if (tab) { tab.classList.remove('wiggle'); void tab.offsetWidth; tab.classList.add('wiggle'); }
  audio.sfx?.click?.();
  setTimeout(() => {
    const m = room?.players?.find((p) => p.pid === you) || me;
    if (m.map_bought) openBoardChart();              // already paid — straight to your map
    else showChartPrompt(m);
  }, 340);
}
/* the trader names his price */
function showChartPrompt(me) {
  if (document.getElementById('chartPrompt')) return;
  const can = (me.scrolls ?? 0) >= 30;
  const d = document.createElement('div');
  d.id = 'chartPrompt'; d.className = 'chartov';
  d.innerHTML =
    `<div class="chartcard">` +
    `<div class="cc-kick">${icon('scroll', 16)} The trader's chart</div>` +
    `<p>The trader lays a hand on the rolled paper. <em>“Thirty scrolls, captain — ` +
    `then the mark is yours to read.”</em></p>` +
    `<div class="cc-btns">` +
    `<button class="cc-pay" ${can ? '' : 'disabled'}>Pay 30 ${icon('scroll', 13)}</button>` +
    `<button class="cc-no">Not now</button></div>` +
    (can ? '' : `<div class="cc-note">You lack the scrolls (you have ${me.scrolls}).</div>`) +
    `</div>`;
  document.body.appendChild(d);
  const close = () => d.remove();
  d.querySelector('.cc-no').onclick = close;
  d.addEventListener('pointerdown', (e) => { if (e.target === d) close(); });
  if (can) d.querySelector('.cc-pay').onclick = () => {
    audio.sfx.build();
    send({ type: 'buy_map' });
    close();
    openTreasureMap();
  };
}
/* the chart unfolds to screen-centre: a dashed trail to a red X */
function openTreasureMap() {
  if (document.getElementById('treasureMap')) return;
  const d = document.createElement('div');
  d.id = 'treasureMap'; d.className = 'chartov';
  d.innerHTML =
    `<div class="tm-sheet">` +
    `<svg class="tm-art" viewBox="0 0 300 200" aria-hidden="true">` +
    // faint sea hatching
    `<path class="tm-wave" d="M28 34 q7 -6 14 0 t14 0 M40 168 q7 -6 14 0 t14 0"/>` +
    // the islet — an irregular, hand-drawn coastline (a random island shape)
    `<path class="tm-isle" d="M214 62 C 238 58 248 76 262 82 C 276 90 270 108 256 110 C 268 124 254 140 238 134 C 230 148 206 148 198 136 C 180 144 162 132 170 116 C 154 110 158 88 176 88 C 184 70 200 64 214 62 Z"/>` +
    // the dashed trail wandering from the landing to the shore
    `<path class="tm-trail" d="M36 168 C 82 144, 62 100, 116 96 S 168 116, 190 108"/>` +
    `<circle class="tm-start" cx="36" cy="168" r="5"/>` +
    // the spot: a ring with the X centred on it
    `<circle class="tm-ring" cx="214" cy="104" r="21"/>` +
    `<g class="tm-x" transform="translate(214 104)"><path d="M-11 -11 L11 11 M11 -11 L-11 11"/></g>` +
    // a compass rose, top-left
    `<g class="tm-rose" transform="translate(50 48)">` +
    `<circle class="tm-rose-o" r="18"/>` +
    `<path class="tm-rose-a" d="M0 -23 L5 0 L0 23 L-5 0 Z M-23 0 L0 -5 L23 0 L0 5 Z"/>` +
    `<circle r="2.4" class="tm-rose-c"/></g>` +
    `</svg>` +
    `<div class="tm-cap">✕ marks the spot — a lone islet in the Isles of Peace.</div>` +
    `<div class="tm-hint">click the chart to plot it on your map</div>` +
    `</div>`;
  document.body.appendChild(d);
  audio.sfx?.oracle?.();
  const sheet = d.querySelector('.tm-sheet');
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('in')));
  sheet.onclick = () => { d.remove(); openBoardChart(); };
}
/* the stall slides aside, your board map opens, the X drops onto the islet */
function openBoardChart() {
  const tm = document.getElementById('treasureMap'); if (tm) tm.remove();
  swordDropSeen = false;                              // let the descend animation play
  document.body.classList.add('shop-aside');         // move the shop box out of the way
  toggleMap(true);
}

/* The WIN cinematic — the Dark Presence falls: darkness pours out of the
   Pharos in streaming wisps, then the whole screen floods to blinding white,
   and out of the white the leaderboard rises. Plays once, then hands off to
   buildVictoryBoard(). */
function playVictoryCinematic(onDone) {
  if (document.getElementById('victoryCine')) return;
  // the win screen owns the frame — clear the lobby menu out from behind it
  $('lobby').classList.add('hidden');
  $('hud').classList.add('hidden');
  const wisps = Array.from({ length: 10 },
    (_, i) => `<span class="vc-wisp" style="--w:${i}"></span>`).join('');
  const d = document.createElement('div');
  d.id = 'victoryCine';
  d.innerHTML =
    `<div class="vc-dark"></div>` +
    `<div class="vc-wisps">${wisps}</div>` +
    `<div class="vc-white"></div>`;
  document.body.appendChild(d);
  audio.sfx?.roar?.();                                // the tower disgorges its dark
  setTimeout(() => d.classList.add('flash'), 1500);  // …then the flood to white
  setTimeout(() => { onDone?.(); }, 2600);           // board rises out of the white
  setTimeout(() => d.classList.add('clear'), 2900);  // white recedes to reveal it
  setTimeout(() => d.remove(), 4400);
}

/* ── the Sword of Damocles claim: guardians down → the blade draws from the
 * stone, flares, and a card names the prize ─────────────────────────────── */
let swordClaimShown = false;
function maybeSwordClaim() {
  // the reveal is broadcast to everyone — but only the captain who drew the
  // blade (whose turn the fight is) gets the claim cinematic
  const claimed = room && room.phase === 'reveal' && room.turn === you
    && room.reveal?.kind === 'battle' && room.reveal?.sword_claimed;
  if (!claimed || swordClaimShown) return;
  swordClaimShown = true;                       // once per game — the sword is unique
  playSwordClaim();
}
function playSwordClaim() {
  if (document.getElementById('swordClaim')) return;
  const d = document.createElement('div');
  d.id = 'swordClaim';
  const rays = Array.from({ length: 12 }, (_, i) => `<span class="sc-ray" style="--r:${i}"></span>`).join('');
  d.innerHTML =
    `<div class="sc-scene">` +
    `<div class="sc-rays">${rays}</div>` +
    `<svg class="sc-blade" viewBox="0 0 40 150" aria-hidden="true">` +
    // pommel + grip + crossguard + long tapering blade with a fuller line
    `<circle cx="20" cy="12" r="4.5"/>` +
    `<rect x="18" y="14" width="4" height="16"/>` +
    `<rect x="6" y="29" width="28" height="5" rx="2.5"/>` +
    `<path d="M13 34 H27 L21.5 132 Q20 140 20 140 Q20 140 18.5 132 Z"/>` +
    `<line class="sc-fuller" x1="20" y1="37" x2="20" y2="126"/></svg>` +
    `<div class="sc-stone"></div>` +
    `<div class="sc-flash"></div></div>` +
    `<div class="sc-card">` +
    `<div class="sc-kicker">${icon('sword', 18)} A prize claimed</div>` +
    `<h2>The Sword of Damocles</h2>` +
    `<p>You wrench it free of the weathered stone — its edge takes the light and holds it.</p>` +
    `<p class="sc-hint">It hangs by a thread over any who would rule. Keep it for the Dark Presence — a third way to strike in the final fight.</p>` +
    `<button class="sc-ok act gold">Bear it away</button></div>`;
  document.body.appendChild(d);
  audio.sfx?.oracle?.();
  setTimeout(() => d.classList.add('drawn'), 350);                       // the blade rises
  setTimeout(() => { d.classList.add('shine'); audio.sfx?.victory?.(); }, 1250);  // it flares
  setTimeout(() => d.classList.add('named'), 1750);                      // the card slides in
  const done = () => d.remove();
  d.querySelector('.sc-ok').onclick = done;
  d.addEventListener('pointerdown', (e) => { if (e.target === d) done(); });
}

/* ── the VICTORY screen: a real curtain call, not a cut-away ────────────── */
let victoryShown = false;
function renderVictory() {
  if (!room || room.phase !== 'finished' || !room.winner) {
    document.getElementById('victoryOv')?.remove();
    document.getElementById('victoryCine')?.remove();
    victoryShown = false;
    return;
  }
  if (victoryShown) return;
  victoryShown = true;
  // darkness out of the Pharos → fade to white → the board rises
  playVictoryCinematic(() => buildVictoryBoard());
}

/* what each captain finished the voyage holding — revealed by tapping a row */
function playerLootHtml(p) {
  const ui = room.upgrade_info || {};
  const shop = room.config?.shop_items || {};
  // never leak a raw snake_case id: fall back to a title-cased label
  const pretty = (id) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const ups = (p.upgrades || []).map((id) => esc(ui[id]?.name || pretty(id)));
  const items = Object.entries(p.items || {}).filter(([, n]) => n > 0)
    .map(([id, n]) => `${esc(shop[id]?.name || pretty(id))} ×${n}`);
  const line = (ic, label, val) =>
    `<span class="vk">${icon(ic, 12)} ${label}</span><span class="vv">${val}</span>`;
  return `<div class="vdet-grid">
      ${line('relic', 'Sigils', `${p.banked || 0} banked · ${p.cargo || 0} aboard`)}
      ${line('scroll', 'Scrolls', p.scrolls || 0)}
      ${line('hull', 'Hull', `${p.hull}/${p.max_hull}`)}
      ${line('fitting', 'Fittings & relics', ups.length ? ups.join(', ') : '—')}
      ${line('market', 'Items', items.length ? items.join(', ') : '—')}
    </div>`;
}

function buildVictoryBoard() {
  if (!room || room.phase !== 'finished' || !room.winner) return;
  if (document.getElementById('victoryOv')) return;
  $('lobby').classList.add('hidden');               // no menu behind the board
  $('hud').classList.add('hidden');
  const w = room.players.find((p) => p.pid === room.winner);
  const sig = (p) => (p.banked || 0) + (p.cargo || 0);
  // the winner is pinned to #1 (they took the tower first); the rest rank on
  // sigils held, then scrolls
  const ranked = [...room.players].sort((a, b) => {
    if (a.pid === room.winner) return -1;
    if (b.pid === room.winner) return 1;
    return (sig(b) - sig(a)) || (b.scrolls - a.scrolls);
  });
  const rows = ranked.map((p, i) => `
      <div class="vrow ${p.pid === room.winner ? 'vwin' : ''}" data-pid="${p.pid}" tabindex="0">
        <div class="vrow-head">
          <span class="vrank">${p.pid === room.winner ? icon('crown', 15) : i + 1}</span>
          <span class="vdot" style="background:${p.color}"></span>
          <span class="vname">${esc(p.name)}${p.bot ? ' <small>(bot)</small>' : ''}</span>
          <span class="vstat">${sig(p)} ${icon('relic', 12)}</span>
          <span class="vstat">${p.scrolls} ${icon('scroll', 12)}</span>
          <span class="vchev">▾</span>
        </div>
        <div class="vdet">${playerLootHtml(p)}</div>
      </div>`).join('');
  const d = document.createElement('div');
  d.id = 'victoryOv';
  d.innerHTML =
    `<div class="vwrap">
      <div class="vlaurel">${icon('crown', 52)}</div>
      <div class="vtitle">VICTORY</div>
      <div class="vsub"><strong style="color:${w?.color || 'var(--gilt)'}">${esc(w?.name || '?')}</strong>
        takes the Pharos — the sea is theirs</div>
      <div class="vhint">tap a captain to see what they carried home</div>
      <div class="vboard">${rows}</div>
      <div class="vbtns">
        ${you === room.host
          ? '<button id="vRematch" class="vgold">NEW VOYAGE</button>'
          : '<div class="vwait">the host may call a new voyage</div>'}
        <button id="vHide" class="vghost">gaze upon the sea</button>
      </div>
    </div>`;
  document.body.appendChild(d);
  d.querySelectorAll('.vrow').forEach((row) => {
    const toggle = () => row.classList.toggle('open');
    row.querySelector('.vrow-head').onclick = toggle;
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  const r = document.getElementById('vRematch');
  if (r) r.onclick = () => send({ type: 'rematch' });
  document.getElementById('vHide').onclick = () => d.classList.add('vpeek');
  // (the victory sting already rang at the win; the cinematic owns the audio)
}

/* ── item belt (bottom-right) ───────────────────────────────────────────── */
function itemLegal(id, me) {
  const mine = room.turn === you;
  if (!mine) return false;
  switch (id) {
    case 'planks':
      return me.hull < me.max_hull &&
        ['roll', 'sail', 'battle', 'shrine', 'haven', 'shop', 'trade'].includes(room.phase);
    case 'gale': return room.phase === 'roll' || room.phase === 'trade';
    case 'horn': return room.phase === 'battle' && !!room.battle && !room.battle.horn;
    case 'hint':
      return room.phase === 'question' && !!room.question &&
        !(room.question.disabled || []).length && (room.question.options || []).length > 2;
    case 'aegis_charm': return false;       // wards on its own
    default: return false;
  }
}

function renderItembelt() {
  const belt = $('itembelt');
  belt.innerHTML = '';
  const me = room.players.find((p) => p.pid === you);
  if (!me) return;
  const stock = room.config?.shop_items || {};
  for (const id of ITEM_ORDER) {
    const n = me.items?.[id] ?? 0;
    if (n <= 0) continue;
    const b = document.createElement('button');
    b.className = 'itemslot';
    b.disabled = !itemLegal(id, me);
    b.title = (stock[id]?.name || id) + ' — ' + (stock[id]?.desc || '') +
      (id === 'aegis_charm' ? ' (triggers on its own)' : '');
    b.innerHTML = icon(SHOP_ICON[id] || 'relic') + `<span class="count">${n}</span>`;
    b.onclick = () => send({ type: 'use', item: id });
    belt.appendChild(b);
  }
}

/* ── battle screen ──────────────────────────────────────────────────────── */
function hpBar(cur, max, cls) {
  // cap the pip count so a big-health boss (the Dark Presence) doesn't overflow
  // the card — past this each pip stands for several points, filled
  // proportionally. 18 is the most foe cells that fit the card on ONE row.
  const N = Math.min(max, 18);
  const on = max <= N ? cur : Math.ceil((cur / max) * N);
  const cells = Array.from({ length: N }, (_, i) =>
    `<span class="hpcell ${i < on ? 'on' : ''}"></span>`).join('');
  return `<div class="hpbar ${cls}">${cells}</div>`;
}

function heartRow(cur, max) {
  const hearts = Array.from({ length: max }, (_, i) =>
    `<span class="heart ${i < cur ? '' : 'lost'}">${icon('heart', 20)}</span>`).join('');
  return `<div class="heartrow" title="Health ${cur}/${max}">${hearts}</div>`;
}

function battleView() {
  if (room.phase === 'reveal' && room.reveal?.kind === 'battle'
      && bEnemyFrozen && bPreReveal) {
    return bPreReveal;      // hold the enemy HP until the strike lands
  }
  if (room.battle) { lastBattleSnap = room.battle; return room.battle; }
  /* the killing-blow reveal: room.battle is gone, keep showing the corpse */
  if (room.phase === 'reveal' && room.reveal?.kind === 'battle') {
    if (room.reveal.monster) return room.reveal.monster;
    if (lastBattleSnap) {
      const ep = room.reveal.enemy_phase || {};
      const b = JSON.parse(JSON.stringify(lastBattleSnap));
      if (ep.dealt > 0 && b.enemies[ep.target_idx ?? 0]) {
        b.enemies[ep.target_idx ?? 0].hp =
          Math.max(0, b.enemies[ep.target_idx ?? 0].hp - ep.dealt);
      }
      return b;
    }
  }
  return null;
}

function sendMove(stance, target, mode) {
  pendingMove = null;
  pendingHeal = false;
  myStance = stance;
  world.battlePlay('targeted', { idx: null });
  send({ type: 'stance', stance, target: target ?? 0, ...(mode ? { mode } : {}) });
}

function renderBattle() {
  const hud = $('battleHud');
  const b = battleView();
  // hold the whole battle screen until the boat has sailed up to the island
  const show = b && (['battle', 'question', 'reveal', 'dodge', 'jchoose'].includes(room.phase) ||
      (room.phase === 'minigame' && room.minigame?.battle)) &&
    (room.phase !== 'reveal' || room.reveal?.kind === 'battle') &&
    !world.arriving();
  hud.classList.toggle('hidden', !show);
  document.body.classList.toggle('battling', !!show);
  if (!show) { pendingMove = null; return; }

  const mine = room.turn === you;
  const dcolor = DOMAIN_COLORS[b.domain] || '#c0392b';
  const fighter = room.players.find((p) => p.pid === room.turn);
  const alive = b.enemies.filter((e) => e.hp > 0);
  const heavyEvery = room.config?.heavy_every ?? 3;

  /* boss banner */
  const mark = b.is_pharos ? 'home' : b.boss ? 'crown' : b.is_lair ? 'skull' : 'strike';
  let roundPips = '';
  if (b.boss) {
    const step = (b.round ?? 0) % heavyEvery;
    roundPips = '<span class="roundpips" title="A heavy blow lands when the cycle fills">' +
      Array.from({ length: heavyEvery }, (_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('') +
      '</span>';
  }
  // the subtitle no longer names a question CATEGORY (battles draw general
  // trivia / Jeopardy now — the domain-themed category is deprecated)
  const subParts = [];
  if (b.boss) subParts.push('BOSS');
  if (b.is_lair) subParts.push('your trial');
  if (b.region) subParts.push(esc(REALM_INFO[b.region]?.name || ''));
  $('bfoe').innerHTML =
    `<div class="btitle">${icon(mark, 26)} ${esc(b.name)}</div>` +
    `<div class="bsub" style="color:${dcolor}">${subParts.join(' · ')}</div>` +
    (b.boss ? roundPips : '') +
    (b.escalation > 0 ? ` <span class="escalated" title="A rival already felled this guardian — it rises harder for you. Reach the trial first to face its weakest form.">Risen ×${b.escalation}</span>` : '') +
    (b.charging
      ? `<div class="chargewarn">${icon('guard', 13)} CHARGING — a heavy blow comes. Dodge it.</div>`
      : '');

  /* enemy cards — fat HP cells only; the count reads from the cells */
  const cards = b.enemies.map((e, i) => `
    <div class="ecard ${e.hp <= 0 ? 'dead' : ''} ${pendingMove && e.hp > 0 ? 'targetable' : ''}" data-idx="${i}">
      ${b.boss ? '' : `<div class="ename">${esc(e.name)}</div>`}
      ${hpBar(e.hp, e.max_hp, 'foe')}
      <div class="epow">power <span class="powpips">${'<i></i>'.repeat(Math.max(1, Math.min(6, e.power)))}</span></div>
    </div>`).join('');
  $('bmon').innerHTML = `<div class="erow">${cards}</div>`;
  $('bmon').querySelectorAll('.ecard.targetable').forEach((el) => {
    const i = parseInt(el.dataset.idx, 10);
    el.onclick = () => sendMove(pendingMove, i);
    el.onmouseenter = () => world.battlePlay('targeted', { idx: i });
  });

  /* beat line — the reveal choreography owns it during reveals */
  if (room.phase === 'battle') {
    setBTurn(pendingMove
      ? `${icon('compass', 15)} CHOOSE A TARGET`
      : pendingHeal
        ? `${icon('heart', 15)} CHOOSE YOUR CHALLENGE`
        : (mine ? `${icon('strike', 15)} YOUR MOVE` : `${esc(fighter?.name || '')}'s move…`));
  } else if (room.phase === 'question') {
    setBTurn(mine ? '' : `${esc(fighter?.name || '')} faces the question…`);
  }

  /* hero health — hearts, so it never reads like the enemy's HP bar. During a
   * reveal, hold at the pre-hit count until the blow lands (see bHullShown). */
  const shownHull = (room.phase === 'reveal' && bHullShown != null) ? bHullShown : fighter?.hull;
  $('bship').innerHTML = fighter ? `
    <div class="bsub"><strong>${esc(fighter.name)}</strong></div>
    ${heartRow(shownHull, fighter.max_hull)}` : '';

  /* stance dock */
  const actions = $('bactions');
  actions.innerHTML = '';
  if (room.phase !== 'battle' || !mine) return;

  const me = room.players.find((p) => p.pid === you);
  const mk = (html, cls, fn, title = '', disabled = false) => {
    const bt = document.createElement('button');
    bt.className = cls;
    bt.innerHTML = html;
    bt.title = title;
    bt.disabled = disabled;
    bt.onclick = fn;
    actions.appendChild(bt);
    return bt;
  };
  const move = (stance) => {
    if (alive.length > 1 && stance !== 'guard') {
      pendingMove = stance;
      renderBattle();
    } else {
      sendMove(stance, b.enemies.findIndex((e) => e.hp > 0));
    }
  };
  // HEAL picks its FORMAT first — a sub-menu of the three question kinds
  // replaces the stance buttons; tapping one casts the mending hymn that way
  if (pendingHeal) {
    const heals = (me?.upgrades || []).includes('ambrosia') ? 3 : 1;
    mk(`${icon('strike', 16)} MULTIPLE CHOICE`, 'battlebtn heal',
       () => sendMove('heal', 0, 'mc'), `A Tier III trivia question · heal ${heals}`);
    mk(`${icon('scroll', 16)} JEOPARDY`, 'battlebtn heal',
       () => sendMove('heal', 0, 'jeopardy'), `Pick a Jeopardy clue · heal ${heals}`);
    mk(`${icon('fitting', 16)} PUZZLE`, 'battlebtn heal',
       () => sendMove('heal', 0, 'puzzle'), `A combat puzzle · heal ${heals}`);
    mk('cancel', 'battlebtn ghost', () => { pendingHeal = false; renderBattle(); });
    return;
  }
  const st = TIER_ROMAN[b.strike_tier] || 'I';
  const darkLord = !!b.is_pharos;
  mk(`${icon('strike', 18)} STRIKE<span class="tierchip">${st}</span>`,
     'battlebtn strike', () => move('attack'),
     darkLord ? 'Tier II question · chips the Dark Lord for 1 (no bonuses apply)'
              : `Tier ${st} question · 1 damage${b.horn ? ' · the horn adds +2' : ''}`);
  mk(`${icon('magic', 18)} MAGIC<span class="tierchip">III</span>`,
     'battlebtn magic', () => move('magic'),
     'Tier III question · 3 damage · a miss backfires for 1');
  // HEAL — a mending hymn: pick your field, answer a Tier III question, knit the hull
  mk(`${icon('heart', 18)} HEAL<span class="tierchip">III</span>`,
     'battlebtn heal', () => { pendingHeal = true; renderBattle(); },
     `Tier III question — you pick the field · heals ${(me?.upgrades || []).includes('ambrosia') ? 3 : 1}`);
  // the Sword of Damocles: a third option, but only against the Dark Presence
  if (b.is_pharos && (me?.upgrades || []).includes('sword_of_damocles')) {
    mk(`${icon('sword', 18)} SWORD<span class="tierchip">III</span>`,
       'battlebtn sword', () => move('sword'),
       'Sword of Damocles · Tier III question · 5 damage · no backfire');
  }
  if (!b.boss) {
    const fleeCost = room.config?.flee_cost ?? 2;
    // .flee carries a spacer gap: butted against GUARD it was the #1
    // fat-finger complaint — an accidental flee costs scrolls AND a free hit
    mk(`${icon('flee', 16)} FLEE`, 'battlebtn ghost flee', () => send({ type: 'flee' }),
       `${fleeCost} scroll${fleeCost === 1 ? '' : 's'} · 50/50 escape — fail and the front enemy strikes free`,
       (me?.scrolls ?? 0) < fleeCost);
  }
  if ((me?.items?.horn || 0) > 0 && !b.horn) {
    mk(icon('horn') + `<span class="count">${me.items.horn}</span>`, 'itemslot',
       () => send({ type: 'use', item: 'horn' }), 'War Horn — +2 on your next STRIKE');
  }
  if ((me?.items?.planks || 0) > 0 && me.hull < me.max_hull) {
    mk(icon('planks') + `<span class="count">${me.items.planks}</span>`, 'itemslot',
       () => send({ type: 'use', item: 'planks' }),
       `Pitch & Planks — patch ${room.config?.planks_heal ?? 3} hull now`);
  }
  if (pendingMove) {
    mk('cancel', 'battlebtn ghost', () => {
      pendingMove = null;
      world.battlePlay('targeted', { idx: null });
      renderBattle();
    });
  }
}

/* ── question scroll ────────────────────────────────────────────────────── */
function renderQuestion() {
  const modal = $('qmodal');
  // a battle reveal drops its card fast so the diorama attack plays clean
  const isQ = (room.phase === 'question' && !world.arriving()) ||
    (room.phase === 'reveal' && room.reveal && !revealCardDropped &&
     room.reveal.chosen !== -2);      // puzzle rounds have no card to show
  modal.classList.toggle('hidden', !isQ);
  const battleQ = (room.question?.kind ?? room.reveal?.kind) === 'battle';
  modal.classList.toggle('clear', !!(isQ && battleQ));   // don't dim the diorama
  if (!isQ) { cancelAnimationFrame(timerRAF); return; }

  const q = room.question;
  const rv = room.phase === 'reveal' ? room.reveal : null;
  const typed = !!(q?.typed || rv?.typed);            // a JEOPARDY! clue: you type it
  const ctxDomain = q?.domain ?? rv?.domain;
  const ctxKind = q?.kind ?? rv?.kind;
  // typed JEOPARDY! clues wear the HUD's own bronze header (empty = fall back to
  // the #qhead stylesheet gradient) — not the TV-show blue, and not a flat slab
  // that fights the notched frame at the corners
  const dcolor = typed ? '' : (ctxDomain ? DOMAIN_COLORS[ctxDomain] : '#7d5ba6');
  const dinfo = ctxDomain ? room.board.domains[ctxDomain] : null;

  $('qhead').style.background = dcolor;
  if (typed) {
    $('qkind').textContent = `Jeopardy! · ${q?.category || rv?.category || ''}`.trim();
    $('qdomain').textContent = 'Type your answer';
  } else {
    $('qkind').textContent = ctxKind === 'shrine'
      ? `${KIND_LABEL.shrine} · Tier ${TIER_ROMAN[q?.tier ?? 1] || ''}`
      : ctxKind === 'battle'
        ? `Battle · Tier ${TIER_ROMAN[q?.tier ?? rv?.tier ?? 1] || 'I'}`
        : (KIND_LABEL[ctxKind] || 'Challenge');
    $('qdomain').textContent = dinfo ? `${dinfo.name} · ${dinfo.field}` : 'Wits & Logic';
  }

  /* battle trinkets (owl / lyre) + the carried hint stone */
  const itemsRow = $('qitems');
  itemsRow.innerHTML = '';
  const me = room.players.find((p) => p.pid === you);
  if (room.phase === 'question' && ctxKind === 'battle' && room.turn === you && me && room.battle) {
    for (const item of (typed ? ['lyre'] : ['owl', 'lyre'])) {   // Owl can't narrow a typed clue
      if (me.upgrades.includes(item) && !room.battle.used_items.includes(item)) {
        const b = document.createElement('button');
        b.className = 'itembtn';
        b.innerHTML = icon(item, 15) + (item === 'owl' ? ' Owl · rule out 2' : ' Lyre · new question');
        b.onclick = () => send({ type: 'item', id: item });
        itemsRow.appendChild(b);
      }
    }
  }
  if (room.phase === 'question' && room.turn === you && me &&
      (me.items?.hint || 0) > 0 && q &&
      !(q.disabled || []).length && (q.options || []).length > 2) {
    const b = document.createElement('button');
    b.className = 'itembtn';
    b.innerHTML = icon('hint', 15) + ` Hint Stone · remove 2 wrong · ×${me.items.hint}`;
    b.onclick = () => send({ type: 'use', item: 'hint' });
    itemsRow.appendChild(b);
  }

  if (!q && !rv) {
    $('qtext').textContent = 'A herald fetches the question…';
    $('qopts').innerHTML = '';
    $('qnote').textContent = '';
    return;
  }

  const mine = room.turn === you;
  const amPlayer = !!me;
  if (room.phase === 'question' && typed) {
    $('qtext').textContent = q.text;
    renderTypedQuestion(q, mine);
    startTimerBar(q.deadline, '#qtimerBar');
    return;
  }
  if (room.phase === 'question') {
    const qkey = `${q.text}`.slice(0, 40);
    if (sideKey !== qkey) { sideKey = qkey; mySideAnswer = null; }
    $('qtext').textContent = q.text;
    const opts = $('qopts');
    opts.dataset.tkey = '';
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
        ? (alreadySide ? 'Answer locked in — right pays a scroll.' : 'Answer too! Correct pays a scroll.')
        : `${room.players.find((p) => p.pid === room.turn)?.name || ''} is answering…`);
    startTimerBar(q.deadline, '#qtimerBar');
  } else {
    cancelAnimationFrame(timerRAF);
    $('qtimerBar').style.width = '0%';
    if (typed) {
      if (rv.text || q?.text) $('qtext').textContent = rv.text || q.text;
      const opts = $('qopts');
      opts.dataset.tkey = '';
      opts.innerHTML =
        `<div class="typedreveal ${rv.was_correct ? 'good' : 'bad'}">` +
        `<span class="tlabel">${rv.was_correct ? 'Correct' : 'The answer'}</span>` +
        `<span class="tans">${esc(rv.answer_text || '')}</span></div>`;
      $('qnote').textContent = stripEmoji(rv.note || '');
      mySideAnswer = null;
      return;
    }
    const opts = $('qopts');
    [...opts.children].forEach((b, i) => {
      b.disabled = true;
      if (i === rv.correct) b.classList.add('good');
      else if (i === rv.chosen) b.classList.add('bad');
      if (mySideAnswer === i && i !== rv.correct) b.classList.add('bad');
    });
    let note = rv.was_correct ? 'Correct! ' : (rv.chosen === -1 ? 'Time expired. ' : 'Wrong. ');
    note += stripEmoji(rv.note || '');
    const sideMine = rv.side?.[you];
    if (sideMine) note += sideMine.ok ? ' (Your side answer pays a scroll!)' : ' (Your side answer missed.)';
    $('qnote').textContent = note;
    mySideAnswer = null;
  }
}

/* a typed JEOPARDY! clue — 20 seconds to type the answer (no reading lock).
   Rebuild only when the clue changes, so live re-renders never wipe typing. */
let readTimer = 0;
function renderTypedQuestion(q, mine) {
  const opts = $('qopts');
  const key = 'typed:' + `${q.text}`.slice(0, 80);
  if (!mine) {
    opts.dataset.tkey = key;
    opts.innerHTML = '';
    $('qnote').textContent =
      `${room.players.find((p) => p.pid === room.turn)?.name || 'The captain'} is answering…`;
    return;
  }
  if (opts.dataset.tkey === key && opts.querySelector('#qtypedInput')) return;  // keep typing
  opts.dataset.tkey = key;
  opts.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'typedwrap';
  const input = document.createElement('input');
  input.id = 'qtypedInput';
  input.type = 'text';
  input.className = 'typedinput';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.placeholder = 'type your answer…';
  const btn = document.createElement('button');
  btn.className = 'opt typedgo';
  btn.textContent = 'Answer';
  const submit = () => {
    if (input.disabled) return;                    // already sent
    const t = input.value.trim();
    if (!t) return;
    input.disabled = true;
    btn.disabled = true;
    send({ type: 'answer_text', text: t });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  btn.onclick = submit;
  wrap.append(input, btn);
  opts.appendChild(wrap);

  // no reading lock — the whole 20-second window is for typing, open from the
  // first frame (the shrinking timer line is the countdown).
  clearTimeout(readTimer);
  input.disabled = false; btn.disabled = false;
  $('qnote').textContent = 'Type the answer and press Enter — 20 seconds.';
  try { input.focus(); } catch (e) {}
}

function startTimerBar(deadline, barSel) {
  cancelAnimationFrame(timerRAF);
  const bar = document.querySelector(barSel);
  bar.parentElement.style.display = deadline ? '' : 'none';
  if (!deadline) { bar.style.width = '100%'; return; }
  if (bar.dataset.deadline !== String(deadline)) {
    bar.dataset.deadline = String(deadline);
    bar.dataset.total = String(Math.max(0.001, deadline - Date.now() / 1000));
  }
  const total = parseFloat(bar.dataset.total);
  const tick = () => {
    const left = deadline - Date.now() / 1000;
    const pct = Math.max(0, Math.min(1, left / total));
    bar.style.width = (pct * 100) + '%';
    bar.style.background = pct < 0.25 ? '#e4572e' : '';
    // numeric readout beside the bar — a shrinking 7px strip alone is a lot
    // to parse mid-question, and its red shift is invisible to protans
    bar.parentElement.dataset.secs = Math.max(0, Math.ceil(left));
    if (pct > 0 && (room.phase === 'question' || room.phase === 'minigame')) {
      timerRAF = requestAnimationFrame(tick);
    }
  };
  tick();
}

/* ── minigames (ported 1:1 from legacy onto the styled classes) ─────────── */
function renderMinigame() {
  const modal = $('mgmodal');
  const m = room.minigame;
  // hold the riddle scroll back while the Sphinx's ambush intro plays out
  const show = room.phase === 'minigame' && m && !world.arriving()
    && !(m.sphinx && sphinxIntro);
  modal.classList.toggle('hidden', !show);
  if (!show) { mg = { key: null }; return; }

  const mine = room.turn === you;
  const key = `${m.island}:${m.kind}:${m.deadline}`;
  const fresh = mg.key !== key;
  if (fresh) mg = { key, sel: null, rot: 0, cells: null, taps: [], watched: false, grid: null };

  if (m.battle) {
    $('mgkind').textContent = `Combat · ${MG_LABEL[m.kind] || 'Trial'}`;
    $('mgisle').textContent = 'solve it — or take the hit';
  } else if (m.kraken) {
    $('mgkind').textContent = `The Kraken · riddle ${m.kraken_no || 1} of ${m.kraken_need || 3}`;
    $('mgisle').textContent = 'miss one and you lose a turn';
  } else if (m.sphinx) {
    $('mgkind').textContent = 'The Sphinx';
    $('mgisle').textContent = 'answer, or be swept back down the road';
  } else {
    $('mgkind').textContent = MG_LABEL[m.kind] || 'Trial';
    $('mgisle').textContent = (room.board.nodes.find((n) => n.id === m.island) || {}).name || '';
  }
  $('mgprompt').textContent = mine ? MG_PROMPT[m.kind]
    : `${room.players.find((p) => p.pid === room.turn)?.name || 'A rival'} attempts the trial…`;
  startTimerBar(m.deadline, '#mgtimerBar');
  $('mgnote').textContent = '';

  const board = $('mgboard');
  if (!fresh && !mine) return;                    // spectators: static board
  if (fresh) board.innerHTML = '';

  if (m.kind === 'tetromino') renderTetromino(board, m, mine, fresh);
  else if (m.kind === 'nonogram') renderNonogram(board, m, mine, fresh);
  else if (m.kind === 'simon' || m.kind === 'memory') renderSimon(board, m, mine, fresh);
  else if (m.kind === 'visual_memory') renderVisualMemory(board, m, mine, fresh);
  else if (m.kind === 'anagram') renderAnagram(board, m, mine, fresh);
  else if (m.kind === 'ravens') renderRavens(board, m, mine, fresh);
  else if (m.kind === 'riddle') renderRiddle(board, m, mine, fresh);
  else if (m.kind === 'sequence') renderSequence(board, m, mine, fresh);
  else if (m.kind === 'lights_out') renderLightsOut(board, m, mine, fresh);
  else if (m.kind === 'sliding') renderSliding(board, m, mine, fresh);
}

/* tetromino — Talos-style sigil fill: drag to place, no rotation */
const PIECE_COLORS = ['#e4572e', '#2e86ab', '#f6ae2d', '#8e5572', '#33ca7f',
                      '#6457a6', '#c9a227', '#4a7d6b', '#a34d78'];

function renderTetromino(board, m, mine, fresh) {
  if (fresh) {
    mg.cells = Array(m.w * m.h).fill(-1);
    mg.placed = {};
  }
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'mggrid';
  grid.style.gridTemplateColumns = `repeat(${m.w}, 1fr)`;
  for (let i = 0; i < m.w * m.h; i++) {
    const c = document.createElement('button');
    c.className = 'mgcell';
    c.dataset.cell = i;
    const v = mg.cells[i];
    if (v >= 0) c.style.background = PIECE_COLORS[v % PIECE_COLORS.length];
    c.disabled = !mine;
    // drag a PLACED piece straight to a new spot — no need to send it back to
    // the tray first. Grab it anywhere on the piece; it follows the cursor and
    // snaps home if you let go somewhere it can't sit.
    c.addEventListener('pointerdown', (e) => {
      if (!mine || mg.cells[i] < 0) return;
      e.preventDefault();
      const idx = mg.cells[i];
      const origCells = (mg.placed[idx] || []).slice();
      const minX = Math.min(...origCells.map((j) => j % m.w));
      const minY = Math.min(...origCells.map((j) => Math.floor(j / m.w)));
      const grab = [(i % m.w) - minX, Math.floor(i / m.w) - minY];
      for (const j of origCells) { mg.cells[j] = -1; grid.children[j].style.background = ''; }
      delete mg.placed[idx];
      dragPiece(e, board, grid, m, m.pieces[idx], idx, mine, origCells, grab);
    });
    grid.appendChild(c);
  }
  board.appendChild(grid);

  const palette = document.createElement('div');
  palette.className = 'mgpalette';
  m.pieces.forEach((form, idx) => {
    const used = idx in (mg.placed || {});
    const pbtn = document.createElement('button');
    pbtn.className = 'mgpiece' + (used ? ' used' : '');
    pbtn.disabled = !mine || used;
    const pw = Math.max(...form.map((c) => c[0])) + 1;
    const ph = Math.max(...form.map((c) => c[1])) + 1;
    pbtn.style.gridTemplateColumns = `repeat(${pw}, 10px)`;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const dot = document.createElement('i');
        if (form.some(([fx, fy]) => fx === x && fy === y)) {
          dot.style.background = PIECE_COLORS[idx % PIECE_COLORS.length];
        }
        pbtn.appendChild(dot);
      }
    }
    pbtn.addEventListener('pointerdown', (e) => {
      if (!mine || (idx in mg.placed)) return;
      e.preventDefault();
      dragPiece(e, board, grid, m, form, idx, mine);
    });
    palette.appendChild(pbtn);
  });
  const tip = document.createElement('span');
  tip.className = 'tag';
  tip.textContent = 'drag a piece onto the grid · drag a placed piece to move it, or off the grid to remove it';
  palette.appendChild(tip);
  board.appendChild(palette);
}

// origCells/grab are set when dragging a piece that was already on the board:
// origCells is where it sat (so an invalid drop snaps it home), grab is which
// sub-cell you grabbed (so the piece tracks the cursor from that point).
function dragPiece(e0, board, grid, m, form, idx, mine, origCells = null, grab = [0, 0]) {
  const cellRect = grid.querySelector('.mgcell').getBoundingClientRect();
  const cellPx = cellRect.width + 4;
  const ghost = document.createElement('div');
  ghost.className = 'dragghost';
  for (const [x, y] of form) {
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;left:${x * cellPx}px;top:${y * cellPx}px;` +
      `width:${cellPx - 4}px;height:${cellPx - 4}px;border-radius:8px;` +
      `background:${PIECE_COLORS[idx % PIECE_COLORS.length]};opacity:.88`;
    ghost.appendChild(b);
  }
  document.body.appendChild(ghost);
  let hoverCells = null;

  const move = (e) => {
    ghost.style.left = (e.clientX - cellPx * (grab[0] + 0.4)) + 'px';
    ghost.style.top = (e.clientY - cellPx * (grab[1] + 0.4)) + 'px';
    [...grid.children].forEach((c) => c.classList.remove('drop-ok', 'drop-bad'));
    hoverCells = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest ? el.closest('.mgcell') : null;
    if (!cell || !grid.contains(cell)) return;
    const anchor = parseInt(cell.dataset.cell, 10);
    const x0 = (anchor % m.w) - grab[0], y0 = Math.floor(anchor / m.w) - grab[1];
    const cells = [];
    for (const [dx, dy] of form) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= m.w || y >= m.h || mg.cells[y * m.w + x] >= 0) {
        cells.length = 0; break;
      }
      cells.push(y * m.w + x);
    }
    if (cells.length === form.length) {
      hoverCells = cells;
      cells.forEach((i) => grid.children[i].classList.add('drop-ok'));
    } else {
      cell.classList.add('drop-bad');
    }
  };
  const up = (e) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    ghost.remove();
    [...grid.children].forEach((c) => c.classList.remove('drop-ok', 'drop-bad'));
    if (hoverCells) {
      for (const j of hoverCells) mg.cells[j] = idx;
      mg.placed[idx] = hoverCells;
    } else if (origCells) {
      // a lifted piece let go with no valid landing: if the release was still
      // OVER the grid it snaps home (a fumble never loses it), but dropped OFF
      // the board it's REMOVED — back to the tray to place again
      const overGrid = !!(e && grid.contains(document.elementFromPoint(e.clientX, e.clientY)));
      if (overGrid) {
        for (const j of origCells) mg.cells[j] = idx;
        mg.placed[idx] = origCells;
      }
      // else: leave it un-placed — the palette button re-enables on re-render
    }
    if (Object.keys(mg.placed).length === m.pieces.length) {
      send({ type: 'solve', payload: mg.cells });
    }
    renderTetromino(board, m, mine, false);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  move(e0);
}

/* nonogram — autosubmits the moment every clue matches */
function renderNonogram(board, m, mine, fresh) {
  const given = new Set(m.given || []);
  if (fresh) {
    mg.grid = Array(m.n * m.n).fill(0);
    for (const i of given) mg.grid[i] = 1;
  }
  board.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'nonowrap';
  const table = document.createElement('div');
  table.className = 'nonogrid';
  table.style.gridTemplateColumns = `auto repeat(${m.n}, 1fr)`;
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
      const isGiven = given.has(i);
      cell.className = 'mgcell nono' + (mg.grid[i] ? ' on' : '') + (isGiven ? ' given' : '');
      cell.disabled = !mine || isGiven;
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

/* simon — 9 colored tiles, each with its own tone; input gated on `watched` */
const SIMON_COLORS = ['#e4572e', '#2e86ab', '#f6ae2d', '#8e5572', '#33ca7f',
                      '#6457a6', '#2e9e8f', '#d94f70', '#7d9c3e'];

function renderSimon(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  const N = m.pad || 9;                       // memory = 4 (2×2); simon = 9 (3×3)
  const pad = document.createElement('div');
  pad.className = N <= 4 ? 'simonpad mem' : 'simonpad';
  const tiles = [];
  const flash = (tile, i) => {
    tile.classList.add('lit');
    audio.simonTone(i);
    setTimeout(() => tile.classList.remove('lit'), 380);
  };
  for (let i = 0; i < N; i++) {
    const t = document.createElement('button');
    t.className = 'mgpad';
    t.style.setProperty('--simoncol', SIMON_COLORS[i]);
    t.disabled = true;
    t.onclick = () => {
      if (!mine || !mg.watched) return;
      flash(t, i);
      mg.taps.push(i);
      if (i !== m.seq[mg.taps.length - 1]) {
        // one wrong note ends the echo — no clock, no second chances
        send({ type: 'solve', payload: mg.taps });
        mg.taps = [];
        $('mgnote').textContent = 'A wrong note…';
        return;
      }
      $('mgnote').textContent = `${mg.taps.length} / ${m.seq.length}`;
      if (mg.taps.length === m.seq.length) {
        send({ type: 'solve', payload: mg.taps });
        mg.taps = [];
      }
    };
    tiles.push(t);
    pad.appendChild(t);
  }
  board.appendChild(pad);
  $('mgnote').textContent = 'Watch and listen…';
  m.seq.forEach((tileIdx, k) => {
    setTimeout(() => {
      flash(tiles[tileIdx], tileIdx);
      if (k === m.seq.length - 1) {
        setTimeout(() => {
          mg.watched = true;
          tiles.forEach((t) => { t.disabled = !mine; });
          $('mgnote').textContent = mine ? 'Repeat the song. One wrong note fails it (−1 scroll).' : '';
        }, 560);
      }
    }, 800 + k * 700);
  });
}

/* visual memory (Human Benchmark): a 7×7 board flashes a set of tiles; memorise
   them, then click them all back. Three misses (lives) ends it. The lit set is
   public (the client has to flash it) — the server just checks the picks. */
function renderVisualMemory(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  const N = m.n || 7;
  const flashSet = new Set(m.flash || []);
  const hearts = (n) => '♥'.repeat(Math.max(0, n)) + '♡'.repeat(Math.max(0, (m.lives || 3) - n));
  mg.found = [];
  mg.lives = m.lives || 3;
  mg.watched = false;
  const grid = document.createElement('div');
  grid.className = 'vmgrid';
  grid.style.setProperty('--vmn', N);
  const tiles = [];
  const finish = (won) => {
    mg.watched = false;
    tiles.forEach((t) => { t.disabled = true; });
    // send the set we uncovered; a complete set wins, a partial (out of lives)
    // is a botched round — the server resolves it either way
    send({ type: 'solve', payload: mg.found.slice() });
    $('mgnote').textContent = won ? 'The pattern holds!' : 'The pattern slips away…';
  };
  for (let i = 0; i < N * N; i++) {
    const t = document.createElement('button');
    t.className = 'vmcell';
    t.disabled = true;
    t.onclick = () => {
      if (!mine || !mg.watched || t.classList.contains('found')) return;
      if (flashSet.has(i)) {
        t.classList.add('found');
        mg.found.push(i);
        if (mg.found.length === flashSet.size) { finish(true); return; }
        $('mgnote').textContent = `Lives ${hearts(mg.lives)} · ${mg.found.length}/${flashSet.size} found`;
      } else {
        t.classList.add('miss');
        setTimeout(() => t.classList.remove('miss'), 420);
        mg.lives -= 1;
        if (mg.lives <= 0) { finish(false); return; }
        $('mgnote').textContent = `Lives ${hearts(mg.lives)} · ${mg.found.length}/${flashSet.size} found`;
      }
    };
    tiles.push(t);
    grid.appendChild(t);
  }
  board.appendChild(grid);
  // the flash: light every tile in the set at once, hold, then hide & unlock
  $('mgnote').textContent = 'Memorise the lit tiles…';
  for (const i of flashSet) tiles[i]?.classList.add('lit');
  setTimeout(() => {
    for (const i of flashSet) tiles[i]?.classList.remove('lit');
    if (!mine) { $('mgnote').textContent = ''; return; }
    mg.watched = true;
    tiles.forEach((t) => { t.disabled = false; });
    $('mgnote').textContent = `Lives ${hearts(mg.lives)} · click the tiles you saw`;
  }, 2400);
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

/* riddle — read the teaser, type the answer (like anagram, no fixed length) */
function renderRiddle(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  if (m.category) {
    const cat = document.createElement('div');
    cat.className = 'riddlecat';
    cat.textContent = m.category;
    board.appendChild(cat);
  }
  const text = document.createElement('div');
  text.className = 'riddletext';
  text.textContent = m.text;
  board.appendChild(text);
  if (mine) {
    const row = document.createElement('div');
    row.className = 'agrow';
    const input = document.createElement('input');
    input.className = 'aginput';
    input.maxLength = 32;
    input.placeholder = 'your answer';
    input.autocomplete = 'off';
    const go = document.createElement('button');
    go.className = 'act';
    go.textContent = 'ANSWER';
    const submit = () => {
      const v = input.value.trim();
      if (v) send({ type: 'solve', payload: v });
      else $('mgnote').textContent = 'Type an answer.';
    };
    go.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(input, go);
    board.appendChild(row);
    setTimeout(() => input.focus(), 100);
  }
}

/* sequence — read the thread of numbers, type the next term (like riddle) */
function renderSequence(board, m, mine, fresh) {
  if (!fresh) return;
  board.innerHTML = '';
  const thread = document.createElement('div');
  thread.className = 'seqthread';
  thread.textContent = (m.terms || []).join(', ') + ', …';
  board.appendChild(thread);
  if (mine) {
    const row = document.createElement('div');
    row.className = 'agrow';
    const input = document.createElement('input');
    input.className = 'aginput';
    input.inputMode = 'numeric';
    input.maxLength = 12;
    input.placeholder = 'next number';
    input.autocomplete = 'off';
    const go = document.createElement('button');
    go.className = 'act';
    go.textContent = 'ANSWER';
    const submit = () => {
      const v = input.value.trim();
      if (v) send({ type: 'solve', payload: v });
      else $('mgnote').textContent = 'Type a number.';
    };
    go.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(input, go);
    board.appendChild(row);
    setTimeout(() => input.focus(), 100);
  }
}

/* lights out — tap a stone to toggle it and its orthogonal neighbours; darken
 * the whole grid. Local board + taps in mg state; auto-submits when all off. */
function renderLightsOut(board, m, mine, fresh) {
  const n = m.n;
  if (fresh) {
    mg.board = m.board.map((r) => r.slice());
    mg.taps = [];
  }
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'logrid';
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  const cells = [];
  const paint = () => {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) cells[r * n + c].classList.toggle('lit', !!mg.board[r][c]);
    }
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const cell = document.createElement('button');
      cell.className = 'mgcell locell';
      cell.disabled = !mine;
      cell.onclick = () => {
        for (const [rr, cc] of [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
          if (rr >= 0 && rr < n && cc >= 0 && cc < n) mg.board[rr][cc] ^= 1;
        }
        mg.taps.push([r, c]);
        paint();
        if (mg.board.every((row) => row.every((v) => v === 0))) {
          send({ type: 'solve', payload: mg.taps });
        }
      };
      cells.push(cell);
      grid.appendChild(cell);
    }
  }
  board.appendChild(grid);
  paint();
}

/* sliding tile — click a tile beside the blank to slide it in; restore the
 * goal order 1..8 with the blank last. Auto-submits when solved. */
function renderSliding(board, m, mine, fresh) {
  if (fresh) mg.board = m.board.slice();
  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'slidegrid';
  const goal = m.goal;
  const draw = () => {
    grid.innerHTML = '';
    mg.board.forEach((val, i) => {
      const cell = document.createElement('button');
      cell.className = 'mgcell slidecell' + (val === 0 ? ' blank' : '');
      cell.textContent = val === 0 ? '' : val;
      cell.disabled = !mine || val === 0;
      cell.onclick = () => {
        const z = mg.board.indexOf(0);
        if (Math.abs(Math.floor(z / 3) - Math.floor(i / 3)) + Math.abs((z % 3) - (i % 3)) === 1) {
          mg.board[z] = mg.board[i];
          mg.board[i] = 0;
          draw();
          if (mg.board.every((v, k) => v === goal[k])) {
            send({ type: 'solve', payload: mg.board.slice() });
          }
        }
      };
      grid.appendChild(cell);
    });
  };
  draw();
  board.appendChild(grid);
}

/* raven's matrix */
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

/* ── generic modal: intro · upgrade pick · winner ───────────────────────── */
function renderModal() {
  const modal = $('modal');
  const body = $('modalBody');
  const show = (html) => { modal.classList.remove('hidden'); body.innerHTML = html; };

  if (room.phase !== 'lobby' && room.phase !== 'finished' && !introDismissed) {
    show(`<h2>${icon('laurel', 20)} The Voyage</h2>
      <ol class="intro">
        <li><strong>Sail</strong> — roll the bronze die (one to three) and sail
          <em>exactly</em> that far. Havens set your checkpoint; temples and
          trials pay scrolls.</li>
        <li><strong>Venture</strong> — four mountain passes leave the
          Isles of Peace. Beyond each lies a realm, and the deeper you press, the
          harder its packs bite.</li>
        <li><strong>Fight</strong> — answer to STRIKE (tier I–II) or cast
          MAGIC (III). When a foe strikes back, time your <strong>DODGE</strong>
          on the beat — read it right and the blow is <strong>halved</strong>
          (tyrants telegraph a heavier one). Pitch &amp; planks patch the hull,
          even mid-battle.</li>
        <li><strong>Haul it home</strong> — slay a realm's tyrant to take its
          sigil seal. Shipwreck drops it back at the lair; sail home and bank
          it to make it safe.</li>
        <li><strong>Win</strong> — bank ${room.config.relics_to_win} seals to
          open the Pharos, then land on it and put down the Dark Lord.</li>
      </ol>
      <p class="tag">Hull 0 = shipwreck: back to your checkpoint, scrolls halved.
        Answer on rivals' turns to skim scrolls.</p>
      <button id="introGo" class="big">SET SAIL</button>`);
    $('introGo').onclick = () => {
      introDismissed = true;
      localStorage.setItem('thalassa_intro', '1');
      modal.classList.add('hidden');
      render();
    };
    return;
  }

  if (room.phase === 'upgrade_pick') {
    if (room.turn === you && room.upgrade_offer) {
      show(`<h2>${icon('fitting', 20)} Choose your prize</h2><div class="upgrades"></div>`);
      const wrap = body.querySelector('.upgrades');
      for (const id of room.upgrade_offer) {
        const info = room.upgrade_info[id];
        const b = document.createElement('button');
        b.className = 'upcard';
        b.innerHTML = `${icon(UP_ICON[id] || 'fitting')}<strong>${esc(info.name)}</strong><span>${esc(info.desc)}</span>`;
        b.onclick = () => send({ type: 'pick', upgrade: id });
        wrap.appendChild(b);
      }
    } else {
      const p = room.players.find((x) => x.pid === room.turn);
      show(`<h2>${icon('fitting', 20)} Spoils</h2><p>${esc(p?.name || '')} chooses a fitting…</p>`);
    }
    return;
  }

  if (room.phase === 'finished') {
    const w = room.players.find((p) => p.pid === room.winner);
    show(`<h2>${icon('crown', 22)} The Pharos</h2>
      <p><strong style="color:${w?.color}">${esc(w?.name || '?')}</strong> has put down the
      Dark Lord and lit the Pharos. The four realms sing their name.</p>
      ${you === room.host
        ? '<button id="rematchGo" class="big">NEW VOYAGE — A NEW SEA</button>'
        : '<p class="tag">the host may launch a new voyage</p>'}`);
    const rg = $('rematchGo');
    if (rg) rg.onclick = () => send({ type: 'rematch' });
    return;
  }

  modal.classList.add('hidden');
}

/* ── the bronze d3 ──────────────────────────────────────────────────────── */
/* Each value sits on two opposed faces, so any settle shows 1..3.
 * Rotations reuse the legacy DIE_ROT trick for values 1-3. */
const DIE_ROT = { 1: [0, 0], 2: [-90, 0], 3: [0, -90] };
const DIE_FACES = { front: 1, back: 3, top: 2, bottom: 2, right: 3, left: 1 };

function buildCube(el) {
  if (el.dataset.built) return;
  el.dataset.built = '1';
  for (const [side, n] of Object.entries(DIE_FACES)) {
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
  const v = Math.min(3, Math.max(1, value | 0));
  /* deterministic tumble: reset flat with no transition, then spin to the face */
  cube.style.transition = 'none';
  cube.style.transform = 'rotateX(0deg) rotateY(0deg)';
  void cube.offsetWidth;                              // force reflow
  const [rx, ry] = DIE_ROT[v];
  cube.style.transition = 'transform 1.05s cubic-bezier(.25,.65,.3,1.02)';
  cube.style.transform = `rotateX(${720 + rx}deg) rotateY(${720 + ry}deg)`;
  clearTimeout(dieTimeout);
  dieTimeout = setTimeout(() => box.classList.add('hidden'), 4000);
}

/* ── toasts + log ───────────────────────────────────────────────────────── */
function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = stripEmoji(msg);
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function renderLog() {
  const lines = room.log || [];
  const last4 = lines.slice(-4);
  const sig = last4.join('\n');
  if (sig === lastLogSig) return;
  lastLogSig = sig;
  const el = $('log');
  el.innerHTML = '';
  for (const line of last4) {
    const d = document.createElement('div');
    d.textContent = stripEmoji(line);
    el.appendChild(d);
  }
}
