/*
 * events.js — the client half of events.py: story cards, the event mini-games,
 * table events everyone answers at once, the result card, and the HUD strip of
 * boons/banes and the world wonders on the chart.
 *
 * Contract with app.js (two small hooks):
 *   initEvents(send)                     once, after the socket helper exists
 *   renderEvents(room, you, {hold})      every render; hold = the acting ship
 *                                        is still sailing up (show nothing yet)
 *   eventMinigameTitle(m)                header for an event PUZZLE, which plays
 *                                        in the shared minigame card
 * Messages sent: event_choose{idx} · event_move{payload} · event_answer{value}
 *                · event_bet{value}
 * Everything here reads the snapshot fields room.event / event_card / world /
 * event_info and players[].buffs; nothing reaches for hidden state.
 */
import { esc, stripEmoji } from './ui.js';

let send = () => {};
let els = null;
let lastCardSeq = null;           // null until the first snapshot (no stale card)
let cardTimer = 0;
let scratch = { key: null };      // per-event local input state
let shownKey = '';
let clockRAF = 0;

/* ── line-art motifs (64×64, stroke = currentColor) ─────────────────────── */
const M = {
  philosopher: '<circle cx="32" cy="22" r="10"/><path d="M22 26c0 10 4 16 10 16s10-6 10-16"/><path d="M26 34c2 6 4 9 6 9s4-3 6-9"/><path d="M20 18c4-8 20-8 24 0"/><path d="M14 58c2-9 9-14 18-14s16 5 18 14"/><path d="M18 14c-3-1-4-4-3-6M46 14c3-1 4-4 3-6"/>',
  goat: '<path d="M18 40c-2-8 2-16 10-18h12c6 0 10 4 10 10v4"/><path d="M40 22c2-6 6-10 12-10M36 22c0-6 2-10 6-12"/><circle cx="46" cy="30" r="1.6" fill="currentColor"/><path d="M50 36c0 6-3 8-6 8M50 36l4 2"/><path d="M22 40v14M28 42v12M40 42v12M46 40v14"/><path d="M14 30l6 4"/><path d="M8 50h10l4-6" stroke-dasharray="2 3"/>',
  gulls: '<path d="M6 28c6-6 12-6 16 0 4-6 10-6 16 0"/><path d="M28 16c4-4 8-4 11 0 3-4 7-4 11 0"/><path d="M34 42c5-5 10-5 13 0 3-5 8-5 13 0"/><path d="M4 56c6-3 10-3 16 0s10 3 16 0 10-3 16 0 6 3 8 2"/>',
  siren: '<path d="M32 10c-8 0-12 6-12 12 0 8 6 12 12 12s12-4 12-12c0-6-4-12-12-12Z"/><path d="M20 22c-8 4-10 12-8 18M44 22c8 4 10 12 8 18"/><path d="M26 34l-4 14h20l-4-14"/><path d="M22 48c-6 4-12 6-18 6M42 48c6 4 12 6 18 6"/><path d="M28 20h.1M36 20h.1"/>',
  fisher: '<path d="M10 34c8-10 24-12 34-2-10 10-26 8-34-2Z"/><path d="M44 32l10-8v16Z"/><circle cx="20" cy="32" r="1.8" fill="currentColor"/><path d="M28 28c2 3 2 6 0 8"/><path d="M6 52c8-4 16-4 24 0s16 4 24 0"/>',
  pirates: '<path d="M8 44h48l-6 10H14Z"/><path d="M32 44V8"/><path d="M32 10l18 22H32"/><path d="M32 12L16 34h16"/><circle cx="40" cy="24" r="3"/><path d="M37 28l6 0"/>',
  cyclops: '<circle cx="32" cy="30" r="20"/><circle cx="32" cy="28" r="8"/><circle cx="32" cy="28" r="3" fill="currentColor"/><path d="M22 18l6 4M42 18l-6 4"/><path d="M24 42c4 3 12 3 16 0"/><path d="M14 58l8-8M50 58l-8-8"/>',
  merman: '<path d="M32 6v40"/><path d="M24 12c0 6 4 8 8 8s8-2 8-8"/><path d="M24 12V6M40 12V6"/><rect x="40" y="30" width="16" height="20" rx="2"/><path d="M44 36h8M44 41h8M44 46h5"/><path d="M8 56c6-3 12-3 18 0s12 3 18 0 12-3 18 0"/>',
  kraken: '<path d="M22 30c0-10 4-18 10-18s10 8 10 18"/><circle cx="28" cy="24" r="2" fill="currentColor"/><circle cx="36" cy="24" r="2" fill="currentColor"/><path d="M22 30c-6 4-6 12-12 14M26 32c-2 8-6 14-10 18M32 32v20c0 4 4 4 4 0M38 32c2 8 6 14 10 18M42 30c6 4 6 12 12 14"/>',
  nereid: '<path d="M8 40c6-10 14-10 20 0 6 10 14 10 20 0 6-10 10-8 12-6"/><path d="M32 30a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M26 16c-2-6 2-10 6-10s8 4 6 10"/><path d="M6 54c8-4 16-4 26 0s18 4 26 0"/>',
  bottle: '<path d="M26 8h12v6l4 6v28a6 6 0 0 1-6 6h-8a6 6 0 0 1-6-6V20l4-6Z"/><path d="M26 30h12M26 38h12"/><path d="M28 30c2-3 6-3 8 0"/><path d="M4 56c8-4 16-4 24 0s16 4 24 0 8-2 8-2"/>',
  poet: '<path d="M12 50V18c0-4 4-6 8-6h28v34c0 4-4 6-8 6H16"/><path d="M12 50c0 3 2 4 4 4s4-1 4-4V14"/><path d="M26 22h14M26 30h14M26 38h10"/><path d="M50 6L38 26l-2 6 5-4L52 10"/>',
  turtle: '<path d="M14 38c0-12 8-20 18-20s18 8 18 20Z"/><path d="M22 38l4-10h12l4 10M26 28l6-8 6 8"/><path d="M50 34c4-2 8 0 8 4s-4 4-8 2"/><path d="M18 38l-4 8M44 38l4 8"/><path d="M6 56c8-4 16-4 26 0s18 4 26 0"/>',
  regatta: '<path d="M10 46l6-26 8 26Z"/><path d="M28 46l6-30 8 30Z"/><path d="M46 46l6-22 8 22Z"/><path d="M4 50h56"/><path d="M4 56c8-3 14-3 20 0s14 3 20 0 12-3 16 0"/>',
  auction: '<path d="M14 26l14-14 8 8-14 14Z"/><path d="M28 28l18 18"/><path d="M8 54h28"/><path d="M12 54v-4h20v4"/><circle cx="48" cy="20" r="6"/><path d="M48 14v-4M48 26v4"/>',
  amphorae: '<path d="M24 8h16"/><path d="M26 8v6c-8 4-12 12-10 24 2 10 8 16 16 16s14-6 16-16c2-12-2-20-10-24V8"/><path d="M22 18c-6 0-8 6-4 10M42 18c6 0 8 6 4 10"/><path d="M20 34h24"/>',
  dice: '<rect x="10" y="20" width="22" height="22" rx="4"/><circle cx="17" cy="27" r="1.6" fill="currentColor"/><circle cx="25" cy="35" r="1.6" fill="currentColor"/><path d="M36 30c4-8 14-8 18 0 2 4 0 10-4 12l-4 8-4-8c-4-2-8-8-6-12Z"/>',
  storm: '<path d="M16 32a10 10 0 0 1 2-20 14 14 0 0 1 26 2 9 9 0 0 1 2 18Z"/><path d="M34 32l-6 12h8l-6 14"/><path d="M18 40l-2 6M48 40l-2 6"/>',
  festival: '<path d="M22 22h20l-2 12a8 8 0 0 1-16 0Z"/><path d="M32 42v10M24 54h16"/><path d="M6 10c8 6 16 6 26 0s18-6 26 0"/><circle cx="12" cy="14" r="2"/><circle cx="32" cy="12" r="2"/><circle cx="52" cy="14" r="2"/>',
  satyr: '<path d="M22 22c-6-6-6-14 0-16 2 4 4 8 6 10M42 22c6-6 6-14 0-16-2 4-4 8-6 10"/><path d="M22 22c0 12 4 20 10 20s10-8 10-20c-4-4-16-4-20 0Z"/><circle cx="28" cy="28" r="1.6" fill="currentColor"/><circle cx="36" cy="28" r="1.6" fill="currentColor"/><path d="M28 36c2 2 6 2 8 0"/><path d="M28 42l4 10 4-10"/>',
  oracle: '<rect x="12" y="14" width="16" height="22" rx="3"/><rect x="36" y="14" width="16" height="22" rx="3"/><path d="M20 21v8M42 21h4l-4 8h6"/><path d="M8 44h48M14 44v12M50 44v12"/>',
  cups: '<path d="M6 46l4-22h12l4 22Z"/><path d="M26 46l4-22h12l4 22Z"/><path d="M46 46l4-22h8l-2 22"/><path d="M4 50h56"/><circle cx="36" cy="54" r="3"/>',
  merchant: '<path d="M6 44h52l-6 12H12Z"/><path d="M32 44V6"/><path d="M32 8c10 4 16 14 16 26H32"/><path d="M32 10c-8 4-14 12-14 24h14"/><rect x="12" y="36" width="8" height="8"/><rect x="44" y="36" width="8" height="8"/>',
  dolphins: '<path d="M8 40c6-14 22-20 34-12-4 0-6 2-8 4 6 2 10 6 12 12-8-6-20-8-28-2Z"/><circle cx="16" cy="36" r="1.4" fill="currentColor"/><path d="M30 24l4-8 4 6"/><path d="M4 54c8-4 16-4 26 0s18 4 28 0"/>',
  whirlpool: '<path d="M32 32m-4 0a4 4 0 1 0 8 0a8 8 0 1 0-16 0a12 12 0 1 0 24 0a16 16 0 1 0-32 0a20 20 0 1 0 40 0"/>',
  fog: '<path d="M8 22h30M14 30h40M6 38h34M18 46h38M10 54h26"/><path d="M44 22h12M46 38h12"/>',
  wreck: '<path d="M8 40l40-12 8 8-36 14Z"/><path d="M26 34L20 10M20 12l14 8"/><path d="M4 54c8-4 16-4 26 0s18 4 28 0"/><circle cx="44" cy="46" r="2"/><circle cx="50" cy="44" r="1.4"/>',
  serpent: '<path d="M6 44c4-8 10-8 14 0s10 8 14 0 10-8 14 0"/><path d="M48 44c2-10 2-20 8-24 4-2 6 2 4 6l-4 2"/><circle cx="56" cy="22" r="1.4" fill="currentColor"/><path d="M4 54c8-4 16-4 26 0s18 4 28 0"/>',
  echo: '<circle cx="18" cy="32" r="6"/><path d="M28 22c6 6 6 14 0 20M36 16c10 10 10 22 0 32M44 10c14 14 14 30 0 44"/>',
  flower: '<circle cx="32" cy="22" r="5"/><path d="M32 17c0-8 8-8 8-2 6-2 8 6 2 8 4 6-2 10-6 6-2 6-10 4-8-2-6 2-8-6-2-8-2-6 6-8 6-2"/><path d="M32 28v28M32 42c-6-4-12-2-14 2M32 46c6-4 12-2 14 2"/><path d="M14 58h36"/>',
  pomegranate: '<path d="M32 16c-12 0-20 9-20 20s8 20 20 20 20-9 20-20-8-20-20-20Z"/><path d="M26 16l2-6 4 4 4-4 2 6"/><circle cx="28" cy="34" r="2"/><circle cx="36" cy="32" r="2"/><circle cx="32" cy="40" r="2"/><circle cx="24" cy="42" r="2"/><circle cx="40" cy="41" r="2"/>',
  wisp: '<path d="M32 50c-10 0-14-8-12-16 2-6 8-8 8-16 6 4 4 10 8 12 2-4 2-8 0-12 8 6 10 14 8 20-2 8-6 12-12 12Z"/><circle cx="32" cy="40" r="4"/><path d="M10 16h.1M52 12h.1M50 46h.1M14 44h.1"/>',
  spider: '<path d="M32 4v56M4 32h56M12 12l40 40M52 12L12 52"/><path d="M32 16l11 5 5 11-5 11-11 5-11-5-5-11 5-11Z"/><circle cx="40" cy="40" r="5" fill="currentColor"/>',
  crow: '<path d="M10 40c8-2 14-8 18-16 4-8 12-12 20-8l8 2-8 4c2 8-2 16-10 20-6 2-14 0-28-2Z"/><circle cx="44" cy="20" r="1.6" fill="currentColor"/><path d="M28 44l-2 10M34 44l2 10"/><rect x="38" y="48" width="18" height="10" rx="1"/>',
  witch: '<path d="M14 30h36l-4 20a6 6 0 0 1-6 4H24a6 6 0 0 1-6-4Z"/><path d="M12 30h40"/><path d="M24 24c0-6 4-6 4-12M34 24c0-4 4-4 4-10"/><path d="M18 54l-4 6M46 54l4 6"/>',
  boar: '<path d="M8 40c0-12 10-20 24-20s20 6 24 14l-4 4H40"/><path d="M48 32c4 2 6 8 4 10"/><path d="M44 38c-2 2-4 6-2 8"/><circle cx="44" cy="30" r="1.6" fill="currentColor"/><path d="M14 44v10M22 46v8M36 46v8M44 44v10"/><path d="M8 34l-4-4"/>',
  owl: '<path d="M18 16l6 6M46 16l-6 6"/><path d="M16 26c0-8 8-12 16-12s16 4 16 12v14c0 10-8 16-16 16s-16-6-16-16Z"/><circle cx="26" cy="28" r="5"/><circle cx="38" cy="28" r="5"/><path d="M32 32l-2 4h4Z"/><path d="M24 44c4 2 12 2 16 0"/>',
  leaves: '<path d="M14 40c0-14 12-26 28-28-2 16-14 28-28 28Z"/><path d="M14 40l20-20"/><path d="M36 50c2-10 10-16 20-16-2 10-10 16-20 16Z"/><path d="M8 56c6-2 12-6 14-12"/>',
  fire: '<path d="M32 46c-8 0-12-6-10-12 2-6 6-8 6-14 6 4 6 8 8 10 2-2 2-6 0-8 8 4 10 12 8 16-2 6-6 8-12 8Z"/><path d="M14 54l36-6M14 48l36 6"/>',
  herm: '<rect x="22" y="26" width="20" height="30"/><circle cx="32" cy="16" r="9"/><path d="M26 14c2-4 10-4 12 0"/><path d="M18 56h28"/><path d="M28 18h.1M36 18h.1M29 22c2 1 4 1 6 0"/>',
  fox: '<path d="M12 18l8 10M52 18l-8 10"/><path d="M12 18c2 10 6 14 10 16l10 12 10-12c4-2 8-6 10-16-6 4-12 6-20 6s-14-2-20-6Z"/><circle cx="26" cy="32" r="1.6" fill="currentColor"/><circle cx="38" cy="32" r="1.6" fill="currentColor"/><path d="M8 56c10-6 30-6 40 0 4 2 8 0 10-4"/>',
  brook: '<path d="M16 34c0 8 7 12 16 12s16-4 16-12Z"/><path d="M32 34V18l8 6-8 4"/><path d="M4 50c8-4 16-4 26 0s18 4 28 0"/><path d="M8 58c8-3 14-3 22 0s14 3 22 0"/>',
  bear: '<circle cx="32" cy="38" r="14"/><circle cx="20" cy="18" r="6"/><circle cx="44" cy="18" r="6"/><circle cx="14" cy="28" r="4"/><circle cx="50" cy="28" r="4"/>',
  sheep: '<path d="M14 36c-4-4-2-10 4-10 0-6 8-8 12-4 4-4 12-2 12 4 6 0 8 6 4 10 2 6-4 10-8 8-4 4-12 4-16 0-4 2-10-2-8-8Z"/><path d="M46 30c4-2 10 0 10 6s-6 6-10 4"/><path d="M22 46v10M30 48v8M38 48v8"/>',
  feast: '<path d="M6 40h52"/><path d="M12 40v14M52 40v14"/><path d="M14 40c0-8 6-12 12-12s12 4 12 12"/><path d="M42 40v-8h10v8"/><path d="M20 22c0-4 4-4 4-8M30 22c0-4 4-4 4-8"/>',
  acorn: '<path d="M18 26c0-8 6-12 14-12s14 4 14 12Z"/><path d="M32 14v-6"/><path d="M20 26c0 14 6 26 12 26s12-12 12-26"/><path d="M22 20h20"/>',
  paths: '<path d="M32 58V38"/><path d="M32 38c0-10-14-12-18-28M32 38c0-10 14-12 18-28M32 38V8"/><circle cx="14" cy="10" r="3"/><circle cx="32" cy="8" r="3"/><circle cx="50" cy="10" r="3"/>',
  mushrooms: '<path d="M10 36c0-10 8-16 16-16s16 6 16 16Z"/><path d="M20 36v14h12V36"/><path d="M38 44c0-6 5-10 10-10s10 4 10 10Z"/><path d="M44 44v8h8v-8"/><circle cx="20" cy="28" r="2"/><circle cx="30" cy="26" r="2"/><path d="M4 56h56"/>',
  market: '<path d="M10 28l22-16 22 16"/><path d="M14 28v26M50 28v26"/><path d="M10 28h44"/><path d="M26 54V40h12v14"/><path d="M32 12V6"/><circle cx="20" cy="36" r="3"/><circle cx="44" cy="36" r="3"/>',
  hound: '<path d="M10 30l10-12 6 6c6-2 14-2 20 4l8 2-2 8-8 2c-2 6-8 10-14 10H20c-6 0-10-6-10-12Z"/><circle cx="40" cy="30" r="1.6" fill="currentColor"/><path d="M20 18l-2-10 8 8"/><path d="M8 56c10-6 30-6 46 0"/>',
  sea: '<path d="M4 30c8-6 14-6 20 0s12 6 20 0 12-6 16-2"/><path d="M4 42c8-6 14-6 20 0s12 6 20 0 12-6 16-2"/><path d="M4 54c8-6 14-6 20 0s12 6 20 0 12-6 16-2"/><circle cx="46" cy="14" r="6"/>',
};
const ART_ALIAS = { narcissus: 'flower', spider: 'spider', paths: 'paths' };
const motif = (k) => M[k] || M[ART_ALIAS[k]] || M.sea;

function svgIcon(k, size = 24) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${motif(k)}</svg>`;
}

/* the illustration band: a stage backdrop + a gilt medallion with the motif */
function artBand(art, stage) {
  const vale = stage === 'autumn';
  const sky = vale ? ['#4a2412', '#b8641f', '#f2b45a'] : ['#0e2a3c', '#2e6f86', '#e8c27a'];
  const back = vale
    ? '<g fill="#2a140a" opacity=".85">' +
      '<path d="M0 104V70c10-8 18-30 26-30s14 22 22 30c6-14 14-40 24-40s16 26 22 40 12-24 20-24 12 18 16 28V104Z"/>' +
      '<path d="M200 104V74c8-10 16-36 26-36s14 24 22 34c6-12 14-30 22-30s16 22 22 30 10-12 18-12 10 8 10 14V104Z"/></g>' +
      '<g fill="#f0a24f" opacity=".7"><circle cx="40" cy="30" r="2"/><circle cx="270" cy="22" r="2.4"/><circle cx="230" cy="48" r="1.6"/><circle cx="80" cy="54" r="1.8"/></g>'
    : '<circle cx="262" cy="34" r="16" fill="#ffe7a8" opacity=".85"/>' +
      '<g fill="none" stroke="#bfe3ea" stroke-width="2" opacity=".55">' +
      '<path d="M0 78c20-6 34-6 52 0s34 6 52 0 34-6 52 0 34 6 52 0 34-6 52 0 34 6 60 0"/>' +
      '<path d="M0 92c20-6 34-6 52 0s34 6 52 0 34-6 52 0 34 6 52 0 34-6 52 0 34 6 60 0"/></g>' +
      '<path d="M0 104V84c40-6 80-8 120-4s100 6 200 0V104Z" fill="#0b2433" opacity=".7"/>';
  const id = `g${Math.random().toString(36).slice(2, 7)}`;
  return `<svg viewBox="0 0 320 104" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${sky[0]}"/><stop offset=".62" stop-color="${sky[1]}"/>
      <stop offset="1" stop-color="${sky[2]}"/></linearGradient></defs>
    <rect width="320" height="104" fill="url(#${id})"/>${back}</svg>
    <svg viewBox="0 0 104 104" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs><radialGradient id="${id}m" cx=".5" cy=".4" r=".6">
      <stop offset="0" stop-color="#1b2c3d"/><stop offset="1" stop-color="#0b141d"/></radialGradient></defs>
    <circle cx="52" cy="52" r="47" fill="#8a6c1c"/><circle cx="52" cy="52" r="44" fill="url(#${id}m)"/>
    <circle cx="52" cy="52" r="40" fill="none" stroke="#c9a227" stroke-width="1" opacity=".6"/>
    <g transform="translate(26 26) scale(.8125)" fill="none" stroke="#f0d060" stroke-width="2.6"
       stroke-linecap="round" stroke-linejoin="round">${motif(art)}</g></svg>`;
}

/* glyphs for the code-breaker (owl · olive · wave · star) */
const GLYPHS = [
  '<circle cx="24" cy="26" r="6"/><circle cx="40" cy="26" r="6"/><path d="M32 32l-3 5h6Z"/><path d="M16 16l6 5M48 16l-6 5"/><path d="M18 40c4 10 24 10 28 0"/>',
  '<path d="M14 50C24 34 36 22 52 14"/><path d="M26 38c-8-2-12-8-10-14 8 0 12 6 10 14Z"/><path d="M38 28c-2-8 2-14 10-14 0 8-4 12-10 14Z"/><ellipse cx="24" cy="50" rx="5" ry="7"/>',
  '<path d="M6 30c8-8 14-8 20 0s12 8 20 0 10-6 12-4"/><path d="M6 44c8-8 14-8 20 0s12 8 20 0 10-6 12-4"/>',
  '<path d="M32 8l6 16 18 2-14 11 4 17-14-9-14 9 4-17L8 26l18-2Z"/>',
];
const glyph = (i, size = 40) => `<svg viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[i] || ''}</svg>`;
const GLYPH_NAMES = ['owl', 'olive', 'wave', 'star'];
const CUP_SVG = '<svg viewBox="0 0 54 46" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M10 40 16 6h22l6 34Z"/><path d="M6 42h42"/></svg>';
const JAR_SVG = '<svg viewBox="0 0 26 36" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3h8M10 3v4c-5 3-7 8-6 15 1 7 4 11 9 11s8-4 9-11c1-7-1-12-6-15V3"/><path d="M8 9c-4 0-5 4-2 6M18 9c4 0 5 4 2 6"/></svg>';

/* ── setup ──────────────────────────────────────────────────────────────── */
export function initEvents(sendFn) {
  send = sendFn;
  if (els) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/static/events.css';
  document.head.appendChild(link);
  const modal = document.createElement('div');
  modal.id = 'evModal';
  modal.className = 'overlay hidden';
  modal.innerHTML = '<div class="evcard parch" role="dialog" aria-modal="true"></div>';
  const result = document.createElement('div');
  result.id = 'evResult';
  result.className = 'parch hidden';
  result.setAttribute('role', 'status');
  result.addEventListener('click', () => result.classList.add('hidden'));
  const hud = document.createElement('div');
  hud.id = 'evHud';
  document.body.append(modal, result, hud);
  els = { modal, card: modal.firstChild, result, hud };
  // number keys pick the numbered buttons on an open card
  window.addEventListener('keydown', (e) => {
    if (els.modal.classList.contains('hidden')) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const b = els.card.querySelector(`[data-key="${e.key.toLowerCase()}"]`);
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  });
}

/* the shared minigame card's header for an event PUZZLE */
export function eventMinigameTitle(m) {
  return m && m.event ? (m.event_title || 'An Encounter') : null;
}

/* ── per-render ─────────────────────────────────────────────────────────── */
export function renderEvents(room, you, opts = {}) {
  if (!els) return;
  if (!room || room.phase === 'lobby' || room.phase === 'finished') {
    els.modal.classList.add('hidden');
    els.hud.innerHTML = '';
    els.result.classList.add('hidden');
    lastCardSeq = room?.event_card?.seq ?? null;
    return;
  }
  renderHud(room, you);
  renderResult(room, you);
  renderCard(room, you, opts);
}

function nameOf(room, pid) {
  return room.players.find((p) => p.pid === pid)?.name || 'A captain';
}

function stageLabel(stage) {
  return stage === 'autumn' ? 'The Amber Vale' : stage === 'hub' ? 'The Isles of Peace' : (stage || '');
}

/* ── HUD: my boons and banes, the wonders on the chart ─────────────────── */
let hudSig = '';
function renderHud(room, you) {
  const me = room.players.find((p) => p.pid === you);
  const info = room.event_info?.buffs || {};
  const buffs = Object.entries(me?.buffs || {});
  // the wonders of the stage you stand in (the chart lists the rest)
  const byId = {};
  for (const n of room.board?.nodes || []) byId[n.id] = n;
  const here = byId[me?.node]?.region || null;
  const world = (room.world || []).filter((w) => (byId[w.node]?.region || null) === here);
  const sig = JSON.stringify([buffs, world.map((w) => [w.wid, w.rounds])]);
  if (sig === hudSig) return;
  hudSig = sig;
  const chips = [];
  for (const [id, n] of buffs) {
    const b = info[id] || { name: id, desc: '', good: true };
    chips.push(`<div class="evchipH ${b.good ? '' : 'bane'}" title="${esc(b.desc)}">` +
      `${svgIcon(id === 'fair_wind' ? 'regatta' : id === 'becalmed' ? 'fog' : id === 'jinx' ? 'storm' : 'nereid', 22)}` +
      `<span><b>${esc(b.name)}</b> <em>×${n}</em></span></div>`);
  }
  for (const w of world.slice(0, 4)) {
    chips.push(`<div class="evchipH" title="${esc(w.text)}">${svgIcon(w.art, 22)}` +
      `<span>${esc(w.title)} <em>${w.rounds} round${w.rounds === 1 ? '' : 's'}</em></span></div>`);
  }
  els.hud.innerHTML = chips.join('');
}

/* ── the result card ────────────────────────────────────────────────────── */
function renderResult(room, you) {
  const c = room.event_card;
  if (lastCardSeq === null) {                // first snapshot: a card already
    lastCardSeq = c ? c.seq : 0;             // on the table is stale news
    return;
  }
  if (!c) return;
  if (c.seq === lastCardSeq) return;
  lastCardSeq = c.seq;
  const mine = c.pid === you;
  const lines = (c.lines || []).map((l, i) => `<li class="${i === 0 ? 'first' : ''}">${esc(stripEmoji(l))}</li>`).join('');
  els.result.innerHTML = `<div class="evres ${c.ok === false ? 'bad' : ''}">
    <div class="ic">${svgIcon(c.art, 36)}</div>
    <div><h3>${esc(c.title)}</h3><div class="who">${mine ? 'You' : esc(nameOf(room, c.pid))}</div>
    <ul>${lines}</ul></div></div>`;
  els.result.classList.remove('hidden');
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => els.result.classList.add('hidden'), mine ? 9000 : 6500);
}

/* ── the card: options · game · table ──────────────────────────────────── */
function renderCard(room, you, opts) {
  const ev = room.event;
  const show = room.phase === 'event' && ev && !opts.hold;
  if (!show) {
    els.modal.classList.add('hidden');
    cancelAnimationFrame(clockRAF);
    shownKey = '';
    return;
  }
  const actor = ev.pid === you;
  const seated = room.players.some((p) => p.pid === you);
  const key = `${ev.id}:${ev.pid}:${ev.step}`;
  if (scratch.key !== key) scratch = { key, sel: [], mode: 'left', pans: {}, value: null };
  // re-render on any change of the public event
  const sig = JSON.stringify([ev, room.players.map((p) => p.scrolls), you]);
  if (sig === shownKey) return;
  shownKey = sig;
  els.modal.classList.remove('hidden');
  els.modal.classList.toggle('watch', !actor && ev.step !== 'table');

  let body = `<div class="evhead"><span>${ev.step === 'table' ? 'The whole table' : 'An encounter'}</span>` +
    `<span class="evwhere">${esc(stageLabel(ev.stage))}</span></div>` +
    `<div class="evart">${artBand(ev.art, ev.stage)}</div><div class="evbody">` +
    `<h2>${esc(ev.title)}</h2><p class="evtext">${esc(ev.text)}</p>` +
    (ev.intro ? `<p class="evintro">${esc(ev.intro)}</p>` : '');
  if (ev.step === 'card') body += cardOptions(ev, actor, room);
  else if (ev.step === 'game') body += gameBody(ev, actor, room, you, seated);
  else if (ev.step === 'table') body += tableBody(ev, room, you, seated);
  body += '</div>';
  els.card.innerHTML = body;
  wire(ev, actor, room, you);
  const first = els.card.querySelector('.evopt:not(:disabled), .evbtn:not(:disabled)');
  if (actor && first && !els.card.contains(document.activeElement)) first.focus({ preventScroll: true });
  tickClock(ev);
}

function cardOptions(ev, actor, room) {
  if (!actor) {
    const list = ev.options.map((o) => `<li>${esc(o.label)} <small>— ${esc(o.stakes)}</small></li>`).join('');
    return `<p class="evwho"><strong>${esc(nameOf(room, ev.pid))}</strong> is deciding…</p>` +
      `<ul class="evlog" style="list-style:none">${list}</ul>`;
  }
  return '<div class="evopts">' + ev.options.map((o, i) =>
    `<button class="evopt ${o.ok ? '' : 'why'}" data-opt="${i}" data-key="${i + 1}" ${o.ok ? '' : 'disabled'}>` +
    `<span class="evnum">${i + 1}</span><span class="evlab">${esc(o.label)}` +
    `<small>${esc(o.ok || o.stakes.includes('needs') ? o.stakes : `${o.stakes} — ${o.why}`)}</small></span></button>`).join('') + '</div>';
}

/* ── solo games ─────────────────────────────────────────────────────────── */
function gameBody(ev, actor, room, you, seated) {
  const g = ev.game || {};
  const name = room.event_info?.games?.[g.kind] || 'A game';
  let h = `<div class="evgame"><div class="evprompt">${esc(name)}</div>`;
  h += ({
    knucklebones: gKnuckle, higher_lower: gHiLo, codebreak: gCode, shells: gShells,
    weigh: gWeigh, crossing: gCross, rps: gRps, nim: gNim,
  }[g.kind] || (() => ''))(g, actor);
  h += '</div>';
  if (!actor) {
    h += `<p class="evwho"><strong>${esc(nameOf(room, ev.pid))}</strong> is playing…</p>`;
    if (seated && !(you in (ev.bets || {}))) {
      h += `<div class="evbets">Call it — a right call skims a scroll:<div class="evrow">` +
        `<button class="evbtn cool" data-bet="1" data-key="y">They win</button>` +
        `<button class="evbtn hot" data-bet="0" data-key="n">They lose</button></div></div>`;
    } else if (seated) {
      h += `<div class="evbets">Your call is in: <strong>${ev.bets[you] ? 'they win' : 'they lose'}</strong>.</div>`;
    }
  }
  return h;
}

function btn(label, attrs, cls = '', key = '', sub = '') {
  return `<button class="evbtn ${cls}" ${attrs} ${key ? `data-key="${key}"` : ''}>${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
}

function gKnuckle(g, actor) {
  const goals = (g.goals || []).map((t) => `<span class="${g.pot >= t ? 'met' : ''}">${t}+</span>`).join('');
  const bones = (g.throws || []).map((f) => `<span class="evbone ${f === 1 ? 'dog' : ''}">${f}</span>`).join('');
  return `<div class="evbig">${g.pot}</div><div class="evsmall">points in the pot · a 1 (the dog) loses it all</div>` +
    `<div class="evgoals">${goals}</div><div class="evbones">${bones}</div>` +
    (actor ? `<div class="evrow">${btn('Throw', 'data-mv="throw"', '', 't')}${btn('Stop', 'data-mv="stop"', 'cool', 's', 'keep the pot')}</div>` : '');
}

function gHiLo(g, actor) {
  const spent = {};
  for (const v of g.spent || []) spent[v] = (spent[v] || 0) + 1;
  const counts = Array.from({ length: 9 }, (_, i) => {
    const v = i + 1, left = 2 - (spent[v] || 0);
    return `<div class="${left <= 0 ? 'gone' : ''}">${v}<i>${left} left</i></div>`;
  }).join('');
  const last = g.last ? `<div class="evsmall">You called ${esc(g.last.call)}: ${g.last.from} → ${g.last.to}</div>` : '';
  return `<div class="evtile">${g.tile}</div>${last}` +
    `<div class="evstat">Streak ${g.streak} of ${g.need}</div><div class="evcount">${counts}</div>` +
    (actor ? `<div class="evrow">${btn('Higher', 'data-mv="higher"', '', 'h')}${btn('Lower', 'data-mv="lower"', '', 'l')}` +
      `${btn('Stop', 'data-mv="stop"', 'cool', 's', g.streak >= 2 ? 'collect' : 'walk away')}</div>` : '');
}

function gCode(g, actor) {
  const sel = scratch.sel;
  const slots = Array.from({ length: g.length || 3 }, (_, i) =>
    `<button class="evslot ${sel[i] !== undefined ? 'full' : ''}" data-slot="${i}" aria-label="slot ${i + 1}">` +
    `${sel[i] !== undefined ? glyph(sel[i]) : ''}</button>`).join('');
  const glyphs = GLYPHS.map((_, i) => `<button class="evglyph" data-glyph="${i}" data-key="${i + 1}" ` +
    `${sel.includes(i) || sel.length >= (g.length || 3) ? 'disabled' : ''} aria-label="${GLYPH_NAMES[i]}">${glyph(i)}</button>`).join('');
  const rows = (g.guesses || []).map((r) => `<div class="evguess">` +
    r.glyphs.map((x) => `<span class="g">${glyph(x, 30)}</span>`).join('') +
    `<span class="fb">${'<i class="evpeg placed"></i>'.repeat(r.placed)}${'<i class="evpeg present"></i>'.repeat(r.present)} ` +
    `${r.placed} placed · ${r.present} present</span></div>`).join('');
  return `<div class="evsmall">Three different glyphs. ${g.tries - (g.guesses || []).length} tries left.</div>` +
    (actor ? `<div class="evslots">${slots}</div><div class="evrow">${glyphs}</div>` +
      `<div class="evrow">${btn('Try the seal', 'data-code="1"', '', 'enter')}</div>` : '') +
    `<div class="evguesses">${rows}</div>`;
}

function gShells(g, actor) {
  const cups = (g.signs || []).map((s, i) =>
    `<button class="evcup ${g.pearl === i ? 'pearl' : ''}" data-mv-int="${i}" data-key="${i + 1}" ${actor ? '' : 'disabled'}>` +
    `${CUP_SVG}<span>${esc(s)}</span></button>`).join('');
  return `<div class="evtell">Exactly ${g.truths} of these signs ${g.truths === 1 ? 'is' : 'are'} true.</div>` +
    `<div class="evcups">${cups}</div>` + (actor ? '<div class="evsmall">Read the signs, then lift one cup.</div>' : '');
}

function gWeigh(g, actor) {
  const sus = suspects(g);
  const jars = Array.from({ length: g.jars }, (_, i) => {
    const pan = scratch.pans[i];
    return `<button class="evjar ${pan || ''} ${sus.includes(i) ? '' : 'cleared'}" data-jar="${i}" ${actor ? '' : 'disabled'}>` +
      `${JAR_SVG}<span>${i + 1}</span></button>`;
  }).join('');
  const log = (g.log || []).map((w) => `<div>${w.left.map((x) => x + 1).join(' ')} vs ${w.right.map((x) => x + 1).join(' ')} — ` +
    `${w.tip === 'level' ? 'level' : `the ${w.tip} pan sinks`}</div>`).join('');
  const nl = Object.values(scratch.pans).filter((v) => v === 'left').length;
  const nr = Object.values(scratch.pans).filter((v) => v === 'right').length;
  const seg = actor ? `<div class="evseg">${btn('Left pan', 'data-mode="left"', `cool ${scratch.mode === 'left' ? 'sel' : ''}`, 'q')}` +
    `${btn('Right pan', 'data-mode="right"', `hot ${scratch.mode === 'right' ? 'sel' : ''}`, 'w')}` +
    `${btn('Choose jar', 'data-mode="pick"', `ghost ${scratch.mode === 'pick' ? 'sel' : ''}`, 'e')}</div>` : '';
  return `<div class="evsmall">${g.weighings_left} weighing${g.weighings_left === 1 ? '' : 's'} left · ` +
    `put equal numbers on each pan · faded jars are cleared by what you have seen</div>${seg}` +
    `<div class="evjars">${jars}</div>` +
    (actor ? `<div class="evrow">${btn(`Weigh ${nl} vs ${nr}`, `data-weigh="1" ${nl && nl === nr && g.weighings_left > 0 ? '' : 'disabled'}`, '', 'enter')}` +
      `${btn('Clear pans', 'data-clear="1"', 'ghost', 'c')}</div>` : '') +
    `<div class="evlog">${log}</div>`;
}

function suspects(g) {
  let sus = Array.from({ length: g.jars }, (_, i) => i);
  for (const w of g.log || []) {
    if (w.tip === 'left') sus = sus.filter((x) => w.left.includes(x));
    else if (w.tip === 'right') sus = sus.filter((x) => w.right.includes(x));
    else sus = sus.filter((x) => !w.left.includes(x) && !w.right.includes(x));
  }
  return sus;
}

function gCross(g, actor) {
  const names = g.names || {};
  const nm = (x) => names[x] || x;
  const chips = (side) => (g[side] || []).map((x) => `<span class="evchip">${esc(nm(x))}</span>`).join('');
  const here = g[g.boat] || [];
  const btns = actor ? `<div class="evrow">${btn('Cross alone', 'data-take=""', 'ghost', '0')}` +
    here.map((x, i) => btn(`Take the ${esc(nm(x))}`, `data-take="${esc(x)}"`, '', String(i + 1))).join('') + '</div>' : '';
  return `<div class="evsmall">The skiff holds you and one more. ${esc(nm('wolf'))} eats ${esc(nm('goat'))}; ` +
    `${esc(nm('goat'))} eats ${esc(nm('charts'))}. Trip ${g.trips} of ${g.max_trips}.</div>` +
    `<div class="evbanks"><div class="evbank"><b>This bank</b>${chips('near')}</div>` +
    `<div class="evriver ${g.boat}">skiff</div><div class="evbank"><b>Far bank</b>${chips('far')}</div></div>${btns}`;
}

function gRps(g, actor) {
  const rounds = (g.rounds || []).map((r) => `<div>${esc(r.tell)} → he threw <strong>${r.satyr}</strong>; ` +
    `you threw ${r.you} — ${r.winner === 'tie' ? 'a draw' : r.winner === 'you' ? 'you win' : 'he wins'}</div>`).join('');
  return `<div class="evscore"><span>You ${g.you}</span><span>Satyr ${g.satyr}</span></div>` +
    `<div class="evsmall">First to ${g.need}. His tells never lie — learn them.</div>` +
    `<div class="evtell">${esc(g.tell || '')}</div>` +
    (actor ? `<div class="evrow">${btn('Stone', 'data-mv="stone"', '', '1', 'breaks shears')}` +
      `${btn('Scroll', 'data-mv="scroll"', '', '2', 'wraps stone')}${btn('Shears', 'data-mv="shears"', '', '3', 'cut scroll')}</div>` : '') +
    `<div class="evlog">${rounds}</div>`;
}

function gNim(g, actor) {
  const peb = '<i></i>'.repeat(g.pile || 0);
  const hist = (g.history || []).slice(-6).map((h) => `<div>${h.who === 'you' ? 'You take' : 'The sage takes'} ${h.take}</div>`).join('');
  return `<div class="evbig">${g.pile}</div><div class="evsmall">pebbles · take 1, 2 or 3 · whoever takes the last pebble wins</div>` +
    `<div class="evpebbles">${peb}</div>` +
    (actor ? `<div class="evrow">${[1, 2, 3].map((n) => btn(`Take ${n}`, `data-take-n="${n}" ${n > g.pile ? 'disabled' : ''}`, '', String(n))).join('')}</div>` : '') +
    `<div class="evlog">${hist}</div>`;
}

/* ── table events ───────────────────────────────────────────────────────── */
function tableBody(ev, room, you, seated) {
  const t = ev.table || {};
  const st = t.st || {};
  const me = room.players.find((p) => p.pid === you);
  let h = `<div class="evtable"><div class="evprompt">${esc(t.prompt || '')}</div>`;
  if (seated && !t.mine_in) {
    const k = st.kind;
    if (k === 'bid' || k === 'guess') {
      const lo = k === 'bid' ? 0 : st.lo;
      const hi = k === 'bid' ? Math.min(st.cap, me?.scrolls ?? 0) : st.hi;
      if (scratch.value === null) scratch.value = k === 'bid' ? 0 : Math.round((lo + hi) / 2);
      scratch.value = Math.max(lo, Math.min(hi, scratch.value));
      const big = k === 'guess' ? 10 : 0;
      h += `<div class="evstep">${big ? btn(`−${big}`, `data-step="-${big}"`, 'ghost') : ''}${btn('−1', 'data-step="-1"', 'ghost', '-')}` +
        `<output>${scratch.value}</output>${btn('+1', 'data-step="1"', 'ghost', '+')}${big ? btn(`+${big}`, `data-step="${big}"`, 'ghost') : ''}</div>` +
        `<div class="evsmall">${k === 'bid' ? `from 0 to ${hi} scrolls (0 sits it out)` : `between ${lo} and ${hi}`}</div>` +
        `<div class="evrow">${btn(k === 'bid' ? 'Seal my bid' : 'Seal my guess', 'data-ans="v"', '', 'enter')}</div>`;
    } else if (k === 'vote') {
      h += '<div class="evopts">' + (st.choices || []).map((c, i) =>
        `<button class="evopt" data-ans-int="${i}" data-key="${i + 1}"><span class="evnum">${i + 1}</span><span class="evlab">${esc(c)}</span></button>`).join('') + '</div>';
    } else if (k === 'gamble') {
      h += `<div class="evrow">${btn(`Ante ${st.ante}`, `data-ans-str="in" ${(me?.scrolls ?? 0) >= st.ante ? '' : 'disabled'}`, '', '1')}` +
        `${btn('Stay out', 'data-ans-str="out"', 'ghost', '2')}</div>`;
    } else if (k === 'lanes') {
      h += `<div class="evrow">${Array.from({ length: st.n }, (_, i) => btn(`Lane ${i + 1}`, `data-ans-int="${i}"`, 'cool', String(i + 1))).join('')}</div>`;
    } else if (k === 'lowest') {
      h += `<div class="evrow">${Array.from({ length: st.max }, (_, i) => btn(String(i + 1), `data-ans-int="${i + 1}"`, '', String(i + 1))).join('')}</div>`;
    }
  } else if (seated) {
    const v = t.mine;
    h += `<div class="evwait">Your answer is sealed${v === null || v === undefined ? ' — you sit this one out' : `: <strong>${esc(fmtAns(st, v))}</strong>`}.</div>`;
  }
  const answered = new Set(t.answered || []);
  h += '<div class="evwait">' + room.players.map((p) =>
    `<span class="${answered.has(p.pid) ? 'done' : ''}">${esc(p.pid === you ? 'You' : p.name)}${answered.has(p.pid) ? ' — in' : ' …'}</span>`).join(' · ') + '</div>';
  h += '<div class="evclock"><i></i></div></div>';
  return h;
}

function fmtAns(st, v) {
  if (st.kind === 'vote') return st.choices?.[v] ?? String(v);
  if (st.kind === 'lanes') return `lane ${v + 1}`;
  if (st.kind === 'gamble') return v === 'in' ? 'in' : 'out';
  return String(v);
}

function tickClock(ev) {
  cancelAnimationFrame(clockRAF);
  const dl = ev.table?.deadline;
  const bar = els.card.querySelector('.evclock i');
  if (!dl || !bar) return;
  const total = Math.max(1, dl - Date.now() / 1000);
  const step = () => {
    const left = Math.max(0, dl - Date.now() / 1000);
    bar.style.width = `${Math.min(100, (left / Math.max(total, 40)) * 100)}%`;
    if (left > 0 && !els.modal.classList.contains('hidden')) clockRAF = requestAnimationFrame(step);
  };
  step();
}

/* ── wiring ─────────────────────────────────────────────────────────────── */
function wire(ev, actor, room, you) {
  const q = (sel) => els.card.querySelectorAll(sel);
  const mv = (payload) => send({ type: 'event_move', payload });
  q('[data-opt]').forEach((b) => { b.onclick = () => send({ type: 'event_choose', idx: +b.dataset.opt }); });
  q('[data-mv]').forEach((b) => { b.onclick = () => mv(b.dataset.mv); });
  q('[data-mv-int]').forEach((b) => { b.onclick = () => mv(+b.dataset.mvInt); });
  q('[data-take-n]').forEach((b) => { b.onclick = () => mv({ take: +b.dataset.takeN }); });
  q('[data-take]').forEach((b) => { b.onclick = () => mv({ take: b.dataset.take || null }); });
  q('[data-bet]').forEach((b) => { b.onclick = () => send({ type: 'event_bet', value: b.dataset.bet === '1' }); });
  const redraw = () => { shownKey = ''; renderCard(room, you, {}); };
  // code-breaker
  q('[data-glyph]').forEach((b) => {
    b.onclick = () => { if (scratch.sel.length < 3) scratch.sel.push(+b.dataset.glyph); redraw(); };
  });
  q('[data-slot]').forEach((b) => {
    b.onclick = () => { scratch.sel.splice(+b.dataset.slot, 1); redraw(); };
  });
  q('[data-code]').forEach((b) => {
    b.disabled = scratch.sel.length !== (ev.game?.length || 3);
    b.onclick = () => { const s = scratch.sel.slice(); scratch.sel = []; mv(s); };
  });
  // the balance
  q('[data-mode]').forEach((b) => { b.onclick = () => { scratch.mode = b.dataset.mode; redraw(); }; });
  q('[data-jar]').forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.jar;
      if (scratch.mode === 'pick') { mv({ pick: i }); return; }
      scratch.pans[i] = scratch.pans[i] === scratch.mode ? undefined : scratch.mode;
      redraw();
    };
  });
  q('[data-clear]').forEach((b) => { b.onclick = () => { scratch.pans = {}; redraw(); }; });
  q('[data-weigh]').forEach((b) => {
    b.onclick = () => {
      const left = [], right = [];
      for (const [k, v] of Object.entries(scratch.pans)) {
        if (v === 'left') left.push(+k);
        if (v === 'right') right.push(+k);
      }
      scratch.pans = {};
      mv({ left, right });
    };
  });
  // table answers
  q('[data-step]').forEach((b) => { b.onclick = () => { scratch.value += +b.dataset.step; redraw(); }; });
  q('[data-ans]').forEach((b) => { b.onclick = () => send({ type: 'event_answer', value: scratch.value }); });
  q('[data-ans-int]').forEach((b) => { b.onclick = () => send({ type: 'event_answer', value: +b.dataset.ansInt }); });
  q('[data-ans-str]').forEach((b) => { b.onclick = () => send({ type: 'event_answer', value: b.dataset.ansStr }); });
}
