/**
 * js/modules/fullSeason.js
 * Layer: module. Owns the DOM for the Full Season strip on the Matchup page.
 * Side effects: DOM writes only. Reads from store; calls engine/season.js.
 * No analytical logic lives here — every number comes from engine/season.js
 * (ARCHITECTURE.md §3 hard rule 2).
 *
 * Subscriptions: data:ready, route:changed
 * Renders only while on screen (CONVENTIONS.md §8).
 * See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.
 */

import { store } from '../store.js';
import {
  CHIP_RESET_AFTER_GW, SEASON_COL_W, SEASON_COL_WIDE, SEASON_PHASE_MS,
  SEASON_TOP_PLAYERS, SEASON_STANDOUT_PLAYERS,
} from '../config.js';
import { buildScoreContext, bandFromValue } from '../engine/composite.js';
import {
  buildSeasonModel, buildPlayerFormCache, buildGameweekPlayers, recomputeChipWindows,
} from '../engine/season.js';

let _root = null, _ribbon = null, _rail = null, _scroller = null;
let _model = null;
/**
 * True from the moment a rebuild starts until the background player pass has
 * finished ALL 38 gameweeks. While it is set, render()/renderRail() paint
 * placeholders instead of the model — see skeletonColumnHTML below.
 */
let _loading = false;

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** aria-busy on/off. NOT toggleAttribute: that writes `aria-busy=""`, which is
 *  not the string "true" and so announces nothing. */
function setBusy(el, busy) {
  if (!el) return;
  if (busy) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
}

/**
 * Dot markup for a gameweek's top players — one dot per player, the first
 * SEASON_STANDOUT_PLAYERS carrying the glow class.
 *
 * The `?? []` is not defensive dressing: a week whose computation threw keeps
 * `players` null through the reveal (see runPlayerPass's finally), and it
 * renders as a column with no dots rather than as an exception.
 */
function dotsHTML(players) {
  return (players ?? [])
    .map((p, i) => `<i class="season-gw__dot${i < SEASON_STANDOUT_PLAYERS ? ' season-gw__dot--standout' : ''}"></i>`)
    .join('');
}

/**
 * One collapsed column: number, three tiles, five dots.
 *
 * The number lives INSIDE .season-gw__summary (not as a sibling of it) — see
 * bodyHTML() below and the panel's .season-gw__title. The two fade with their
 * own groups on expand/collapse; a header that was one element retitled in
 * place stayed fully lit while everything around it faded, which is exactly
 * what a previous debugging pass on the motion prototype found and fixed.
 */
function columnHTML(g) {
  if (g.played) {
    return `<div class="season-gw season-gw--past" data-gw="${g.gw}">`
         + `<span class="season-gw__n">${g.gw}</span></div>`;
  }
  // Tile is the BAND TINT alone — no club swatches. The prototype drew two
  // colour chips per tile from a hard-coded palette, but a normalised Team
  // carries no club colour (only name, shortName, code, badgeUrl), and a 70px
  // badge shrunk to 9px is mud. Spec §9 asks the tile to encode one-sidedness,
  // which the tint does on its own; the clubs are named in the panel.
  const tiles = g.matchups.map(m => {
    const cls = m.postponed ? 'season-gw__tile season-gw__tile--postponed'
      : `season-gw__tile season-gw__tile--${esc(bandFromValue(m.value))}${m.isDouble ? ' season-gw__tile--double' : ''}`;
    return `<span class="${cls}"></span>`;
  }).join('');
  const dots = dotsHTML(g.players);
  return `<div class="season-gw${g.loaded ? ' season-gw--hot' : ''}" data-gw="${g.gw}"
               role="button" tabindex="0" aria-expanded="false"
               aria-label="Gameweek ${g.gw}">
      <span class="season-gw__summary">
        <span class="season-gw__n">${g.gw}</span>${tiles}<span class="season-gw__dots">${dots}</span>
      </span>
      <span class="season-gw__body"></span>
    </div>`;
}

/**
 * The same column, before the strip has anything final to say about it.
 *
 * WHY THE WHOLE STRIP WAITS FOR ALL 38. The ribbon can be drawn from fixtures
 * alone in one tick, and it used to be: tiles painted immediately, then each
 * week's dots appeared as runPlayerPass reached it, and finally the chip rail
 * jumped as recomputeChipWindows moved the Triple Captain window off the
 * placeholder it had been pinned to. Every one of those is a mark that looks
 * final and is not — the standout dots ARE the captaincy shout, and they
 * arrive week by week over a second or more while the reader is already
 * reading them. CONVENTIONS.md §5.4's "withhold orderings, not just numbers"
 * is the rule that settles it: this strip ranks players within a week and
 * chip windows across the season, so skeletoning one value at a time is not
 * enough — the strip is skeletoned as a whole and revealed as a whole.
 *
 * The GW number is NOT withheld. It is not a computed value — it is the
 * column's identity, the one thing a reader needs to keep their place while
 * the rest settles.
 *
 * Same footprint as columnHTML's real column: one tile per real matchup (so
 * the reveal shifts no layout) and SEASON_TOP_PLAYERS dots, which is what a
 * settled week shows. No `--hot` class: that is part of the revealed answer,
 * not of the placeholder. No role/tabindex/aria-expanded either — see
 * .season-gw--pending in components.css for why the affordance goes too.
 */
function skeletonColumnHTML(g) {
  if (g.played) {
    // A played week is a number and nothing else — there is no pending value
    // in it to withhold, so it renders exactly as it finally will.
    return `<div class="season-gw season-gw--past" data-gw="${g.gw}">`
         + `<span class="season-gw__n">${g.gw}</span></div>`;
  }
  const tiles = g.matchups
    .map(() => '<span class="season-gw__tile skeleton" aria-hidden="true"></span>')
    .join('');
  const dots = Array.from({ length: SEASON_TOP_PLAYERS }, () =>
    '<i class="season-gw__dot skeleton" aria-hidden="true"></i>').join('');
  return `<div class="season-gw season-gw--pending" data-gw="${g.gw}"
               aria-label="Gameweek ${g.gw}, still calculating">
      <span class="season-gw__summary">
        <span class="season-gw__n">${g.gw}</span>${tiles}<span class="season-gw__dots">${dots}</span>
      </span>
      <span class="season-gw__body"></span>
    </div>`;
}

const CHIP_CLASS = {
  wildcard:      'season-rail__bar--wildcard',
  freehit:       'season-rail__bar--freehit',
  triplecaptain: 'season-rail__bar--triplecaptain',
};
const CHIP_LABEL = {
  wildcard:      'Wildcard',
  freehit:       'Free Hit',
  triplecaptain: 'Triple Captain',
};

/**
 * The chip rail: one cell per gameweek, mirroring the ribbon's widths and gap
 * exactly, so a band's left edge IS its gameweek's left edge.
 *
 * A gameweek CAN be covered by more than one chip window at once — the
 * busiest week (Free Hit) and the best captain week (Triple Captain) can
 * legitimately coincide. `chipsAt` therefore returns every matching window,
 * and each one gets its own `.season-rail__bar` stacked inside the cell
 * (flex-direction: column, one flex:1 bar per window) rather than `.find()`ing
 * a single "winner" and silently dropping the rest — that was FINDING 1 from
 * fix round 1: Triple Captain landing on the same week as Free Hit vanished
 * from the DOM with no error.
 *
 * Consecutive weeks of ONE window are CONJOINED — bridged across the flex gap
 * by an overlay on THAT window's own bar (see .season-rail__bar--bridge::
 * after), never by a negative margin. A negative margin consumes layout width
 * and drifts every later cell leftward: 32px of accumulated error by GW38
 * when the prototype tried it. Head/tail/bridge are computed PER WINDOW —
 * whether this exact window object also covers gw + 1 — not per cell, so two
 * overlapping windows with different runs don't leak caps into each other.
 * The cell's own width/gap are untouched by any of this — only what's drawn
 * inside it changes, which is what keeps the rail locked to the ribbon.
 *
 * Widening a cell during expand() widens the CELL, never a .season-rail__bar
 * directly — the bars are flex:1 children and stretch to fill it for free.
 *
 * Safe to call twice (Task 11 repaints after its background player pass) —
 * innerHTML replacement below always fully replaces the previous rail rather
 * than appending or double-applying state.
 */
function renderRail() {
  if (!_rail || !_model) return;
  setBusy(_rail, _loading);
  const chipsAt = gw => _model.chipWindows.filter(w => gw >= w.from && gw <= w.to);
  const cells = [];
  for (const g of _model.gameweeks) {
    // The rail is skeletoned for the same reason the ribbon is, and it is the
    // clearer case of the two: _model.chipWindows is computed twice, once
    // before any week has players (which pins Triple Captain to each half's
    // opening gameweek) and once for real at the end of runPlayerPass. Drawing
    // the first answer means drawing chip windows that will move.
    const windows = _loading ? [] : chipsAt(g.gw);
    const cellCls = ['season-rail__cell'];
    if (g.played) cellCls.push('season-rail__cell--past');
    if (_loading && !g.played) {
      // No head/tail/bridge: a placeholder must not imply a RUN, which is the
      // one thing a chip window's shape says. One dash per week, no caps.
      cells.push(`<span class="${cellCls.join(' ')}" data-gw="${g.gw}">`
        + '<span class="season-rail__bar skeleton" aria-hidden="true"></span></span>');
      if (g.gw === CHIP_RESET_AFTER_GW) cells.push('<span class="season-rail__split"></span>');
      continue;
    }
    const bars = windows.map(w => {
      const cls = ['season-rail__bar', CHIP_CLASS[w.chip]];
      if (g.gw === w.from) cls.push('season-rail__bar--head');
      // A run cannot bridge the reset: a chip window may not straddle GW19.
      const continues = g.gw !== CHIP_RESET_AFTER_GW && chipsAt(g.gw + 1).includes(w);
      cls.push(continues ? 'season-rail__bar--bridge' : 'season-rail__bar--tail');
      return `<span class="${cls.join(' ')}" title="${CHIP_LABEL[w.chip]}"></span>`;
    }).join('');
    cells.push(`<span class="${cellCls.join(' ')}" data-gw="${g.gw}">${bars}</span>`);
    if (g.gw === CHIP_RESET_AFTER_GW) cells.push('<span class="season-rail__split"></span>');
  }
  _rail.innerHTML = cells.join('');
}

/** Static legend. Every graphic on the strip is named here. */
function renderKey() {
  const key = _root?.querySelector('.season-key');
  if (!key) return;
  const group = (title, items) =>
    `<div class="season-key__group"><span class="season-key__heading">${title}</span>`
    + items.map(([cls, label]) =>
      `<span class="season-key__item"><i class="season-key__swatch ${cls}"></i>${label}</span>`).join('')
    + '</div>';
  key.innerHTML = [
    group('Matchup one-sidedness', [
      // Four rungs, not three: m.value is always the FAVOURED side's score
      // (engine/season.js), so a tile never lands below the neutral band and
      // the key only ever needs the top half of the scale.
      ['season-key__swatch--excellent', 'Exceptional'],
      ['season-key__swatch--great',     'Heavily favoured'],
      ['season-key__swatch--good',      'Favoured'],
      ['season-key__swatch--even',      'Even'],
    ]),
    group('Schedule', [
      ['season-key__swatch--double',    'Double gameweek'],
      ['season-key__swatch--postponed', 'Postponed fixture'],
      ['season-key__swatch--split',     'Chip reset (after GW19)'],
    ]),
    group('Players', [
      ['season-key__swatch--player',   "In the week's top five"],
      ['season-key__swatch--standout', 'Standout — captaincy shout'],
      ['season-key__swatch--favoured', 'Favoured side of a matchup'],
    ]),
    group('Chip windows', [
      ['season-key__swatch--wildcard',      'Wildcard'],
      ['season-key__swatch--triplecaptain', 'Triple Captain'],
      ['season-key__swatch--freehit',       'Free Hit'],
    ]),
    group('Week strength', [
      ['season-key__swatch--loaded', 'Loaded — several one-sided ties'],
    ]),
  ].join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   EXPAND / COLLAPSE — a gameweek floats into a detail panel.
   Ported from docs/superpowers/specs/2026-09-01-full-season-strip-prototype
   .html, a browser-verified reference of exactly this choreography. Five
   constraints from that prototype's own debugging history must survive every
   future edit here:
     1. Never set a transitioned value inside a setTimeout whose delay equals
        that property's own transition-delay — they compound.
     2. Measure the collapsed reference rect (r0, below) BEFORE anything about
        the float's content or width is touched.
     3. One float element PER OPEN ACTION — a shared element cannot collapse
        the old week and expand the new one at once.
     4. collapse() NEVER aborts once called — it owns its float outright.
     5. animateScroll's rAF loop runs even when from === to — it re-glues
        every open float to its column each frame regardless.
   ═══════════════════════════════════════════════════════════════════════════ */

/** One phase of the choreography; three phases run back to back. */
const T = SEASON_PHASE_MS;
/** The width a column grows by on open — also what a scroll shift is capped to. */
const GROW = SEASON_COL_WIDE - SEASON_COL_W;

const wait = ms => new Promise(res => setTimeout(res, ms));

/**
 * cubic-bezier(.32,.72,0,1) evaluated in JS, so a scripted scroll can ride the
 * exact same curve as the CSS width transition beside it (--season-ease in
 * components.css). Without this the column widening and the track scrolling
 * drift apart mid-flight even though they start and end together.
 */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = u => ((ax * u + bx) * u + cx) * u;
  const Y = u => ((ay * u + by) * u + cy) * u;
  return t => {
    let lo = 0, hi = 1, u = t;
    for (let i = 0; i < 24; i++) {
      const x = X(u);
      if (Math.abs(x - t) < 1e-4) break;
      if (x < t) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return Y(u);
  };
}
const EASE = bezier(.32, .72, 0, 1);

/** One float element per open gameweek (constraint 3) plus the currently-open
 *  pair, used to answer "is anything open" (the aria-expanded / open-state
 *  landmine — see rebuild()/onRouteChanged() below). */
const floats = new Set();
let openCol = null, openFloat = null;

const railOf = gw => _rail.querySelector(`.season-rail__cell[data-gw="${gw}"]`);

/**
 * The height `el` would have at width `w`, without ever letting that
 * measurement paint. Used to find the panel's OPEN height while the float is
 * still sitting at its collapsed width, so phase 1 (height) can animate
 * straight to its true target instead of overshooting and correcting.
 */
function heightAt(el, w) {
  const saved = el.getAttribute('style');
  el.style.transition = 'none';
  el.style.width = w + 'px';
  el.style.height = 'auto';
  const h = el.offsetHeight;
  if (saved === null) el.removeAttribute('style'); else el.setAttribute('style', saved);
  return h;
}

/**
 * How far to scroll the track right while the column widens — which is what
 * decides the DIRECTION the expansion appears to happen in.
 *
 *   0        the panel opens rightward, the column's left edge stays put
 *   GROW/2   it opens centrally, the weeks either side parting around it
 *   GROW     it opens leftward, every collapsed week sliding left
 *
 * Centre is the default because it disturbs the least on each side. Near the
 * right-hand edge there is no room to open rightward at all, so the shift
 * rises to whatever keeps the full panel on screen — up to GROW, which is the
 * "expand fully left" case. Near the left-hand edge the shift is capped by how
 * much track actually exists to the column's left, so the column can never be
 * pushed off the start of the ribbon.
 */
function scrollShiftFor(col, scEl) {
  const c = col.getBoundingClientRect(), s = scEl.getBoundingClientRect();
  const overflow = Math.max(0, (c.left + SEASON_COL_WIDE) - (s.right - 8));  // what must move to fit
  const spaceLeft = Math.max(0, c.left - s.left);                           // track available leftward
  const headroom = (scEl.scrollWidth + GROW - scEl.clientWidth) - scEl.scrollLeft;
  return Math.round(Math.max(0, Math.min(GROW / 2 > overflow ? GROW / 2 : overflow, GROW, spaceLeft, headroom)));
}

/**
 * Scroll `el` from→to along EASE, starting after `delay`, over `dur`.
 *
 * The rAF loop runs even when from === to (constraint 5). It is not only
 * driving the scroll — it is also what re-glues every open panel to its
 * column each frame, and the column moves during this window whether or not
 * the track scrolls: a week collapsing earlier in the ribbon drags everything
 * after it. Returning early on a zero-distance scroll strands the panel away
 * from its own column.
 */
function animateScroll(el, from, to, delay, dur) {
  return new Promise(res => {
    setTimeout(() => {
      const t0 = performance.now();
      (function step() {
        const p = Math.min(1, (performance.now() - t0) / dur);
        if (to !== from) el.scrollLeft = from + (to - from) * EASE(p);
        placeFloats();
        if (p < 1) requestAnimationFrame(step); else res();
      })();
    }, delay);
  });
}

/** Pin each float by its BOTTOM edge to its column's bottom, so growing the
 *  height makes it climb up the page instead of pushing anything down. */
function placeFloats() {
  for (const pair of floats) {
    const { el, col } = pair;
    const r = col.getBoundingClientRect();
    // NOT innerHeight: it includes the horizontal scrollbar's thickness. A
    // fixed-position element with no transformed ancestor is positioned
    // against the INITIAL CONTAINING BLOCK, whose height is
    // document.documentElement.clientHeight — which EXCLUDES that scrollbar.
    // The Matchup page carries a standing ~8px horizontal document overflow
    // (open or closed, unrelated to this feature) so the scrollbar is always
    // showing, and innerHeight here silently added its ~15px to every
    // `bottom`, floating every panel that far above the column it belongs to.
    el.style.bottom = (document.documentElement.clientHeight - r.bottom) + 'px';
    // ALWAYS anchored to the column's LEFT edge, nudged by a fixed offset
    // computed once at open time (see `nudge` in expand()) and never touched
    // again — anchoring to the RIGHT edge instead moves as the column widens.
    el.style.right = 'auto';
    el.style.left = Math.max(8, r.left + pair.nudge) + 'px';
  }
}

/* ─── Panel content — DOM only; every value already comes from _model ────── */

function sideHTML(teamId, isFav) {
  const team = store.getTeam(teamId);
  const name = esc(team?.shortName ?? '?');
  const badge = team?.badgeUrl
    ? `<img class="season-badge" src="${esc(team.badgeUrl)}" alt="" onerror="this.style.visibility='hidden'">`
    : '';
  return `<span class="season-side${isFav ? ' season-side--fav' : ''}">${badge}<span class="season-side__t">${name}</span></span>`;
}

function fixtureRowHTML(m) {
  if (m.postponed) {
    return `<div class="season-fxrow season-fxrow--pp">${sideHTML(m.homeId, false)}`
      + `<span class="season-v">v</span>${sideHTML(m.awayId, false)}`
      + `<span class="season-pptag">PP</span><span class="season-sc">—</span></div>`;
  }
  return `<div class="season-fxrow season-fxrow--${esc(bandFromValue(m.value))}">${sideHTML(m.homeId, m.favouredId === m.homeId)}`
    + `<span class="season-v">v</span>${sideHTML(m.awayId, m.favouredId === m.awayId)}`
    + `${m.isDouble ? '<span class="season-dgwtag">DGW</span>' : ''}`
    + `<span class="season-sc">${Math.round(m.value)}</span></div>`;
}

/**
 * `i` arrives for free — every call site below uses this directly as an
 * Array.map callback, and map passes (element, index) to it. Same index
 * rule as dotsHTML's standout cutoff, so a panel's highlighted rows and its
 * column's glowing dots are always naming the same two players.
 */
function playerRowHTML(p, i) {
  const hi = i < SEASON_STANDOUT_PLAYERS ? ' season-prow--hi' : '';
  return `<div class="season-prow${hi}">`
    + `<span class="season-prow__pos">${esc(p.position)}</span>`
    + `<span class="season-prow__nm">${esc(p.name)}</span>`
    + `<span class="season-prow__px">£${p.price.toFixed(1)}m</span>`
    + `<span class="season-prow__pts">${p.points.toFixed(1)}</span></div>`;
}

/**
 * g.players is null until the background pass fills it in. No column can be
 * opened while that pass is running any more (the whole strip is skeletoned
 * and non-interactive until it finishes), so this is now a backstop rather
 * than the common path: it covers the week whose own computation threw, which
 * runPlayerPass deliberately still reveals rather than leaving the strip
 * shimmering forever. SEASON_TOP_PLAYERS rows, matching the count a settled
 * week would show.
 */
function skeletonPlayerRowsHTML() {
  return Array.from({ length: SEASON_TOP_PLAYERS }, () =>
    `<div class="season-prow" aria-hidden="true">`
    + `<span class="season-prow__pos skeleton skeleton--text">MID</span>`
    + `<span class="season-prow__nm skeleton skeleton--text">Player name</span>`
    + `<span class="season-prow__px skeleton skeleton--text">£0.0m</span>`
    + `<span class="season-prow__pts skeleton skeleton--text">0.0</span></div>`
  ).join('');
}

/** The expanded panel's own content — everything the collapsed column's
 *  .season-gw__summary doesn't have room for. */
function bodyHTML(g) {
  const fx = g.matchups.map(fixtureRowHTML).join('');
  const playersKnown = Array.isArray(g.players);
  const plist = playersKnown ? g.players.map(playerRowHTML).join('') : skeletonPlayerRowsHTML();
  return `<div class="season-gw__title">GW ${g.gw}</div>`
    + `<span class="season-lab">Top matchups</span>${fx}`
    + `<span class="season-lab">Must-have players</span>`
    + `<div class="season-plist"${playersKnown ? '' : ' aria-busy="true"'}>${plist}</div>`
    + `<p class="season-note">${esc(g.note)}</p>`;
}

/* ─── Open / close ─────────────────────────────────────────────────────────── */

/**
 * Expand `col` into a floating detail panel. `prev`, when given, is the
 * `{el, col}` of a week already open and mid-collapse — its own collapse()
 * call is fired by the click handler, not here; this only reads it to resolve
 * ONE combined scroll target instead of two scroll animations fighting over
 * the same scrollLeft.
 */
async function expand(col, prev) {
  const gw = +col.dataset.gw;
  const g = _model.gameweeks[gw - 1];

  const el = document.createElement('div');
  el.className = 'season-gw season-gw--float' + (g.loaded ? ' season-gw--hot' : '');
  el.innerHTML = col.innerHTML;
  // Measured from the untouched, still-collapsed `col` — never from `el`,
  // whose content is about to be replaced — so this stays the true collapsed
  // reference no matter what happens to the float afterwards (constraint 2).
  const r0 = col.getBoundingClientRect();
  el.style.transition = 'none';
  el.style.width = r0.width + 'px';
  el.style.height = r0.height + 'px';
  document.body.appendChild(el);

  const pair = { el, col, nudge: 0, shift: 0 };
  floats.add(pair);
  openCol = col; openFloat = el;
  col.classList.add('season-gw--under');
  // Keep aria-expanded truthful on the trigger the instant the open action is
  // committed — not deferred to any animation frame.
  col.setAttribute('aria-expanded', 'true');
  placeFloats();

  const body = el.querySelector('.season-gw__body');
  body.innerHTML = bodyHTML(g);

  // Measure the OPEN height (at the wide width, with is-open in effect so the
  // summary is out of flow), then put the float BACK to its closed appearance
  // and commit that with a forced reflow. is-open/chrome are re-applied below,
  // AFTER the transition is armed, so the accent border and padding animate in
  // with phase 1 instead of snapping on at frame 0.
  el.classList.add('is-open');
  const h1 = heightAt(el, SEASON_COL_WIDE);
  el.classList.remove('is-open');
  el.style.width = r0.width + 'px';
  el.style.height = r0.height + 'px';
  el.offsetHeight;

  // ALL THREE PHASES ARMED AT ONCE, chained by transition-delay — awaiting
  // each transitionend and starting the next costs a frame at every handoff.
  el.style.transition =
    `height ${T}ms var(--season-ease) 0ms, width ${T}ms var(--season-ease) ${T}ms, `
    + `border-color ${T}ms ease 0ms, box-shadow ${T}ms ease 0ms, padding ${T}ms var(--season-ease) 0ms`;
  el.classList.add('is-open', 'season-gw--chrome');
  el.style.height = h1 + 'px';
  el.style.width = SEASON_COL_WIDE + 'px';

  // Phase 2 also opens the gap in the ribbon and the rail cell beneath it, in
  // step with the float above them.
  col.style.transition = `width ${T}ms var(--season-ease) ${T}ms`;
  railOf(gw).style.transitionDelay = T + 'ms';
  col.classList.add('season-gw--wide');
  railOf(gw).classList.add('season-rail__cell--wide');

  // Directional expansion, resolved into ONE scroll target. THE CLICKED
  // COLUMN IS THE FIXED REFERENCE: if a different week is collapsing and sits
  // EARLIER in the ribbon, its shrink drags this column GROW to the left, so
  // that has to be given back before applying this column's own shift.
  pair.shift = scrollShiftFor(col, _scroller);
  const flowDelta = (prev && prev.col !== col && +prev.col.dataset.gw < gw) ? -GROW : 0;
  // Same +GROW as scrollShiftFor's headroom: the clamp must model the track
  // AFTER the column widens, which is the state this scroll animates toward.
  // Without it the clamp truncates the very shift scrollShiftFor just granted,
  // and the last gameweek's panel overhangs because the scroll never happened.
  const maxScroll = _scroller.scrollWidth + GROW - _scroller.clientWidth;
  const target = Math.max(0, Math.min(maxScroll, _scroller.scrollLeft + flowDelta + pair.shift));
  // NOT innerWidth: it includes the vertical scrollbar's width. The Matchup
  // page has vertical overflow, so the scrollbar is always showing and
  // innerWidth here would silently claim ~15px more room than the viewport
  // actually has, letting a panel opened near the right edge overhang it.
  // document.documentElement.clientWidth excludes it, mirroring the
  // clientHeight reasoning in placeFloats() above.
  pair.nudge = Math.min(0, (document.documentElement.clientWidth - 12) - (r0.left - pair.shift + SEASON_COL_WIDE));
  animateScroll(_scroller, _scroller.scrollLeft, target, T, T);

  body.style.transitionDelay = (2 * T) + 'ms';
  body.classList.add('season-gw__body--in');
  await wait(3 * T + 40);
  if (openFloat === el) { body.style.transitionDelay = ''; el.style.transition = ''; }
}

/**
 * Collapse `el` (the float for `col`) back into its column. Owns its float
 * outright from the moment it is called — constraint 4: this never aborts
 * partway through once past the initial idempotency guard, so a float is
 * never left in the DOM with its column stuck wide.
 *
 * `skipScroll` is set when this collapse is one half of a week-switch: the
 * incoming week owns the scroll in that case, so this one must not also try
 * to wind its own shift back.
 */
async function collapse(el, col, skipScroll) {
  if (!el || !col || el.__closing) return;
  el.__closing = true;
  if (openFloat === el) { openFloat = null; openCol = null; }
  // Truthful the instant the close is committed, matching expand()'s "true".
  col.setAttribute('aria-expanded', 'false');

  const gw = col.dataset.gw;
  const body = el.querySelector('.season-gw__body');

  // The collapsed height to land on — read from the real column, not a
  // cached constant, so it stays honest if the summary's content ever
  // changes.
  const hEnd = col.offsetHeight;

  body.style.transitionDelay = '0ms';
  body.classList.remove('season-gw__body--in');
  el.style.height = el.offsetHeight + 'px';
  el.offsetHeight;

  // ALL THREE PHASES ARMED AT ONCE, chained by delay — the mirror of expand().
  // The height target is assigned HERE, not inside a matching setTimeout — see
  // constraint 1: a value written inside a setTimeout whose own delay equals
  // this rule's transition-delay would compound into never actually playing.
  el.style.transition =
    `width ${T}ms var(--season-ease) ${T}ms, height ${T}ms var(--season-ease) ${2 * T}ms, `
    + `border-color ${T}ms ease ${2 * T}ms, box-shadow ${T}ms ease ${2 * T}ms, padding ${T}ms var(--season-ease) ${2 * T}ms`;
  el.style.width = SEASON_COL_W + 'px';
  el.style.height = hEnd + 'px';
  // Dropped NOW, not at 2T, so the rule's own 2T delay is what times the
  // fade (constraint E in the brief).
  el.classList.remove('season-gw--chrome');

  const scEl = _scroller;
  const pr = [...floats].find(x => x.el === el);
  animateScroll(scEl, scEl.scrollLeft,
    (!skipScroll && pr && pr.shift) ? scEl.scrollLeft - pr.shift : scEl.scrollLeft, T, T);

  col.style.transition = `width ${T}ms var(--season-ease) ${T}ms`;
  railOf(gw).style.transitionDelay = T + 'ms';
  col.classList.remove('season-gw--wide');
  railOf(gw).classList.remove('season-rail__cell--wide');

  // At the start of phase 3, hand the column back at the same moment the
  // float begins shedding its own open state — `position` cannot be
  // transitioned, so this is the only place it can be dropped. Both then fade
  // their summaries in together behind an opaque panel, so by the time the
  // float is removed the column underneath is ALREADY at full opacity.
  setTimeout(() => {
    el.classList.remove('is-open');
    col.classList.remove('season-gw--under');
  }, 2 * T);

  await wait(3 * T + 60);
  el.remove();
  for (const p of floats) if (p.el === el) floats.delete(p);
  col.classList.remove('season-gw--under');   // no-op if phase 3 already did it
  col.removeAttribute('style');
  railOf(gw).style.transitionDelay = '';
}

const closeOpen = () => { if (openFloat) collapse(openFloat, openCol); };

/**
 * Instantly discards every tracked float without animating it — used only
 * when the DOM underneath is about to change out from under them: a `render()`
 * rebuild (data:ready can arrive at any time, including mid-session with a
 * panel open — see rebuild() below) or navigating away from Matchup, whose
 * `.season-gw--float` panels are `position: fixed` on `document.body` and so
 * do NOT get hidden by the router's `.module-view.is-active` toggle the way
 * the rest of the module's markup does.
 *
 * Removes every entry in `floats`, not just the tracked `openFloat` — during
 * a week-switch two floats can be live at once (one collapsing, one
 * expanding), and both would otherwise be left stranded.
 */
function forceCloseOpen() {
  for (const pair of floats) pair.el.remove();
  floats.clear();
  openFloat = null;
  openCol = null;
}

function onDocumentClick(e) {
  const inFloat = e.target.closest('.season-gw--float');
  const col = e.target.closest('.season-gw:not(.season-gw--float)');
  if (inFloat || (col && col === openCol)) { closeOpen(); return; }
  // --pending is excluded for the same reason as --past: there is nothing
  // behind it to open. Its markup carries no role/tabindex either, so this is
  // belt and braces rather than the only guard.
  if (col && !col.classList.contains('season-gw--past')
          && !col.classList.contains('season-gw--pending')) {
    const prev = openFloat ? { el: openFloat, col: openCol } : null;
    if (prev) collapse(prev.el, prev.col, true);   // skips its own scroll; not awaited
    expand(col, prev);
    return;
  }
  closeOpen();
}

/**
 * Escape closes; Enter/Space activates a focused column exactly as a click
 * would. columnHTML() marks every non-past column `role="button" tabindex="0"`,
 * which promises keyboard activation — a generic element with that role gets
 * no built-in Enter/Space behaviour from the browser the way a real <button>
 * would, so this is what actually delivers it. Dispatched as a real click on
 * the same element rather than duplicating expand/collapse branching here, so
 * there is exactly one place that logic lives.
 */
function onDocumentKeydown(e) {
  if (e.key === 'Escape') { closeOpen(); return; }
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const col = e.target.closest?.(
    '.season-gw:not(.season-gw--past):not(.season-gw--pending):not(.season-gw--float)');
  if (!col) return;
  e.preventDefault();
  col.click();
}

/* ═══════════════════════════════════════════════════════════════════════════ */

/** Rebuild the ribbon, rail and key from `_model` — or, while `_loading`, from
 *  placeholders of the same shape (skeletonColumnHTML). Called twice per
 *  rebuild: once for the skeleton and once, from runPlayerPass, for the
 *  reveal. */
function render() {
  if (!_model || !_ribbon) return;
  setBusy(_ribbon, _loading);
  const cols = [];
  for (const g of _model.gameweeks) {
    cols.push(_loading ? skeletonColumnHTML(g) : columnHTML(g));
    if (g.gw === CHIP_RESET_AFTER_GW) {
      cols.push('<span class="season-split" role="separator"'
        + ' aria-orientation="vertical"'
        + ' aria-label="Chips reset after Gameweek 19"'
        + ' title="FPL chips reset after Gameweek 19"></span>');
    }
  }
  _ribbon.innerHTML = cols.join('');
  renderRail();
  renderKey();
}

let _passId = 0;

/**
 * Fill in every gameweek's top five, one week at a time, then reveal the
 * whole strip at once.
 *
 * The strip cannot paint its real self up front: the player half needs ~700
 * form computations before it can rank anything, and that is far too long to
 * hold a paint for. So the ribbon and rail go up as placeholders
 * (skeletonColumnHTML) and this pass, chunked one gameweek per macrotask so
 * the page stays responsive, computes what they stand in for. The reveal is
 * the single render() below — never per-week, for the reasons set out on
 * skeletonColumnHTML.
 *
 * `_passId` abandons an in-flight pass when the data refreshes underneath it,
 * exactly as ranker.js's `_computeId` does — a second data:ready (rebuild()
 * calls this again) must not let a stale pass keep writing into a `_model`
 * it no longer owns, NOR reveal the strip on the newer pass's behalf: the
 * finally block below therefore checks ownership too, not just `_loading`.
 */
async function runPlayerPass(ctx) {
  const my = ++_passId;
  try {
    const formCache = buildPlayerFormCache(ctx);
    for (const g of _model.gameweeks) {
      if (my !== _passId) return;                 // superseded
      g.players = buildGameweekPlayers(g.gw, ctx, formCache);
      await new Promise(r => setTimeout(r, 0));   // yield a frame
    }
    if (my !== _passId) return;
    // The chip windows were first computed against players that had not
    // arrived yet, which pins Triple Captain to each half's opening gameweek.
    // Now that every week has its five, they can be computed for real —
    // before the reveal, so the rail is only ever drawn once, with the answer.
    _model.chipWindows = recomputeChipWindows(_model);
  } finally {
    // Reveal even if a week threw. A strip left shimmering for the rest of
    // the session is worse than one with a gap in it, and bodyHTML already
    // falls back to skeleton rows for any week whose `players` is still null.
    // Guarded on ownership: a superseded pass returning early must leave the
    // newer pass's `_loading` alone rather than reveal a strip mid-compute.
    if (my === _passId) { _loading = false; render(); }
  }
}

/* paintDots()/refreshOpenPanel() used to live here, patching one column's
   dots and one open panel's player rows as each week landed. Both are gone
   with the progressive reveal that needed them: no column shows a dot and no
   column can be opened until the pass has finished all 38, at which point
   render() draws every week from the settled model in one go. */

function rebuild() {
  const season = store.getSeason();
  if (!season) return;
  // THE ARIA-EXPANDED / OPEN-STATE LANDMINE: render() below always stamps a
  // fresh aria-expanded="false" on every column, and nothing here tracks which
  // gameweek was open across a rebuild. Left alone, a data:ready arriving
  // while a panel is open (the store refreshes periodically) would silently
  // destroy the ribbon out from under an in-progress or finished expand(),
  // stranding its float — position: fixed on document.body, so it would keep
  // floating over a freshly-rendered ribbon that no longer agrees it is open.
  // Closing it first, synchronously and without animation, is simpler and
  // safer than trying to restore the same gameweek's panel post-rebuild (that
  // would mean replaying up to 990ms of choreography against geometry that
  // may have just changed) — and it is the same DOM before and after either
  // way, since render() would tag every column aria-expanded="false" anyway.
  if (floats.size > 0) forceCloseOpen();
  // Exactly matchup.js's buildCtx() option set (js/modules/matchup.js), so the
  // strip scores every fixture from the SAME inputs as the cards above it —
  // omitting teamXgBySlug/leagueXgHistory degrades the counter-matchup and
  // history sub-metrics, which can band (and colour) a tile differently than
  // the card for the same fixture.
  const ctx = buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg:            store.getLeagueXg(),
    leagueXgPrev:        store.getLeagueXgPrev(),
    leagueXgHistory:     store.getLeagueXgHistory(),
    teamXgBySlug:        store.getAllTeamXg(),
    currentGw:           store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
  });
  _model = buildSeasonModel(ctx, season, { skipPlayers: true });
  // Set BEFORE the first render, and cleared only by runPlayerPass's finally:
  // everything render() puts on screen between these two lines is a
  // placeholder. A refresh mid-session re-enters the skeleton state rather
  // than leaving the previous answer up while a new one is computed — the old
  // strip's dots and chip windows are no more current than no dots at all.
  _loading = true;
  render();
  runPlayerPass(ctx);
}

let _pendingRender = false;   // data changed while off screen — render on activation

function onDataReady() {
  // Rebuilding scores all 38 gameweeks — expensive. Defer it when hidden,
  // same idiom as matchup.js/dashboard.js/fixtures.js/planner.js (CONVENTIONS §8).
  if (store.getActiveModule() !== 'matchup') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  rebuild();
}

/** Flush a render deferred while off screen, once Matchup is shown.
 *
 * Also the other half of the open-state landmine's fix: a `.season-gw--float`
 * panel is fixed to document.body, not scoped inside `.module-view`, so
 * switching away from Matchup does NOT hide it the way the rest of the
 * strip's markup is hidden by the router. Close it explicitly here so it
 * cannot keep floating over whichever view the user switched to. */
function onRouteChanged(module) {
  if (module !== 'matchup') {
    if (floats.size > 0) forceCloseOpen();
    return;
  }
  if (!_pendingRender) return;
  _pendingRender = false;
  rebuild();
}

/** Initialise the strip. Called once from main.js on bootstrap. */
export function initFullSeason() {
  _root = document.querySelector('.season-strip');
  if (!_root) return;
  _ribbon   = _root.querySelector('.season-ribbon');
  _rail     = _root.querySelector('.season-rail');
  _scroller = _root.querySelector('.season-scroller');

  // Ribbon column geometry and the expand/collapse phase length live in
  // js/config.js (SEASON_COL_W / SEASON_COL_WIDE / SEASON_PHASE_MS) so the JS
  // and CSS never disagree about a pixel value or a timing — css/components.css
  // reads these back via var(--season-col-w) / var(--season-col-wide) /
  // var(--season-t) instead of hard-coding any of the three.
  _root.style.setProperty('--season-col-w', `${SEASON_COL_W}px`);
  _root.style.setProperty('--season-col-wide', `${SEASON_COL_WIDE}px`);
  // On document.documentElement (:root), not _root — expand() appends its
  // float to document.body, a COUSIN of .season-strip in the DOM, not a
  // descendant of it, so a property set on _root would not inherit onto the
  // float and every transition reading it would be silently dropped as
  // invalid. See the matching :root rule in css/components.css.
  document.documentElement.style.setProperty('--season-t', `${SEASON_PHASE_MS}ms`);

  store.subscribe('data:ready',    onDataReady);
  store.subscribe('route:changed', onRouteChanged);

  // Document-level, capture phase for click: a click that lands on neither an
  // open float nor a column is exactly what should close whatever is open,
  // wherever on the page it happened (matchup cards, nav, the key below).
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
  _scroller.addEventListener('scroll', placeFloats, { passive: true });
  addEventListener('scroll', placeFloats, { passive: true });
  addEventListener('resize', placeFloats, { passive: true });

  if (store.isFresh()) onDataReady();
}
