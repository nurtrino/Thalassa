/*
 * events_realms.js — the client half of the REALM events (event_data_ice.py,
 * event_data_jungle.py, eventgames_realms.py): line-art motifs for their cards,
 * the Frostfang Reach / Verdigris Deep card backdrops, and the renderers for
 * the realm game kinds (floe, pairs, drums, plates).
 *
 * Hooked from events.js in five small places: motif lookup (REALM_M), the
 * art band (realmBand), the stage label (REALM_LABEL), the game renderer table
 * (REALM_GAMES) and the button wiring (wireRealm). Every renderer is a pure
 * function of the public game state (g, actor) → HTML; moves go out as
 * event_move with the JSON payload in a data-rmv attribute. Nothing is timed.
 */
import { esc } from './ui.js';

/* ── line-art motifs (64×64, stroke = currentColor) ─────────────────────── */
export const REALM_M = {
  /* the Frostfang Reach */
  boreas: '<path d="M14 22a14 14 0 0 1 28 0c0 8-6 14-14 14S14 30 14 22Z"/><path d="M20 22c2-2 4-2 6 0M30 22c2-2 4-2 6 0"/><path d="M24 30c2 1 6 1 8 0"/><path d="M42 26c6-2 10 0 14 2M42 30c6 0 10 2 14 6M40 34c4 2 8 6 10 10"/><path d="M16 36c-2 8 0 16 6 20M40 36c2 8 0 16-6 20"/><path d="M22 10l2-6M28 8V2M34 10l-2-6"/>',
  mammoth: '<path d="M10 40c0-14 10-24 24-24s20 10 20 22v6H44v12h-6V44H22v12h-6V44c-4-1-6-2-6-4Z"/><path d="M48 30c6 4 8 12 4 18-2 2-4 2-6 0"/><path d="M50 36c4 6 2 12-4 14"/><circle cx="44" cy="26" r="1.6" fill="currentColor"/><path d="M4 12h56M4 12v46h56V12" stroke-dasharray="3 4"/>',
  polarbear: '<path d="M8 42c0-10 8-18 20-18h12c8 0 14 4 16 10l2 6-6 2"/><circle cx="46" cy="30" r="1.6" fill="currentColor"/><path d="M14 44v10M22 46v8M38 46v8M46 44v10"/><path d="M38 20V8h12v12"/><path d="M36 20h16"/><path d="M40 8c0-3 2-4 4-4s4 1 4 4"/>',
  tourists: '<circle cx="20" cy="20" r="6"/><circle cx="42" cy="20" r="6"/><path d="M12 42c0-8 4-14 8-14s8 6 8 14M34 42c0-8 4-14 8-14s8 6 8 14"/><path d="M8 48h48l-6 8H14Z"/><circle cx="52" cy="10" r="5"/><path d="M52 2v2M60 10h-2M46 4l1 1"/>',
  floe: '<path d="M6 34l10-8 14 2 6-6 12 2 10 8-6 6-14 2-8-4-14 2Z"/><path d="M30 28l-2 8 4 4"/><path d="M4 50c8-3 14-3 20 0s14 3 20 0 12-3 16 0"/><path d="M10 58c8-3 14-3 20 0s14 3 20 0"/>',
  aurora: '<path d="M4 40c8-20 16-28 28-20s20 4 28-8"/><path d="M4 48c10-16 18-22 30-14s18 2 26-10" opacity=".7"/><path d="M10 40v-8M20 30v-8M32 22v-8M44 24v-8M54 16v-6"/><path d="M4 58h56"/><path d="M14 58l6-6 6 6M40 58l8-8 8 8"/>',
  spring: '<path d="M8 44c0-6 10-10 24-10s24 4 24 10-10 10-24 10S8 50 8 44Z"/><path d="M20 28c-2-4 2-6 0-10M32 26c-2-4 2-6 0-10M44 28c-2-4 2-6 0-10"/><circle cx="24" cy="42" r="4"/><circle cx="40" cy="42" r="4"/><path d="M22 40h.1M26 40h.1M38 40h.1M42 40h.1"/>',
  fishhole: '<ellipse cx="32" cy="44" rx="20" ry="7"/><path d="M32 10v28"/><path d="M32 38c-2 2-2 4 0 6"/><path d="M20 22c4-6 12-6 16 0-4 6-12 6-16 0Z"/><path d="M36 22l6-4v8Z"/><circle cx="24" cy="21" r="1.3" fill="currentColor"/><path d="M6 56h52"/>',
  giant: '<path d="M18 30c0-12 6-20 14-20s14 8 14 20"/><path d="M14 30h36"/><path d="M18 30c0 10 6 18 14 18s14-8 14-18"/><path d="M24 34v10M30 36v12M36 36v12M42 34v10"/><circle cx="26" cy="24" r="2" fill="currentColor"/><circle cx="38" cy="24" r="2" fill="currentColor"/><path d="M22 18l6 2M42 18l-6 2"/><path d="M10 58c8-6 36-6 44 0"/>',
  berg: '<path d="M8 44l8-20 10-8 8 6 8-12 10 14 4 20Z"/><path d="M22 30c2-1 4-1 6 0M36 30c2-1 4-1 6 0"/><path d="M30 36l2 4h-4Z"/><path d="M4 50c8-3 14-3 20 0s14 3 20 0 12-3 16 0"/><path d="M50 18c2-2 6-2 6 2M54 12c2-2 6 0 4 4"/>',
  snowball: '<circle cx="24" cy="38" r="12"/><circle cx="44" cy="22" r="8"/><path d="M18 34h.1M28 42h.1M42 20h.1M46 24h.1"/><path d="M50 10l6-4M54 16l6 0"/><path d="M8 56h48"/>',
  igloo: '<path d="M8 48c0-14 10-24 24-24s24 10 24 24Z"/><path d="M26 48V40a6 6 0 0 1 12 0v8"/><path d="M12 38h40M16 30h32M22 24l2 6M32 24v6M42 24l-2 6M18 38l-2 10M30 38v-8M44 38l2 10"/><path d="M4 52h56"/>',
  icicle: '<path d="M6 10h52"/><path d="M10 10l3 26 3-26M20 10l3 38 3-38M30 10l3 30 3-30M40 10l3 42 3-42M50 10l3 22 3-22"/><path d="M14 56c4-2 8-2 12 0M36 58c4-2 8-2 12 0"/>',
  seal: '<path d="M8 44c4-10 14-16 26-16 8 0 14-6 16-12 4 2 6 6 4 10l-6 6c2 6-2 12-10 14H18c-6 0-10-2-10-2Z"/><circle cx="48" cy="20" r="1.4" fill="currentColor"/><path d="M50 26l6 2M50 26l5 4"/><path d="M8 44l-4 6 8-2"/><circle cx="30" cy="12" r="5"/>',
  narwhal: '<path d="M6 40c4-8 12-12 22-12s18 4 22 10c-4 6-12 10-22 10S10 46 6 40Z"/><path d="M50 38l12-20"/><path d="M6 40l-2-6M6 40l-2 6"/><circle cx="42" cy="36" r="1.4" fill="currentColor"/><path d="M4 56c8-3 16-3 26 0s18 3 28 0"/>',
  walrus: '<path d="M10 48c0-14 8-24 22-24s22 10 22 24Z"/><circle cx="24" cy="32" r="1.8" fill="currentColor"/><circle cx="40" cy="32" r="1.8" fill="currentColor"/><path d="M24 40c4-4 12-4 16 0"/><path d="M28 40l-2 16M36 40l2 16"/><path d="M20 38h-6M44 38h6M20 41h-6M44 41h6"/><rect x="26" y="16" width="12" height="6" rx="1"/>',
  penguin: '<path d="M22 54c-6-6-8-16-6-28 2-10 8-16 16-16s14 6 16 16c2 12 0 22-6 28Z"/><path d="M26 54c-2-8-2-18 2-26M38 54c2-8 2-18-2-26"/><circle cx="28" cy="20" r="1.4" fill="currentColor"/><circle cx="36" cy="20" r="1.4" fill="currentColor"/><path d="M30 25l2 3 2-3Z"/><path d="M24 58h6M34 58h6"/>',
  flake: '<path d="M32 6v52M10 19l44 26M10 45l44-26"/><path d="M26 10l6 6 6-6M26 54l6-6 6 6M8 26l8-2-2-8M56 38l-8 2 2 8M8 38l8 2-2 8M56 26l-8-2 2-8"/>',
  fish: '<path d="M8 32c8-12 24-14 36-4-12 10-28 8-36 4Z"/><path d="M44 28l12-8v24l-12-8"/><circle cx="18" cy="30" r="2" fill="currentColor"/><path d="M26 22c2 4 2 10 0 14"/>',
  /* the Verdigris Deep */
  monkey: '<circle cx="32" cy="26" r="14"/><circle cx="16" cy="24" r="5"/><circle cx="48" cy="24" r="5"/><path d="M24 28c0-6 16-6 16 0 0 6-4 8-8 8s-8-2-8-8Z"/><circle cx="28" cy="22" r="1.4" fill="currentColor"/><circle cx="36" cy="22" r="1.4" fill="currentColor"/><path d="M29 31c2 1 4 1 6 0"/><path d="M42 38c8 4 12 12 8 18-2 2-6 2-6-2"/>',
  parrot: '<path d="M24 16c8-8 22-4 22 8 0 6-4 10-10 12l-4 18-8-4 2-14c-6-2-6-14-2-20Z"/><path d="M40 20c6 0 8 4 6 8l-6-2"/><circle cx="34" cy="20" r="2" fill="currentColor"/><path d="M22 50l-8 10M28 52l-4 10"/><path d="M20 30c-6 4-8 10-6 16"/>',
  idol: '<path d="M22 12h20v8c4 2 6 8 4 14l-4 10H22l-4-10c-2-6 0-12 4-14Z"/><path d="M26 26h4M34 26h4"/><path d="M28 34c2 2 6 2 8 0"/><path d="M14 44h36v6H14Z"/><path d="M10 50h44v6H10Z"/><circle cx="50" cy="12" r="5"/>',
  mosquito: '<ellipse cx="32" cy="34" rx="6" ry="10"/><circle cx="32" cy="20" r="4"/><path d="M32 16V6"/><path d="M26 30l-14-10M38 30l14-10M26 36L12 44M38 36l14 8M28 42l-6 14M36 42l6 14"/><path d="M20 26c-8-8-12-6-12 0M44 26c8-8 12-6 12 0"/>',
  explorer: '<path d="M14 28c0-8 8-14 18-14s18 6 18 14"/><path d="M8 28h48"/><circle cx="32" cy="38" r="8"/><path d="M28 36h.1M36 36h.1"/><path d="M18 58c2-8 8-12 14-12s12 4 14 12"/><circle cx="50" cy="48" r="6"/><path d="M50 44v4l3 2"/>',
  frog: '<path d="M10 44c0-12 10-20 22-20s22 8 22 20c0 6-10 8-22 8S10 50 10 44Z"/><circle cx="22" cy="24" r="6"/><circle cx="42" cy="24" r="6"/><circle cx="22" cy="24" r="2" fill="currentColor"/><circle cx="42" cy="24" r="2" fill="currentColor"/><path d="M22 40c6 4 14 4 20 0"/><path d="M8 52l-4 6M56 52l4 6"/>',
  temple: '<path d="M8 54h48"/><path d="M12 54V44h40v10M16 44V34h32v10M20 34V24h24v10M26 24V14h12v10"/><path d="M28 54v-6h8v6"/><path d="M4 22c4-6 8-8 12-6M60 22c-4-6-8-8-12-6"/>',
  drum: '<ellipse cx="32" cy="18" rx="16" ry="6"/><path d="M16 18v26c0 4 8 8 16 8s16-4 16-8V18"/><path d="M16 26l16 18 16-18M16 38l8 8M48 38l-8 8"/><path d="M50 6l-8 10M14 6l8 10"/><circle cx="51" cy="5" r="2"/><circle cx="13" cy="5" r="2"/>',
  piranha: '<path d="M8 32c6-12 22-16 34-8l10-8v32l-10-8c-12 8-28 4-34-8Z"/><circle cx="18" cy="28" r="2" fill="currentColor"/><path d="M8 32l6 2 2-4 2 4 2-4 2 4 2-3"/><path d="M28 22c2 6 2 14 0 20"/>',
  vines: '<path d="M10 4c0 14 8 16 8 28s-8 16-8 28"/><path d="M32 4c0 10-6 14-6 24s6 14 6 24"/><path d="M54 4c0 16-8 18-8 30s6 14 6 22"/><path d="M18 20c6-2 8 2 8 6M18 40c-6-2-8 2-8 6M26 30c6 0 8 4 6 8M46 22c-6 0-8 4-6 8M46 42c6-2 8 2 8 6"/>',
  firefly: '<ellipse cx="32" cy="30" rx="6" ry="10"/><circle cx="32" cy="18" r="4"/><path d="M26 26c-10-8-16-4-14 2s10 4 14 0M38 26c10-8 16-4 14 2s-10 4-14 0"/><circle cx="32" cy="44" r="6"/><path d="M14 52h.1M50 50h.1M22 58h.1M44 58h.1M8 40h.1M56 36h.1"/>',
  coconut: '<circle cx="24" cy="40" r="12"/><circle cx="20" cy="36" r="1.6" fill="currentColor"/><circle cx="27" cy="36" r="1.6" fill="currentColor"/><circle cx="23" cy="42" r="1.6" fill="currentColor"/><path d="M44 58V22"/><path d="M44 22c-6-8-16-8-22-4M44 22c6-8 16-8 20-2M44 22c-2-8 0-14 6-18M44 22c-8-2-14 2-16 8"/>',
  calendar: '<circle cx="32" cy="32" r="24"/><circle cx="32" cy="32" r="14"/><circle cx="32" cy="32" r="4"/><path d="M32 8v6M32 50v6M8 32h6M50 32h6M15 15l4 4M45 45l4 4M15 49l4-4M45 19l4-4"/>',
  rain: '<path d="M16 26a10 10 0 0 1 2-20 14 14 0 0 1 26 2 9 9 0 0 1 2 18Z"/><path d="M16 34l-4 8M26 34l-4 8M36 34l-4 8M46 34l-4 8M20 48l-4 8M30 48l-4 8M40 48l-4 8"/>',
  lily: '<path d="M6 44c0-6 12-10 26-10s26 4 26 10-12 10-26 10S6 50 6 44Z"/><path d="M32 44l4-10"/><path d="M32 40c-6-4-8-12-4-20 2 6 4 8 4 10 0-2 2-4 4-10 4 8 2 16-4 20Z"/><path d="M24 36c-6-2-10-6-10-12 6 0 10 4 12 8M40 36c6-2 10-6 10-12-6 0-10 4-12 8"/>',
  orchid: '<path d="M32 30c-6-10-6-20 0-26 6 6 6 16 0 26Z"/><path d="M32 30c-10-4-18-2-24 4 8 4 16 4 24-4ZM32 30c10-4 18-2 24 4-8 4-16 4-24-4Z"/><path d="M32 30c-8 4-12 12-10 20 6-4 10-10 10-20ZM32 30c8 4 12 12 10 20-6-4-10-10-10-20Z"/><path d="M28 34l2 3 2-3 2 3 2-3"/><path d="M32 50v10M22 60h20"/>',
  sloth: '<path d="M4 10h56"/><path d="M18 10c0 8 2 12 6 14M46 10c0 8-2 12-6 14"/><path d="M20 26c0-6 6-8 12-8s12 2 12 8v12c0 8-6 14-12 14s-12-6-12-14Z"/><path d="M24 32c2-2 6-2 8 0M32 32c2-2 6-2 8 0"/><path d="M28 40c2 2 6 2 8 0"/>',
  jaguar: '<path d="M10 22l6-10 6 8h20l6-8 6 10"/><path d="M10 22c0 16 10 28 22 28s22-12 22-28"/><path d="M22 30l4 2M42 30l-4 2"/><path d="M28 40l4 4 4-4"/><circle cx="18" cy="38" r="1.6" fill="currentColor"/><circle cx="46" cy="38" r="1.6" fill="currentColor"/><circle cx="24" cy="46" r="1.4" fill="currentColor"/><circle cx="40" cy="46" r="1.4" fill="currentColor"/>',
  sun: '<circle cx="32" cy="32" r="10"/><path d="M32 6v8M32 50v8M6 32h8M50 32h8M14 14l6 6M44 44l6 6M14 50l6-6M44 20l6-6"/>',
  moon: '<path d="M40 8a24 24 0 1 0 0 48 18 18 0 0 1 0-48Z"/><circle cx="24" cy="26" r="2"/><circle cx="20" cy="38" r="3"/>',
  serpent2: '<path d="M14 54c-6-8 2-14 12-12s16-2 14-10-14-6-14-14 10-10 16-8"/><circle cx="44" cy="10" r="4"/><path d="M48 10l6-2M48 12l6 2"/>',
};

/* the stage name on a card */
export const REALM_LABEL = { ice: 'The Frostfang Reach', jungle: 'The Verdigris Deep' };

/* the card's backdrop band for a realm: {sky: [top, mid, low], back: svg} */
export function realmBand(stage) {
  if (stage === 'ice') {
    return {
      sky: ['#071630', '#1c4d6b', '#a8dccf'],
      back: '<g fill="none" stroke-linecap="round" opacity=".75">' +
        '<path d="M-10 40c40-26 80-26 120-6s90 10 130-12 60-12 90 0" stroke="#7ff0b8" stroke-width="7" opacity=".45"/>' +
        '<path d="M-10 30c50-20 90-18 130 2s90 2 120-20 60-8 90 4" stroke="#c48cff" stroke-width="4" opacity=".4"/></g>' +
        '<g fill="#e7f4fa" opacity=".9"><circle cx="40" cy="12" r="1.2"/><circle cx="120" cy="8" r="1"/><circle cx="210" cy="14" r="1.3"/><circle cx="290" cy="10" r="1"/></g>' +
        '<path d="M0 104V82l20-20 16 8 14-16 22 26 30-4 18-18 24 24 40 2 20-26 18 10 24-18 28 30 30-6 16 14V104Z" fill="#d8edf5" opacity=".85"/>' +
        '<path d="M0 104V94c50-6 110-6 160 0s110 4 160-2V104Z" fill="#0d2c44" opacity=".85"/>',
    };
  }
  if (stage === 'jungle') {
    return {
      sky: ['#0b2416', '#2f6a3b', '#d6e29a'],
      back: '<g fill="#0a1d10" opacity=".9">' +
        '<path d="M0 0h320v14c-10 8-20 6-30 0-10 10-24 10-32 2-10 12-26 10-34 0-12 10-26 10-36 0-10 12-24 12-34 2-12 10-26 8-34-2-10 10-24 10-32 0-12 10-24 10-34 0-10 8-22 8-30 0-10 6-18 6-24 0Z"/>' +
        '<path d="M40 14c0 20-6 30-6 46M120 12c2 18 8 26 6 40M250 12c-2 22-8 30-6 44" stroke="#0a1d10" stroke-width="2.4" fill="none"/></g>' +
        '<g fill="#e8f78a" opacity=".85"><circle cx="70" cy="58" r="1.8"/><circle cx="180" cy="44" r="1.5"/><circle cx="230" cy="66" r="1.8"/><circle cx="290" cy="50" r="1.4"/></g>' +
        '<path d="M0 104V80c30-10 50 6 80-2s40-14 70-4 50 10 80 0 60-6 90 4V104Z" fill="#123d24" opacity=".85"/>' +
        '<g fill="#5fa25a" opacity=".8"><ellipse cx="60" cy="92" rx="22" ry="4"/><ellipse cx="200" cy="96" rx="28" ry="4"/></g>',
    };
  }
  return null;
}

/* ── small helpers ──────────────────────────────────────────────────────── */
const ico = (k, size = 28) => `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" ` +
  `stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${REALM_M[k] || ''}</svg>`;
const rbtn = (label, payload, cls = '', key = '', sub = '', disabled = false) =>
  `<button class="evbtn ${cls}" data-rmv='${esc(JSON.stringify(payload))}' ${key ? `data-key="${key}"` : ''} ` +
  `${disabled ? 'disabled' : ''}>${label}${sub ? `<small>${sub}</small>` : ''}</button>`;

/* ── floe: cross the floe field ─────────────────────────────────────────── */
function reach(g) {
  if (g.row + 1 >= g.rows) return [];
  if (g.col === null || g.col === undefined) return Array.from({ length: g.cols }, (_, i) => i);
  return [g.col - 1, g.col, g.col + 1].filter((c) => c >= 0 && c < g.cols);
}

function gFloe(g, actor) {
  const nxt = g.row + 1;
  const can = new Set(g.done ? [] : reach(g));
  const path = new Map((g.path || []).map((c, r) => [r, c]));
  let rows = '';
  for (let r = g.rows - 1; r >= 0; r--) {
    let cells = '';
    for (let c = 0; c < g.cols; c++) {
      const k = g.known?.[`${r},${c}`];
      const here = r === g.row && c === g.col;
      const cls = ['evfloe', k || '', here ? 'here' : '', path.get(r) === c ? 'trod' : '',
        r === nxt && can.has(c) ? 'reach' : ''].join(' ');
      let inner = k === 'print' ? '<span class="evprint" title="the bear walked here">bear prints</span>'
        : k === 'thin' ? '<span>thin</span>' : k === 'sound' ? '<span>sound</span>' : '';
      if (here) inner = `<span class="evyou">${g.splash ? 'splash!' : 'you'}</span>`;
      if (actor && r === nxt && can.has(c)) {
        if (k !== 'thin') inner += rbtn('Hop', { hop: c }, '', String(c + 1));   // no hop onto known thin ice
        if (g.poles > 0 && !k) inner += rbtn('Sound', { sound: c }, 'ghost');
      }
      cells += `<div class="${cls}">${inner}</div>`;
    }
    rows += `<div class="evfloerow" style="grid-template-columns:repeat(${g.cols},1fr)">${cells}</div>`;
  }
  const shore = `<div class="evshore ${g.row < 0 ? 'here' : ''}">${g.row < 0 ? 'you are on the shore' : 'the shore'}</div>`;
  const creak = g.done ? '' : g.row < 0
    ? `From the shore you can hop onto any floe of the first row. ${g.near} of them ${g.near === 1 ? 'is' : 'are'} thin.`
    : `Your floe creaks: <b>${g.near}</b> of the ${can.size} floe${can.size === 1 ? '' : 's'} you can reach ${g.near === 1 ? 'is' : 'are'} thin.`;
  return `<div class="evsmall">Hop a row at a time, straight on or one aside. Stop on any floe to keep ` +
    `what you have crossed (${g.goal}+ rows pays).</div>` +
    `<div class="evstat">Rows crossed ${Math.max(0, g.row + 1)} of ${g.rows} · sounding poles ${g.poles}</div>` +
    `<div class="evfar">the far side</div><div class="evfloes">${rows}</div>${shore}` +
    (creak ? `<div class="evtell">${creak}</div>` : '') +
    (actor && !g.done ? `<div class="evrow">${rbtn('Stop here', 'stop', 'cool', 's', g.row + 1 >= g.goal ? 'collect' : 'walk away')}</div>` : '');
}

/* ── pairs: a memory match ─────────────────────────────────────────────── */
const FACE_SETS = {
  ice: ['fish', 'seal', 'penguin', 'flake', 'igloo', 'narwhal', 'walrus', 'berg'],
  jungle: ['frog', 'parrot', 'monkey', 'lily', 'firefly', 'piranha', 'orchid', 'sloth'],
};
function gPairs(g, actor) {
  const faces = FACE_SETS[g.set] || FACE_SETS.ice;
  const shown = {};
  if (g.open) shown[g.open.i] = g.open.face;
  if (g.last && !g.last.match) { shown[g.last.a] = g.last.fa; shown[g.last.b] = g.last.fb; }
  const tiles = Array.from({ length: g.n }, (_, i) => {
    const m = g.matched?.[i];
    const f = m !== null && m !== undefined ? m : shown[i];
    const up = f !== undefined && f !== null;
    const cls = ['evpair', m !== null && m !== undefined ? 'matched' : '', up && m == null ? 'up' : '',
      g.seen?.[i] && !up ? 'seen' : ''].join(' ');
    const can = actor && !g.done && (m === null || m === undefined) && !(g.open && g.open.i === i);
    return `<button class="${cls}" ${can ? `data-rmv='${JSON.stringify({ flip: i })}'` : 'disabled'} aria-label="tile ${i + 1}">` +
      (up ? ico(faces[f] || 'fish', 34) : `<span class="evpairn">${i + 1}</span>`) + '</button>';
  }).join('');
  const last = g.last ? `<div class="evtell">${g.last.match ? 'A pair! They stay face up.' : 'Not a pair — they turn back over when you lift the next tile.'}</div>` : '';
  return `<div class="evsmall">Turn two tiles a try. Twins stay up. Tiles you have seen keep a small mark. No clock — take your time.</div>` +
    `<div class="evstat">Pairs ${g.found} of ${g.pairs} · tries left ${g.tries}</div>${last}` +
    `<div class="evpairs">${tiles}</div>` +
    (actor && !g.done ? `<div class="evrow">${rbtn('Stop and collect', 'stop', 'cool', 's', `${g.goal}+ pairs pays`, !!g.open)}</div>` : '');
}

/* ── drums: what beat comes next? ──────────────────────────────────────── */
const beats = (s) => `<span class="evbeats">${[...(s || '')].map((b) =>
  `<i class="${b === 'B' ? 'boom' : 'tak'}" title="${b === 'B' ? 'BOOM' : 'tak'}"></i>`).join('')}</span>`;
function gDrums(g, actor) {
  const seq = (g.seq || []).map((s, i) => `<div class="evdrumrow"><b>${i + 1}</b>${beats(s)}</div>`).join('');
  const ch = (g.choices || []).map((s, i) => actor && !g.done
    ? `<button class="evopt evdrumpick" data-rmv='${JSON.stringify({ pick: i })}' data-key="${i + 1}"><span class="evnum">${'ABCD'[i]}</span>${beats(s)}</button>`
    : `<div class="evdrumrow"><b>${'ABCD'[i]}</b>${beats(s)}</div>`).join('');
  const hist = (g.history || []).map((h, i) => `<div>Round ${i + 1}: ${h.right ? 'right' : 'wrong'} — the answer was ${beats(h.was)}</div>`).join('');
  return `<div class="evsmall">Big dark beats are BOOM, small light beats are tak. Each row follows one rule. What comes fifth?</div>` +
    `<div class="evstat">Round ${g.round} of ${g.rounds} · right so far ${g.right} · ${g.need} needed</div>` +
    `<div class="evdrums">${seq}<div class="evdrumrow q"><b>5</b><span class="evbeats">?</span></div></div>` +
    `<div class="evopts evdrumch">${ch}</div><div class="evlog">${hist}</div>`;
}

/* ── plates: the pressure plates ───────────────────────────────────────── */
const PLATE_ICON = { sun: 'sun', moon: 'moon', jaguar: 'jaguar', serpent: 'serpent2' };
function gPlates(g, actor) {
  const clues = (g.clues || []).map((c) => `<li>${esc(c)}</li>`).join('');
  const pressed = new Set(g.pressed || []);
  const plates = (g.plates || []).map((p, i) => {
    const down = pressed.has(i);
    const can = actor && !g.done && !down;
    return `<button class="evplate ${down ? 'down' : ''}" ${can ? `data-rmv='${JSON.stringify({ press: i })}' data-key="${i + 1}"` : 'disabled'}>` +
      `${ico(PLATE_ICON[p] || 'sun', 40)}<span>${esc(p)}</span>${down ? `<em>${(g.pressed || []).indexOf(i) + 1}</em>` : ''}</button>`;
  }).join('');
  const log = (g.log || []).slice(-4).map((l) => `<div>${esc(g.plates[l.plate])}: ${l.ok ? 'click — it stays down' : 'clunk — all plates pop up, a dart flies'}</div>`).join('');
  return `<div class="evsmall">Press all four plates in the one order that fits every carving. A wrong plate resets them all and costs a dart.</div>` +
    `<ul class="evclues">${clues}</ul>` +
    `<div class="evstat">Order so far: ${(g.pressed || []).map((i) => esc(g.plates[i])).join(' → ') || '—'} · darts you can survive ${g.darts}</div>` +
    `<div class="evplates">${plates}</div><div class="evlog">${log}</div>`;
}

export const REALM_GAMES = { floe: gFloe, pairs: gPairs, drums: gDrums, plates: gPlates };

/* the realm buttons carry their whole payload as JSON */
export function wireRealm(q, mv) {
  q('[data-rmv]').forEach((b) => {
    b.onclick = () => { try { mv(JSON.parse(b.dataset.rmv)); } catch (e) { /* malformed: ignore */ } };
  });
}

/* the realm game styles live beside this file */
if (typeof document !== 'undefined' && !document.getElementById('evRealmCss')) {
  const link = document.createElement('link');
  link.id = 'evRealmCss';
  link.rel = 'stylesheet';
  link.href = '/static/events_realms.css';
  document.head.appendChild(link);
}
