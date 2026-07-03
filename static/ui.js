/*
 * ui.js — Thalassa UI toolkit (Agent E).
 *
 * Pure, DOM-free helpers shared by app.js:
 *   esc(s)            — HTML entity escape
 *   stripEmoji(s)     — remove emoji/pictographs from engine log lines
 *   icon(name, size?) — inline SVG string, one consistent 24×24 stroke set
 *   glyphSVG(g, size) — raven's-matrix glyph renderer (ported from legacy)
 *
 * Icon style contract: 24×24 viewBox, stroke: currentColor, stroke-width 1.8,
 * round caps/joins, fill "none" (tiny accents may fill currentColor). Colour
 * comes from the surrounding CSS, never from the icon itself.
 */

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* The engine decorates log lines ("⚔ ...", "☠ ...") — chrome shows icons
 * instead, so pictographs are stripped before display. */
const EMOJI_RE = new RegExp(
  '[' +
  '\\u{1F000}-\\u{1FAFF}' +   // emoji blocks
  '\\u{2300}-\\u{23FF}' +     // misc technical (⏳)
  '\\u{2600}-\\u{27BF}' +     // misc symbols + dingbats (⚔ ☠ ⚱ ✗ ✦ ⚡ ⚓)
  '\\u{2B00}-\\u{2BFF}' +
  '\\u{FE0F}\\u{200D}' +      // variation selector, ZWJ
  ']', 'gu');

export function stripEmoji(s) {
  return String(s ?? '').replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/* ── icon set ───────────────────────────────────────────────────────────── */
const I = {
  /* currency / progress */
  scroll: '<path d="M7 4.5h9.5A2.5 2.5 0 0 1 19 7v10.5a2 2 0 0 1-2 2H7"/>' +
    '<path d="M7 4.5A2.25 2.25 0 0 0 4.75 6.75v10.5A2.25 2.25 0 0 0 7 19.5a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 7 4.5Z"/>' +
    '<path d="M12.5 9.5H16M12.5 13H16"/>',
  hull: '<path d="M3.5 13.5 12 12l8.5 1.5-1.7 4.6a2 2 0 0 1-1.9 1.4H7.1a2 2 0 0 1-1.9-1.4Z"/>' +
    '<path d="M12 12V4.5l4.5 4H12"/>',
  relic: '<path d="M12 3.2l1.9 6.9 6.9 1.9-6.9 1.9-1.9 6.9-1.9-6.9L3.2 12l6.9-1.9Z"/>',
  heart: '<path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 0 1 19.4 13Z"/>',
  cargo: '<path d="M9.4 4.4h5.2"/>' +
    '<path d="M10.4 4.4c.4 2-.6 2.8-1.9 3.7A5.4 5.4 0 0 0 12 17.6a5.4 5.4 0 0 0 3.5-9.5c-1.3-.9-2.3-1.7-1.9-3.7"/>' +
    '<path d="M12 17.6v2.8M10 20.4h4"/>',
  streak: '<path d="M12 3.5c.6 2.9-1.2 4.6-2.5 6.1C8.3 11 7.6 12.2 7.6 14a4.4 4.4 0 0 0 8.8.3c0-2.1-1-3.3-1.8-4.7-.6 1-.8 1.8-2.1 2.3.6-2.6-.1-5.4-.5-8.4Z"/>',

  /* consumables */
  gale: '<path d="M3.5 9.5h9a2.4 2.4 0 1 0-2.3-3.1"/>' +
    '<path d="M3.5 13.5h13.4a2.5 2.5 0 1 1-2.4 3.2"/><path d="M3.5 17.5h5"/>',
  horn: '<path d="M4.5 10.2 15 5.8a5.8 5.8 0 0 1 .2 11.5L4.5 14.2Z"/>' +
    '<path d="M4.5 10.2v4"/><path d="M18.3 8.2l2.4-1.4M19 12h2.4"/>',
  hint: '<path d="M2.8 12S6.2 5.9 12 5.9 21.2 12 21.2 12 17.8 18.1 12 18.1 2.8 12 2.8 12Z"/>' +
    '<circle cx="12" cy="12" r="2.7"/>',
  planks: '<rect x="2.8" y="9.6" width="18.4" height="4.8" rx="1.2" transform="rotate(-18 12 12)"/>' +
    '<path d="M7.3 11.2v.01M11.8 9.7v.01M16.3 8.2v.01"/>',
  aegis: '<path d="M12 3l7 2.7v5.9c0 4.3-3 7.5-7 9.4-4-1.9-7-5.1-7-9.4V5.7Z"/>' +
    '<path d="M12 7.4v5.2"/><path d="M12 15.9v.01"/>',

  /* battle stances */
  guard: '<path d="M12 3l7 2.7v5.9c0 4.3-3 7.5-7 9.4-4-1.9-7-5.1-7-9.4V5.7Z"/>' +
    '<path d="M8.8 11.6l2.3 2.3 4.1-4.2"/>',
  strike: '<path d="M4 20l5.5-5.5"/><path d="M8 13.5 17.5 4H20v2.5L10.5 16Z"/>' +
    '<path d="M6.8 14.8l2.4 2.4"/>',
  magic: '<path d="M12 3.6 13.9 9l5.4 1.9-5.4 1.9L12 18.2l-1.9-5.4L4.7 10.9 10.1 9Z"/>' +
    '<path d="M18.6 16.4v3.8M16.7 18.3h3.8"/>',
  flee: '<path d="M12.5 4.5H6.8A1.8 1.8 0 0 0 5 6.3v11.4a1.8 1.8 0 0 0 1.8 1.8h5.7"/>' +
    '<path d="M9.5 12h11"/><path d="M17 8.5 20.5 12 17 15.5"/>',

  /* places / chrome */
  home: '<path d="M3.8 20.2h16.4"/><path d="M6.4 17v-6.2M10.2 17v-6.2M13.8 17v-6.2M17.6 17v-6.2"/>' +
    '<path d="M4.4 10.8h15.2L12 4.2Z"/>',
  compass: '<circle cx="12" cy="12" r="8.4"/>' +
    '<path d="M12 5.8 13.9 12 12 18.2 10.1 12Z" fill="currentColor" stroke="none"/>' +
    '<path d="M5.8 12h1.3M16.9 12h1.3"/>',
  anchor: '<circle cx="12" cy="5.4" r="2.1"/><path d="M12 7.5V20"/>' +
    '<path d="M4.8 12.6C4.8 17 8 20 12 20s7.2-3 7.2-7.4"/><path d="M9.2 10.4h5.6"/>' +
    '<path d="M4.8 12.6 3 11.4M19.2 12.6l1.8-1.2"/>',
  market: '<path d="M4.2 4.5h15.6l1 3.6a2.6 2.6 0 0 1-5.2.4 2.6 2.6 0 0 1-3.6.6 2.6 2.6 0 0 1-3.6-.6 2.6 2.6 0 0 1-5.2-.4Z"/>' +
    '<path d="M5.2 11.2v8.3h13.6v-8.3"/><path d="M9.6 19.5v-4.6h4.8v4.6"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.6"/>' +
    '<circle cx="8.7" cy="8.7" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="15.3" cy="15.3" r="1.4" fill="currentColor" stroke="none"/>',
  skull: '<path d="M12 3.5a7 7 0 0 0-7 7c0 2.6 1.4 4.4 3 5.5V19a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 19v-3c1.6-1.1 3-2.9 3-5.5a7 7 0 0 0-7-7Z"/>' +
    '<circle cx="9.3" cy="11" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="14.7" cy="11" r="1.4" fill="currentColor" stroke="none"/>' +
    '<path d="M10.6 20.5v-1.6M13.4 20.5v-1.6"/>',
  crown: '<path d="M4.4 16.8 3.4 7.6l4.8 3.4L12 5l3.8 6 4.8-3.4-1 9.2Z"/><path d="M5.5 19.8h13"/>',
  laurel: '<path d="M6.8 4.2C5.4 9.8 7.4 15.2 12 18.6c4.6-3.4 6.6-8.8 5.2-14.4"/>' +
    '<path d="M7.3 8.7l-2.6-.6M8.3 12.4l-2.5.4M10 15.6l-2 1.4M16.7 8.7l2.6-.6M15.7 12.4l2.5.4M14 15.6l2 1.4"/>',
  flag: '<path d="M5.5 3.6v16.8"/><path d="M5.5 5h11.7l-2.6 3.4 2.6 3.4H5.5"/>',
  kick: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  sound: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4Z"/><path d="M16.5 9a4.4 4.4 0 0 1 0 6"/>' +
    '<path d="M18.8 6.8a7.6 7.6 0 0 1 0 10.4"/>',
  soundOff: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4Z"/><path d="M16.2 9.7l4.6 4.6M20.8 9.7l-4.6 4.6"/>',
  bot: '<rect x="5" y="8" width="14" height="10" rx="2.5"/>' +
    '<circle cx="9.5" cy="13" r="1.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="14.5" cy="13" r="1.3" fill="currentColor" stroke="none"/>' +
    '<path d="M12 8V5"/><circle cx="12" cy="4" r="1.1"/>',

  /* realm sigils */
  ice: '<path d="M12 3.4v17.2M4.6 7.7l14.8 8.6M4.6 16.3l14.8-8.6"/>' +
    '<path d="M12 3.4 10.1 5.1M12 3.4l1.9 1.7M12 20.6l-1.9-1.7M12 20.6l1.9-1.7"/>',
  desert: '<circle cx="12" cy="9.2" r="3"/>' +
    '<path d="M12 3.4v1.5M17.5 6.2l-1.1 1M6.5 6.2l1.1 1M19.6 10.8h-1.5M5.9 10.8H4.4"/>' +
    '<path d="M2.8 18.4c2.9-2.8 6.1-2.8 9.2 0 3-2.8 6.2-2.8 9.2 0"/>',
  jungle: '<path d="M5.2 18.8C5.7 9.9 11 5 19.6 4.6 19 13.4 13.9 18.4 5.2 18.8Z"/>' +
    '<path d="M5.2 18.8C8.6 14.2 12.4 10.6 17 8.2"/>',
  autumn: '<path d="M17.8 4.6C11.3 5.1 6.8 9.5 6.3 16c6.5-.5 11-4.9 11.5-11.4Z"/>' +
    '<path d="M6.3 16 4.2 19.8"/><path d="M8.8 13.5c2.4-2.4 4.7-4.7 6.7-6.7"/>',
  hub: '<path d="M2.8 18.6c2-1.9 4.4-1.9 6.4 0s4.4 1.9 6.4 0 4.3-1.9 5.6 0"/>' +
    '<path d="M8.2 14.6a3.9 3.9 0 0 1 7.6 0"/><path d="M12 4.6v6"/>' +
    '<path d="M12 5.2l3.4 1.7L12 8.6"/>',

  /* upgrades */
  owl: '<path d="M5.2 8.4a6.8 6.8 0 0 1 13.6 0v5a6.8 6.8 0 0 1-13.6 0Z"/>' +
    '<circle cx="9.4" cy="10.6" r="1.7"/><circle cx="14.6" cy="10.6" r="1.7"/>' +
    '<path d="M12 13.4l-1.1 1.6h2.2Z"/>',
  lyre: '<path d="M6.4 4.2c-.5 4.8.9 8 3 9.8M17.6 4.2c.5 4.8-.9 8-3 9.8"/>' +
    '<path d="M8.6 14h6.8"/><path d="M10.2 14v4.6M13.8 14v4.6"/><path d="M8.6 18.6h6.8"/>' +
    '<path d="M10.5 7.6v4.4M13.5 7.6v4.4M12 7.3v5"/>',
  fitting: '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4M6.2 6.2l1.7 1.7M16.1 16.1l1.7 1.7M17.8 6.2l-1.7 1.7M7.9 16.1l-1.7 1.7"/>',
};
/* aliases so callers can pass game ids directly */
I.aegis_charm = I.aegis;
I.attack = I.strike;
I.ram = I.strike;
I.hull_plates = I.hull;
I.star_chart = I.compass;
I.sandals = I.flee;
I.trident = I.magic;
I.gate = I.home;

export function icon(name, size) {
  const body = I[name] || I.relic;
  const st = size ? ` style="width:${size}px;height:${size}px;flex:none;display:inline-block;vertical-align:-${Math.round(size * 0.18)}px"` : '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${st}>${body}</svg>`;
}

/* ── raven's-matrix glyphs (ported 1:1 from legacy/app.js) ──────────────── */
export function glyphSVG(g, size = 54) {
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
