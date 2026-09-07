/**
 * js/modules/dashboard.js
 * Layer: module. Owns the DOM for the GW Decision Dashboard view.
 * Side effects: DOM writes, sessionStorage reads/writes, network (live poll).
 * Reads from store; delegates all scoring to engine/composite.js exclusively.
 * No analytical logic lives here — scorePlayer(player, getHorizon(), ctx)
 * is the sole engine call, over the SAME global horizon the Planner reads.
 * See ROADMAP.md Phase 2C.
 *
 * Live points (Phase 3C-5):
 *   - When the current GW is live (finished=false, dataChecked=true), the module
 *     fetches event/<gw>/live/ on load and every 60 s via setInterval.
 *   - Polling stops when the user navigates away from the dashboard (hashchange).
 *   - A failed live fetch shows the last known data with a "stale" indicator;
 *     the dashboard never crashes. ARCHITECTURE.md §6: live data is never cached.
 *
 * Subscriptions: data:ready, route:changed, squad:updated
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store }       from '../store.js';
import { HORIZONS, SQUAD_LIMITS, SQUAD_TOTAL } from '../config.js';
import { buildScoreContext, scorePlayer, rankPlayers, attachRankTiers, bandFromValue } from '../engine/composite.js';
import { groupPerGwSlots }              from '../engine/fixtures.js';
import { pickStartingXI }               from '../engine/lineup.js';
import { fetchLivePoints }               from '../api.js';
import { fetchAndMapSquad, loadSavedTeamId, saveTeamId, resolveImportGw } from '../squadImport.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The window every score on this page is computed over.
 *
 * The global horizon, NOT the GW1 lock this module used to carry. A player's
 * chip appears on both this page and the Planner, and under two different
 * windows the same player read 81 here and 84 there — a difference with a real
 * reason behind it (this page answered "this week", the Planner "the next
 * five") that no one reading two chips could see, and which therefore read as
 * one of the two numbers being wrong.
 *
 * The cost is real and was accepted deliberately: the Starting XI and the
 * captain pick are now chosen on a multi-gameweek average, so a player who
 * BLANKS in the upcoming gameweek can still be picked to start it. Read
 * buildFixtureContextLabel's line in a breakdown panel to see which fixtures
 * a given score actually covers.
 *
 * A function, not a const: it re-reads the store each call, so restoring the
 * horizon switcher needs no change here. Same shape as planner.js's getHorizon.
 */
function getHorizon() {
  return HORIZONS[store.getActiveHorizon()] ?? HORIZONS.GW5;
}

/**
 * minutesSecurity below this threshold → "Rotation Risk" flag.
 * Mirrors MIN_SEC_LEVELS[1].threshold in ranker.js (0.65 = "Likely" cutoff).
 */
const MIN_SEC_RISK = 0.65;

/** Live poll interval — 60 s per ROADMAP.md §2C / ARCHITECTURE.md §6. */
const LIVE_POLL_INTERVAL_MS = 60_000;

// ─── Module-level state ───────────────────────────────────────────────────────
//
// NOTE: the squad itself is NOT module-level state — it lives in store.js
// (store.getSquad()/setSquad()) so Dashboard and Planner share one source of
// truth. See afterSquadChange() and initDashboard()'s 'squad:updated' subscription.

// ─── Import state (Phase 4-1) ─────────────────────────────────────────────────

/** FPL team ID last used for a successful import, or null. */
let _importedTeamId = null;

/** Raw FPL entry object from last import (name, rank, etc.), or null. */
let _importedEntryInfo = null;

/** True while an import fetch is in flight — prevents concurrent imports. */
let _importInFlight = false;

/** Map<playerId, scorePlayer result> — rebuilt on data:ready + squad changes. */
let _scores = new Map();

/**
 * Map<playerId, 'positionElite'|'positionStrong'|'bottomPercentile'|null> — EVERY player's standing
 * against the full pool (FEATURE_ENGINE.md §13), not just the squad. null
 * until computed. Deliberately NOT rebuilt on every squad edit: the ranking
 * depends only on ctx/horizon, not on squad membership, so recomputing it on
 * every add/remove would re-score ~700 players per click for no reason.
 * Rebuilt once per data:ready (see onDataReady) and reused across squad edits.
 */
let _rankTierByPlayerId = null;

/** Active position set for the search dropdown filter. */
let _searchPosSet = new Set(['GKP', 'DEF', 'MID', 'FWD']);

/** True once data:ready has fired at least once. */
let _dataReady = false;

/**
 * True once wireDom() has successfully cached DOM refs and attached listeners.
 * Guards against double-wiring if data:ready fires more than once.
 */
let _domWired = false;

// ─── Live points state (Phase 3C-5) ──────────────────────────────────────────

/**
 * Map<playerId, number> of live GW points, or null if not yet fetched.
 * Populated by the live poll; cleared on each data:ready so a new GW starts
 * fresh. ARCHITECTURE.md §6: live data is never cached across fetches.
 */
let _livePoints = null;

/**
 * True when the most recent live poll failed and _livePoints holds stale data.
 * The UI shows a "data may be delayed" note; the dashboard never crashes.
 */
let _liveStale  = false;

/** setInterval handle while live polling is active; null otherwise. */
let _pollTimer  = null;

// ─── DOM refs (populated in wireDom, called from onDataReady) ────────────────

let _root          = null;
let _searchInput   = null;
let _searchResults = null;
let _squadSlots    = null;
let _decisions     = null;
let _tally         = null;

// Import panel refs (Phase 4-1)
let _importBtn     = null;
let _importPanel   = null;
let _importIdInput = null;
let _importStatus  = null;
let _importInfo    = null;
/** The "Where do I find my Team ID?" <details>. Both dropdowns hang off
 *  the same wrap and overlay the same space, so only one may be open. */
let _importHelp    = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

/** rankTier (composite.js → calcRankTier) → the .score-chip--rank-* modifier
 *  suffix, or '' when the player isn't in any standout tier (keeps their
 *  existing band colour). Mirrors the identical helper in modules/ranker.js.
 *  See FEATURE_ENGINE.md §13. */
function rankTierClass(rankTier) {
  if (rankTier === 'positionBest')     return ' score-chip--rank-gold';
  if (rankTier === 'positionElite')    return ' score-chip--rank-green';
  if (rankTier === 'positionStrong')   return ' score-chip--rank-light-green';
  if (rankTier === 'topPercentile')    return ' score-chip--rank-neutral';
  if (rankTier === 'bottomPercentile') return ' score-chip--rank-red';
  if (rankTier === 'midPercentile')    return ' score-chip--rank-yellow';
  return '';
}

/**
 * True when a scorePlayer result has at least one estimated sub-metric.
 * scorePlayer does not expose a single confidence number, so we check the
 * breakdown directly. Used to add score-chip--estimated where appropriate.
 */
function isScoreEstimated(score) {
  return Boolean(score?.breakdown?.form?.estimated || score?.breakdown?.counter?.estimated);
}

// ─── Score breakdown disclosure (Phase 6) ─────────────────────────────────────

/**
 * scorePlayer's breakdown is { form, fixture, counter } (FEATURE_ENGINE.md §10)
 * — a different shape from scoreFixture's { baseDifficulty, counterMatchup,
 * teamForm, homeAway, history } breakdown that matchup.js's
 * buildBreakdownRows renders. Same visual pattern (bar + value + weight%),
 * different schema — so the row markup is duplicated here in miniature
 * rather than importing matchup.js's private (unexported) helper.
 */
const BREAKDOWN_ORDER  = ['form', 'fixture', 'counter'];
const BREAKDOWN_LABELS = { form: 'Form', fixture: 'Fixture', counter: 'Counter' };

/**
 * Build the "which fixture is this" context line for a breakdown panel.
 *
 * Names the NEAREST gameweek in the score's window — which may hold TWO
 * fixtures. This previously read perGw[0] and discarded the second, which is
 * precisely the information a user opens this line to check on a double: it is
 * the sanity check on the captaincy pick, and it was telling half the truth.
 *
 * Since the page came off its GW1 lock the window runs past that gameweek, so
 * the horizon's own label is appended: naming one fixture beside a number that
 * read five would be the same half-truth in a new place.
 *
 * @param {object} score  a scorePlayer result
 * @param {{label: string, gws: number}} [horizon]  the window `score` covers.
 *   Omitted (the unit tests' shape) means "describe the nearest gameweek only".
 * @returns {string}
 */
export function buildFixtureContextLabel(score, horizon = null) {
  const slot   = groupPerGwSlots(score?.perGw ?? [])[0];
  const window = (horizon && horizon.gws > 1) ? ` · ${horizon.label}` : '';
  if (!slot) return (horizon ?? getHorizon()).label;
  if (slot.isBlank) return `GW${slot.gw} — Blank${window}`;

  const fixtures = slot.fixtures
    .map(f => `${f.opponent ?? '?'} (${f.venue ?? '?'})`)
    .join(', ');
  const marker = slot.isDouble ? ' (double)' : '';
  return `GW${slot.gw}${marker} vs ${fixtures}${window}`;
}

/**
 * Build the three breakdown rows (Form / Fixture / Counter) for a
 * scorePlayer breakdown. Same row markup/classes as matchup.js's
 * buildBreakdownRows (bar + value + weight% + est marker) for visual
 * consistency across the app — see components.css .breakdown-row*.
 */
function buildScoreBreakdownRows(breakdown) {
  return BREAKDOWN_ORDER.map(key => {
    const m = breakdown?.[key];
    if (!m) return '';
    const val         = Math.round(m.value);
    const pct         = Math.round(m.weight * 100);
    const band        = bandFromValue(val);
    const estMark     = m.estimated
      ? '<span class="breakdown-row__est" title="Estimated — limited data">~</span>'
      : '';
    const rowClass    = m.estimated ? ' breakdown-row--estimated' : '';
    const barEstClass = m.estimated ? ' breakdown-row__bar--estimated' : '';

    return `
      <div class="breakdown-row${rowClass}">
        <span class="breakdown-row__label">${esc(BREAKDOWN_LABELS[key])}</span>
        <div class="breakdown-row__bar-wrap">
          <div class="breakdown-row__bar breakdown-row__bar--${band}${barEstClass}" style="width:${val}%"></div>
        </div>
        <span class="breakdown-row__value">${val}</span>
        <span class="breakdown-row__weight">${pct}%</span>
        ${estMark}
      </div>
    `.trim();
  }).join('');
}

/**
 * Wrap a score chip in a <details> disclosure that reveals its form/fixture/
 * counter breakdown on click — same collapsible pattern as matchup.js's
 * Individual Duels section. The chip itself is the <summary>, so clicking
 * the chip is what reveals the breakdown (ARCHITECTURE.md §8: every
 * displayed score must be explainable via its breakdown).
 *
 * @param {Player} player
 * @param {object} score   scorePlayer result
 * @param {string|null} [rankTier]  from _rankTierByPlayerId — this player's
 *   standing against the FULL pool (FEATURE_ENGINE.md §13), not just the squad
 * @returns {string} HTML — '' if score is missing (not yet scored)
 */
function buildBreakdownDetails(player, score, rankTier = null) {
  if (!score) return '';

  // A player's score is scored over the HORIZON, so it reads every opponent in
  // that window rather than one fixture — there is no two-team subset to wait
  // on the way the Matchup Analyser has. The gate is therefore the whole
  // Understat prefetch: until it settles, this chip is a number that will move
  // on its own, so show that it is still arriving instead. The disclosure
  // stays closed-but-present; its breakdown is real once opened.
  if (!store.isTeamXgSettled()) {
    return `<span class="score-chip skeleton" aria-hidden="true"
                  title="Still calculating — waiting on league-wide counter-matchup data">00</span>`;
  }

  const estClass = isScoreEstimated(score) ? ' score-chip--estimated' : '';
  const chip     = `<span class="score-chip score-chip--${esc(score.band)}${estClass}${rankTierClass(rankTier)}">${Math.round(score.value)}</span>`;
  const context  = buildFixtureContextLabel(score, getHorizon());

  return `
    <details class="dash-breakdown">
      <summary class="dash-breakdown__summary" aria-label="Show score breakdown for ${esc(player.name)}">${chip}</summary>
      <div class="dash-breakdown__panel">
        <div class="dash-breakdown__panel-title">${esc(player.name)} — ${esc(context)}</div>
        ${buildScoreBreakdownRows(score.breakdown)}
      </div>
    </details>
  `.trim();
}

function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
    teamXgBySlug: store.getAllTeamXg(),
    currentGw: store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
  });
}

// ─── GW state detection (Phase 3C-5) ─────────────────────────────────────────

/**
 * Returns the current GW's live state based on the normalised season events.
 * Requires data:ready to have fired; returns 'off-season' if no data.
 *
 * States:
 *   'live'         — GW in progress: isCurrent, not finished, data_checked (FPL
 *                    has processed at least one fixture's data).
 *   'pre-deadline' — GW upcoming: isCurrent, not finished, not yet data_checked.
 *   'finished'     — every match in the current GW has been played.
 *   'off-season'   — no current GW (between seasons or unrecognised state).
 *
 * See normalise.js → events[].dataChecked for how data_checked is exposed, and
 * events[].complete for why the finished test does not read `finished`.
 * @returns {'live'|'pre-deadline'|'finished'|'off-season'}
 */
function getGwState() {
  const currentGwId = store.getCurrentGw();
  if (!currentGwId) return 'off-season';
  const ev = store.getEvents().find(e => e.id === currentGwId);
  if (!ev) return 'off-season';
  // `complete`, not `finished`: FPL holds `finished` back until bonus is
  // confirmed, and until then a round whose last match ended yesterday reads
  // as neither finished nor data_checked — i.e. 'pre-deadline'.
  if (ev.complete) return 'finished';
  if (ev.dataChecked) return 'live';
  return 'pre-deadline';
}

// ─── Live polling (Phase 3C-5) ────────────────────────────────────────────────

/**
 * Fetch live points for the current GW and cache in _livePoints.
 * On failure: sets _liveStale=true and keeps the last known data.
 * Guards against fetching when not on the dashboard (stops the poll).
 */
async function fetchAndCacheLivePoints() {
  // Guard: stop polling silently if user has navigated away.
  const hash = window.location.hash.slice(1) || 'matchup';
  if (hash !== 'dashboard') {
    stopLivePoll();
    return;
  }

  const gw = store.getCurrentGw();
  if (!gw) return;

  try {
    const raw = await fetchLivePoints(gw);
    const map = new Map();
    for (const el of raw?.elements ?? []) {
      if (Number.isInteger(el.id) && typeof el.stats?.total_points === 'number') {
        map.set(el.id, el.stats.total_points);
      }
    }
    _livePoints = map;
    _liveStale  = false;
  } catch (err) {
    // Non-fatal: preserve last known data and flag stale. CONVENTIONS.md §9.
    _liveStale = true;
    console.warn('[dashboard] Live points fetch failed — showing stale data:', err.message ?? err);
  }

  renderDecisions();
}

/**
 * Start the live poll. No-op if already polling.
 * Immediately fires the first fetch, then repeats every LIVE_POLL_INTERVAL_MS.
 */
function startLivePoll() {
  if (_pollTimer !== null) return;
  fetchAndCacheLivePoints();
  _pollTimer = setInterval(fetchAndCacheLivePoints, LIVE_POLL_INTERVAL_MS);
}

/**
 * Stop the live poll. No-op if not polling.
 * Called on hashchange away from dashboard, on data:ready (reset), and on
 * GW state transition to finished/pre-deadline.
 */
function stopLivePoll() {
  if (_pollTimer === null) return;
  clearInterval(_pollTimer);
  _pollTimer = null;
}

/**
 * Evaluate whether live polling should be running given the current hash and
 * GW state. Start or stop accordingly.
 */
function reconcileLivePoll() {
  const hash = window.location.hash.slice(1) || 'matchup';
  if (hash === 'dashboard' && _dataReady && getGwState() === 'live') {
    startLivePoll();
  } else {
    stopLivePoll();
  }
}

// ─── Squad management ─────────────────────────────────────────────────────────
// Reads store.getSquad() directly rather than caching a local copy — the
// store is the only source of truth (CONVENTIONS.md §8), and afterSquadChange()
// (subscribed to 'squad:updated') is what re-renders after any mutation, from
// either this module or Planner.

function squadCountByPos(pos) {
  return store.getSquad().filter(id => store.getPlayer(id)?.position === pos).length;
}

function isInSquad(playerId) {
  return store.getSquad().includes(playerId);
}

/**
 * Returns true if the given player can legally be added to the squad
 * (squad not full, position slot available, not already present).
 */
function canAdd(player) {
  if (!player) return false;
  if (store.getSquad().length >= SQUAD_TOTAL) return false;
  if (isInSquad(player.id)) return false;
  if (squadCountByPos(player.position) >= SQUAD_LIMITS[player.position]) return false;
  return true;
}

function addPlayer(playerId) {
  const player = store.getPlayer(playerId);
  if (!player || !canAdd(player)) return;
  // afterSquadChange() runs via the 'squad:updated' subscription, not a direct
  // call here — the same path Planner's edits take, so both modules react
  // identically regardless of which one made the change.
  store.setSquad([...store.getSquad(), playerId]);
}

function removePlayer(playerId) {
  const squad = store.getSquad();
  const idx = squad.indexOf(playerId);
  if (idx < 0) return;
  const next = squad.slice();
  next.splice(idx, 1);
  store.setSquad(next);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score every player in the squad over the global horizon (see getHorizon).
 * Populates _scores. Silently skips players whose team is absent from ctx.
 */
function scoreSquad() {
  if (!_dataReady) return;
  const ctx = buildCtx();
  if (!ctx) return;
  _scores = new Map();
  for (const id of store.getSquad()) {
    const player = store.getPlayer(id);
    if (!player) continue;
    try {
      _scores.set(id, scorePlayer(player, getHorizon(), ctx));
    } catch (err) {
      console.warn('[dashboard] scorePlayer failed for player', id, err.message ?? err);
    }
  }
  ensureRankTiers(ctx);
}

/**
 * Rank tier (FEATURE_ENGINE.md §13) needs a player's standing against the
 * FULL player pool, not just the 15-man squad — "top 30 in the game" has to
 * mean the same thing here as on the Ranker/Planner. Computed once per data
 * load and cached (see _rankTierByPlayerId) — the ranking doesn't depend on
 * squad membership, so there's no reason to re-score ~700 players on every
 * add/remove click. Same per-load cost the Ranker already accepts as normal;
 * this module just doesn't pay it repeatedly.
 */
function ensureRankTiers(ctx) {
  if (_rankTierByPlayerId !== null) return;
  try {
    const ranked = attachRankTiers(rankPlayers(store.getPlayers(), getHorizon(), ctx));
    _rankTierByPlayerId = new Map(ranked.map(r => [r.player.id, r.rankTier]));
  } catch (err) {
    console.warn('[dashboard] full-pool rank computation failed', err?.message ?? err);
    _rankTierByPlayerId = new Map();
  }
}

// ─── Risk flags ───────────────────────────────────────────────────────────────

/**
 * Compute risk flag keys for a player + scorePlayer result pair.
 * @param {Player} player
 * @param {object} score  scorePlayer output
 * @returns {Array<'rotation'|'fixture'|'confidence'|'availability'>}
 */
function getRiskFlags(player, score) {
  const flags = [];
  const ms = score.breakdown?.form?.minutesSecurity ?? 0;
  if (ms < MIN_SEC_RISK)               flags.push('rotation');
  // Both bottom tiers, not just 'brutal': the seven-tier scale split the old
  // 0-25 band in two (21-35 brutal, 0-20 extreme), so testing 'brutal' alone
  // would silently stop flagging the very worst fixtures in the app.
  if (score.band === 'brutal' || score.band === 'extreme') flags.push('fixture');
  if (score.breakdown?.form?.estimated) flags.push('confidence');
  if (player.status !== 'available')    flags.push('availability');
  return flags;
}

const FLAG_LABELS = {
  rotation:     'Rotation Risk',
  fixture:      'Tough Fixture',
  confidence:   'Low Confidence',
  availability: 'Availability Doubt',
};

function buildFlagChips(flags) {
  return flags.map(f =>
    `<span class="dash-flag dash-flag--${esc(f)}">${esc(FLAG_LABELS[f] ?? f)}</span>`
  ).join('');
}

// ─── Live points HTML builders (Phase 3C-5) ───────────────────────────────────

/**
 * Build a live-points display span for a player row.
 * Returns '' if _livePoints has not yet been fetched.
 *
 * @param {number}  playerId
 * @param {boolean} isCaptain  captain's points are doubled in FPL
 * @returns {string}  HTML string or ''
 */
function buildLivePtsHtml(playerId, isCaptain) {
  if (!_livePoints) return '';
  const pts = _livePoints.get(playerId) ?? 0;
  const staleClass = _liveStale ? ' dash-live-pts--stale' : '';
  if (isCaptain) {
    return `<span class="dash-live-pts dash-live-pts--captain${staleClass}" title="Captain: raw points shown; FPL doubles them">`
         + `Live: ${pts}pts (×2 = ${pts * 2}pts)`
         + `</span>`;
  }
  return `<span class="dash-live-pts${staleClass}">Live: ${pts}pts</span>`;
}

// ─── GW state badge ───────────────────────────────────────────────────────────

/**
 * Build the GW state badge shown at the top of the decisions panel.
 * @param {'live'|'pre-deadline'|'finished'|'off-season'} gwState
 * @returns {string}  HTML string
 */
function renderGwStateBadge(gwState) {
  const BADGE = {
    live:           `<span class="gw-state-badge gw-state-badge--live">GW LIVE 🟢</span>`,
    'pre-deadline': `<span class="gw-state-badge gw-state-badge--pre">PRE-DEADLINE ⏳</span>`,
    finished:       `<span class="gw-state-badge gw-state-badge--done">GW FINISHED ✓</span>`,
    'off-season':   `<span class="gw-state-badge gw-state-badge--done">OFF SEASON</span>`,
  };
  // Only show the stale note when we have some data but it failed to refresh.
  const staleNote = (gwState === 'live' && _liveStale && _livePoints !== null)
    ? `<span class="gw-state-badge__stale">· data may be delayed</span>`
    : '';
  return `<div class="dash-gw-state">${BADGE[gwState] ?? ''}${staleNote}</div>`;
}

// ─── Search results visibility helpers ───────────────────────────────────────

function showResults() {
  if (!_searchResults) return;
  _searchResults.classList.add('is-open');
}

function hideResults() {
  if (!_searchResults) return;
  _searchResults.classList.remove('is-open');
}

// ─── Render: search results dropdown ─────────────────────────────────────────

function renderSearchResults() {
  if (!_searchResults) {
    console.warn('[dashboard] renderSearchResults: _searchResults is null — check #dash-search-results in HTML');
    return;
  }
  if (!_searchInput) {
    console.warn('[dashboard] renderSearchResults: _searchInput is null — check #dash-search-input in HTML');
    return;
  }

  const query = _searchInput.value.trim().toLowerCase();

  if (query.length < 2) {
    _searchResults.innerHTML = '';
    hideResults();
    return;
  }

  const allPlayers = store.getPlayers();
  if (allPlayers.length === 0) {
    _searchResults.innerHTML =
      `<li class="dash-search-results__empty">Player data not yet loaded — please wait a moment.</li>`;
    showResults();
    return;
  }

  let results;
  try {
    results = allPlayers
      .filter(p => {
        if (!_searchPosSet.has(p.position)) return false;
        const name     = (p.name     ?? '').toLowerCase();
        const fullName = (p.fullName ?? '').toLowerCase();
        return name.includes(query) || fullName.includes(query);
      })
      .slice(0, 12);
  } catch (err) {
    console.error('[dashboard] renderSearchResults: filter threw —', err);
    hideResults();
    return;
  }

  if (results.length === 0) {
    _searchResults.innerHTML =
      `<li class="dash-search-results__empty">No players found.</li>`;
    showResults();
    return;
  }

  try {
    _searchResults.innerHTML = results.map(p => {
      const team         = store.getTeam(p.teamId);
      const inSquad      = isInSquad(p.id);
      const posSlotsFull = squadCountByPos(p.position) >= SQUAD_LIMITS[p.position];
      const squadFull    = store.getSquad().length >= SQUAD_TOTAL;
      const disabled     = inSquad || posSlotsFull || squadFull;
      const reason       = inSquad      ? 'Already in squad'
                         : posSlotsFull ? `${p.position} slots full`
                         : squadFull    ? 'Squad full'
                         : '';
      const price = (typeof p.price === 'number' && !isNaN(p.price))
        ? p.price.toFixed(1) : '?.?';

      return `
        <li class="dash-search-results__item${disabled ? ' dash-search-results__item--disabled' : ''}"
            data-player-id="${p.id}"
            role="option"
            aria-disabled="${disabled}"
            title="${disabled ? esc(reason) : esc(p.fullName ?? p.name ?? '')}">
          <span class="dash-search-results__name">${esc(p.name ?? '?')}</span>
          <span class="dash-search-results__meta">${team ? esc(team.shortName) : '—'} · ${esc(p.position ?? '?')} · £${price}m</span>
        </li>
      `.trim();
    }).join('');
  } catch (err) {
    console.error('[dashboard] renderSearchResults: innerHTML build threw —', err);
    hideResults();
    return;
  }

  showResults();
}

// ─── Render: squad slots ──────────────────────────────────────────────────────

function renderSquadPanel() {
  const squad = store.getSquad();
  if (_tally) {
    _tally.textContent = `${squad.length} / ${SQUAD_TOTAL} players selected`;
  }

  if (!_squadSlots) return;

  const html = Object.entries(SQUAD_LIMITS).map(([pos, max]) => {
    const playersInPos = squad
      .map(id => store.getPlayer(id))
      .filter(p => p?.position === pos);

    const slots = [];

    for (const player of playersInPos) {
      const score = _scores.get(player.id);
      const team  = store.getTeam(player.teamId);
      const price = (typeof player.price === 'number' && !isNaN(player.price))
        ? player.price.toFixed(1) : '?.?';
      slots.push(`
        <div class="dash-squad-slot dash-squad-slot--filled">
          <span class="dash-squad-slot__name">${esc(player.name)}</span>
          <span class="dash-squad-slot__team">${team ? esc(team.shortName) : '—'}</span>
          <span class="dash-squad-slot__price">£${price}m</span>
          ${buildBreakdownDetails(player, score, _rankTierByPlayerId?.get(player.id))}
          <button class="dash-squad-slot__remove"
                  data-remove-id="${player.id}"
                  type="button"
                  aria-label="Remove ${esc(player.name)}">×</button>
        </div>
      `.trim());
    }

    const emptyCount = max - playersInPos.length;
    for (let i = 0; i < emptyCount; i++) {
      slots.push(`<div class="dash-squad-slot dash-squad-slot--empty">Empty slot</div>`);
    }

    return `
      <div class="dash-squad-group">
        <div class="dash-squad-group__header">
          <span>${esc(pos)}</span>
          <span>${playersInPos.length} / ${max}</span>
        </div>
        ${slots.join('')}
      </div>
    `.trim();
  }).join('');

  _squadSlots.innerHTML = html;
}

// ─── Render: decisions panel ──────────────────────────────────────────────────

function renderDecisions() {
  if (!_decisions) return;

  const squad = store.getSquad();

  // GW badge is shown whenever data is ready — it's always informative.
  const gwState   = _dataReady ? getGwState() : null;
  const badgeHtml = gwState ? renderGwStateBadge(gwState) : '';

  if (squad.length < SQUAD_TOTAL) {
    const remaining = SQUAD_TOTAL - squad.length;
    _decisions.innerHTML = [
      badgeHtml,
      `<p class="dash-decisions__hint">
        Add ${remaining} more player${remaining === 1 ? '' : 's'} to see GW recommendations.
      </p>`,
    ].join('');
    return;
  }

  if (!_dataReady) {
    _decisions.innerHTML = `<p class="dash-decisions__hint">Loading player data…</p>`;
    return;
  }

  // The captain, the XI and the bench are all a RANKING of the squad by a
  // score that is still settling — pickStartingXI and the captaincy reduce
  // below both choose by it. Rendering now would name a captain and then
  // silently name a different one when the last Understat payload landed,
  // which is the one thing a recommendation panel must not do. The GW badge
  // stays: it is a fact about the gameweek, not a product of any score.
  if (!store.isTeamXgSettled()) {
    _decisions.innerHTML = [
      badgeHtml,
      `<div class="skeleton-lines" aria-busy="true"
            title="Still calculating — waiting on league-wide counter-matchup data">
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text"></span>
        <span class="skeleton skeleton--text"></span>
      </div>`,
    ].join('');
    return;
  }

  const scoredSquad = squad
    .map(id => ({ player: store.getPlayer(id), score: _scores.get(id) }))
    .filter(e => e.player && e.score);

  if (scoredSquad.length < SQUAD_TOTAL) {
    _decisions.innerHTML = [
      badgeHtml,
      `<p class="dash-decisions__hint">Computing scores…</p>`,
    ].join('');
    return;
  }

  const { xi, bench } = pickStartingXI(scoredSquad);

  // Captaincy picks the highest real points-scale projection (expectedPoints),
  // NOT the 0-100 composite `score.value` — that composite is a normalised
  // quality score meant for within-position comparisons and does not scale
  // with a position's actual scoring ceiling, so it can rank a merely-solid
  // defender above a genuinely higher-scoring midfielder/forward. See
  // calcExpectedPoints in engine/composite.js and FEATURE_ENGINE.md §10.2.
  const captainEntry = xi.reduce(
    (best, e) => (!best || e.score.expectedPoints.value > best.score.expectedPoints.value ? e : best),
    null,
  );
  const captainId = captainEntry?.player.id ?? null;

  _decisions.innerHTML = [
    badgeHtml,
    renderCaptainBlock(captainEntry),
    renderXIBlock(xi, captainId),
    renderBenchBlock(bench),
  ].join('');
}

// ─── Render: captain block ────────────────────────────────────────────────────

function renderCaptainBlock(entry) {
  if (!entry) return '';
  const { player, score } = entry;
  const team = store.getTeam(player.teamId);
  const flags = getRiskFlags(player, score);
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';

  const price = (typeof player.price === 'number' && !isNaN(player.price))
    ? player.price.toFixed(1) : '?.?';

  const flagsHtml = flags.length
    ? `<div class="dash-player-row__flags" style="margin-top:var(--space-2)">${buildFlagChips(flags)}</div>`
    : '';

  // Live pts for captain: show raw and doubled value.
  const captainLiveHtml = buildLivePtsHtml(player.id, true);

  // Real points-scale projection driving the pick itself — see the reasoning
  // in renderDecisions() for why this (not score.value) selects the captain.
  const predictedHtml = score.expectedPoints
    ? `<span class="dash-captain__predicted" title="Projected FPL points for the upcoming game, fixture- and playing-time-adjusted">Predicted ${score.expectedPoints.value.toFixed(1)} pts</span>`
    : '';

  return `
    <div class="dash-captain">
      <div class="dash-captain__header">
        <span class="dash-captain__badge" aria-label="Captain">C</span>
        <div>
          <div class="dash-captain__title">Captain Pick</div>
          <div class="dash-captain__name">
            ${esc(player.name)}${statusMark}
            <span class="dash-captain__price">£${price}m</span>
            ${team ? `<span class="dash-captain__team">${esc(team.shortName)}</span>` : ''}
            ${predictedHtml}
          </div>
        </div>
        <div class="dash-captain__score-wrap">
          ${buildBreakdownDetails(player, score, _rankTierByPlayerId?.get(player.id))}
          ${captainLiveHtml}
        </div>
      </div>
      ${flagsHtml}
    </div>
  `.trim();
}

// ─── Render: player row (shared by XI and bench) ──────────────────────────────

/**
 * Render one player row for the Starting XI or Bench list.
 * When live points are available (_livePoints !== null), a live-pts span is
 * appended alongside the projected score chip.
 *
 * @param {{player: Player, score: object}} entry
 * @param {number|null} captainId  the captain's player id (XI only; null for bench)
 */
function renderPlayerRow(entry, captainId) {
  const { player, score } = entry;
  const team      = store.getTeam(player.teamId);
  const isCaptain = player.id === captainId;
  const flags     = getRiskFlags(player, score);
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';

  // Live points: captain's points are doubled in FPL — show both raw and ×2.
  const liveHtml = buildLivePtsHtml(player.id, isCaptain);
  const price = (typeof player.price === 'number' && !isNaN(player.price))
    ? player.price.toFixed(1) : '?.?';

  return `
    <div class="dash-player-row${isCaptain ? ' dash-player-row--captain' : ''}">
      <span class="dash-player-row__pos-badge">
        <span class="ranker-pos-badge ranker-pos-badge--${player.position.toLowerCase()}">${esc(player.position)}</span>
      </span>
      <span class="dash-player-row__name">
        ${esc(player.name)}${statusMark}${isCaptain ? '<span class="dash-player-row__captain-mark">&nbsp;(C)</span>' : ''}
      </span>
      <span class="dash-player-row__team">${team ? esc(team.shortName) : '—'}</span>
      <span class="dash-player-row__price">£${price}m</span>
      <span class="dash-player-row__score">
        ${buildBreakdownDetails(player, score, _rankTierByPlayerId?.get(player.id))}
        ${liveHtml}
      </span>
      ${flags.length ? `<span class="dash-player-row__flags">${buildFlagChips(flags)}</span>` : ''}
    </div>
  `.trim();
}

// ─── Render: Starting XI block ────────────────────────────────────────────────

function renderXIBlock(xi, captainId) {
  const posOrder = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };
  const sorted = xi.slice().sort((a, b) => {
    const pd = posOrder[a.player.position] - posOrder[b.player.position];
    return pd !== 0 ? pd : b.score.value - a.score.value;
  });

  // Update the "Score" column header label when live data is present.
  const scoreColLabel = _livePoints ? 'Proj / Live' : 'Score';

  return `
    <div class="dash-xi">
      <div class="dash-xi__header">
        <span>Starting XI</span>
        <span>${esc(scoreColLabel)}</span>
      </div>
      ${sorted.map(e => renderPlayerRow(e, captainId)).join('')}
    </div>
  `.trim();
}

// ─── Render: Bench block ──────────────────────────────────────────────────────

function renderBenchBlock(bench) {
  if (!bench || bench.length === 0) return '';
  return `
    <div class="dash-bench">
      <div class="dash-bench__header">
        <span>Bench (priority order)</span>
        <span>Score</span>
      </div>
      ${bench.map(e => renderPlayerRow(e, null)).join('')}
    </div>
  `.trim();
}

// ─── After squad change ───────────────────────────────────────────────────────

function afterSquadChange() {
  scoreSquad();
  renderSquadPanel();
  renderDecisions();
  if (_searchInput) _searchInput.value = '';
  hideResults();
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onSearchInput() {
  renderSearchResults();
}

function onSearchFocus() {
  if ((_searchInput?.value.trim().length ?? 0) >= 2) renderSearchResults();
}

function onSearchBlur() {
  setTimeout(hideResults, 150);
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    hideResults();
    _searchInput?.blur();
  }
}

function onResultsMousedown(e) {
  const item = e.target.closest('[data-player-id]');
  if (!item) return;
  if (item.classList.contains('dash-search-results__item--disabled')) return;
  const id = Number(item.dataset.playerId);
  if (!id) return;
  e.preventDefault();
  addPlayer(id);
}

function onSquadSlotsClick(e) {
  const btn = e.target.closest('[data-remove-id]');
  if (!btn) return;
  removePlayer(Number(btn.dataset.removeId));
}

/**
 * hashchange handler: start or stop the live poll based on the active view
 * and current GW state. Attached once in wireDom().
 */
function onHashChange() {
  reconcileLivePoll();
}

// ─── Squad import helpers (Phase 4-1) ────────────────────────────────────────

/**
 * Replace the current squad with the given player IDs, respecting slot limits.
 * IDs that exceed a position's slot limit (shouldn't happen with valid FPL picks,
 * but guard anyway) are silently dropped. Triggers a full re-score + re-render.
 * @param {number[]} playerIds
 */
function replaceSquad(playerIds) {
  const counts = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const accepted = [];
  for (const id of playerIds) {
    const player = store.getPlayer(id);
    if (!player) continue;
    const pos = player.position;
    if (!SQUAD_LIMITS[pos]) continue;
    if (counts[pos] >= SQUAD_LIMITS[pos]) continue;
    counts[pos]++;
    accepted.push(id);
  }
  store.setSquad(accepted);
}

/**
 * Render the team name and overall rank from the last import's entryInfo.
 * Clears the info element when entryInfo is null.
 * @param {object|null} entryInfo  raw FPL entry object
 */
function renderImportInfo(entryInfo) {
  if (!_importInfo) return;
  if (!entryInfo) {
    _importInfo.textContent = '';
    return;
  }
  const teamName = entryInfo.name ?? '';
  const manager  = `${entryInfo.player_first_name ?? ''} ${entryInfo.player_last_name ?? ''}`.trim();
  const rank     = entryInfo.summary_overall_rank
    ? `Overall rank: ${Number(entryInfo.summary_overall_rank).toLocaleString()}`
    : '';
  const parts = [teamName, manager, rank].filter(Boolean);
  _importInfo.textContent = parts.join(' · ');
}

/**
 * Show a status message in the import panel.
 * @param {string} msg
 * @param {'idle'|'loading'|'success'|'error'} type
 */
function showImportStatus(msg, type) {
  if (!_importStatus) return;
  _importStatus.textContent = msg;
  _importStatus.className = `squad-import-status squad-import-status--${type}`;
}

/**
 * Toggle the import panel's visibility.
 * Pre-fills the ID input from localStorage and clears any prior status.
 */
function openImportPanel() {
  if (!_importPanel) return;
  // The help panel occupies the same overlay slot — collapse it first.
  if (_importHelp) _importHelp.open = false;
  _importPanel.hidden = false;
  _importBtn?.classList.add('is-open');
  if (_importIdInput) {
    const saved = loadSavedTeamId();
    if (saved && !_importIdInput.value) _importIdInput.value = String(saved);
    _importIdInput.focus();
  }
  showImportStatus('', 'idle');
  renderImportInfo(_importedEntryInfo);
}

function closeImportPanel() {
  if (!_importPanel) return;
  _importPanel.hidden = true;
  _importBtn?.classList.remove('is-open');
  showImportStatus('', 'idle');
}

/** Run the import: validate input, fetch, replace squad. */
async function handleImport() {
  if (_importInFlight) return;
  if (!_importIdInput) return;

  const raw = _importIdInput.value.trim();
  const teamId = parseInt(raw, 10);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    showImportStatus('Enter a valid FPL Team ID (numbers only).', 'error');
    return;
  }

  const gw = resolveImportGw();
  if (!gw) {
    showImportStatus('No completed gameweek to import from yet.', 'error');
    return;
  }

  _importInFlight = true;
  showImportStatus(`Importing GW${gw} squad…`, 'loading');

  try {
    const { playerIds, entryInfo, missingCount } = await fetchAndMapSquad(teamId, gw);

    if (playerIds.length === 0) {
      showImportStatus('No recognised players found — check the Team ID and try again.', 'error');
      return;
    }

    saveTeamId(teamId);
    _importedTeamId   = teamId;
    _importedEntryInfo = entryInfo;

    replaceSquad(playerIds);
    renderImportInfo(entryInfo);

    const warn = missingCount > 0 ? ` (${missingCount} player${missingCount === 1 ? '' : 's'} not recognised)` : '';
    showImportStatus(`Imported ${playerIds.length} players from GW${gw}.${warn}`, 'success');
  } catch (err) {
    const detail = err?.upstreamStatus === 404
      ? 'Team not found — check the ID. Private leagues may block access.'
      : (err?.message ?? String(err));
    showImportStatus(`Import failed: ${detail}`, 'error');
    console.warn('[dashboard] Squad import failed:', err);
  } finally {
    _importInFlight = false;
  }
}

/**
 * Cache all DOM refs and attach all event listeners. Called once from
 * onDataReady() — guaranteed to run after the browser has fully parsed the
 * document. The _domWired guard prevents double-wiring.
 */
function wireDom() {
  if (_domWired) return;

  _root          = document.querySelector('[data-module="dashboard"]');
  _searchInput   = document.getElementById('dash-search-input');
  _searchResults = document.getElementById('dash-search-results');
  _squadSlots    = document.getElementById('dash-squad-slots');
  _decisions     = document.getElementById('dash-decisions');
  _tally         = document.getElementById('dash-squad-tally');

  if (!_root) {
    console.warn('[dashboard] data-module="dashboard" section not found in DOM');
    return;
  }
  if (!_searchInput) {
    console.warn('[dashboard] #dash-search-input not found in DOM');
    return;
  }

  // ── Search events ────────────────────────────────────────────────────────
  _searchInput.addEventListener('input',   onSearchInput);
  _searchInput.addEventListener('focus',   onSearchFocus);
  _searchInput.addEventListener('blur',    onSearchBlur);
  _searchInput.addEventListener('keydown', onSearchKeydown);

  _searchResults?.addEventListener('mousedown', onResultsMousedown);

  // ── Position filter pills ────────────────────────────────────────────────
  _root.querySelectorAll('.dash-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      if (_searchPosSet.has(pos)) {
        if (_searchPosSet.size > 1) {
          _searchPosSet.delete(pos);
          btn.classList.remove('is-active');
        }
      } else {
        _searchPosSet.add(pos);
        btn.classList.add('is-active');
      }
      if (_searchResults?.classList.contains('is-open')) renderSearchResults();
    });
  });

  // ── Squad slots — click delegation for remove buttons ────────────────────
  _squadSlots?.addEventListener('click', onSquadSlotsClick);

  // ── Live poll lifecycle — start/stop on navigation ───────────────────────
  window.addEventListener('hashchange', onHashChange);

  // ── Squad import (Phase 4-1) ─────────────────────────────────────────────
  _importBtn     = document.getElementById('dash-import-btn');
  _importPanel   = document.getElementById('dash-import-panel');
  _importIdInput = document.getElementById('dash-import-id');
  _importStatus  = document.getElementById('dash-import-status');
  _importInfo    = document.getElementById('dash-import-info');

  _importHelp    = document.getElementById('dash-import-help');

  _importBtn?.addEventListener('click', openImportPanel);
  // Reciprocal of the guard in openImportPanel — opening help hides the form.
  _importHelp?.addEventListener('toggle', () => {
    if (_importHelp.open) closeImportPanel();
  });
  document.getElementById('dash-import-cancel')?.addEventListener('click', closeImportPanel);
  document.getElementById('dash-import-go')?.addEventListener('click', handleImport);
  _importIdInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleImport();
    if (e.key === 'Escape') closeImportPanel();
  });

  // ── Render the initial shell — squad is already hydrated by store.js ─────
  renderSquadPanel();
  renderDecisions();

  _domWired = true;
  console.log('[dashboard] DOM wired — search input listener attached');
}

/**
 * Set when data changed while the Dashboard was off screen, so activation
 * knows it owes a re-score. See onRouteChanged.
 */
let _pendingRender = false;

function onDataReady() {
  wireDom();       // no-op after first call

  // Reset live state on each data:ready so a new GW always starts from scratch.
  stopLivePoll();
  _livePoints = null;
  _liveStale  = false;

  // Force a fresh full-pool rank computation for the new data (see ensureRankTiers).
  _rankTierByPlayerId = null;

  _dataReady = true;

  // Everything above is bookkeeping: cheap, and it must stay eager so the
  // module's state stays truthful whether or not anyone is looking. Everything
  // below is the expensive half — scoreSquad() drives ensureRankTiers, a
  // full-pool ranking measured at ~920ms. Because data:ready fires once per
  // team-xG payload at boot, running that off screen cost ~18s of blocking work
  // on a tab that was not visible. Invalidate always, recompute lazily.
  if (store.getActiveModule() !== 'dashboard') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;

  scoreSquad();
  renderSquadPanel();
  renderDecisions();

  // Start live polling if we're already on the dashboard and the GW is live.
  reconcileLivePoll();
}

/**
 * Flush a render deferred while off screen, once the Dashboard is shown.
 *
 * reconcileLivePoll() is repeated here even though the module's own hashchange
 * handler also calls it: the deferred path above cleared _livePoints and
 * stopped the poll, and the two listeners fire in registration order, which
 * this module should not have to reason about. It is idempotent by design
 * (it reads the hash itself and no-ops off the dashboard), so calling it from
 * both places is safe and removes the ordering dependency.
 */
function onRouteChanged(module) {
  if (module !== 'dashboard' || !_pendingRender) return;
  _pendingRender = false;
  scoreSquad();
  renderSquadPanel();
  renderDecisions();
  reconcileLivePoll();
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the GW Decision Dashboard module. Called once from main.js on
 * bootstrap, before loadInitialData(). Registers the data:ready subscription
 * so the module is ready to receive the event whenever the fetch completes.
 * All DOM wiring is deferred to wireDom(), called from onDataReady(), so that
 * getElementById calls are guaranteed to find live elements.
 *
 * Also subscribes to 'squad:updated' so a squad built or imported on the
 * Planner — or anywhere else — re-scores and re-renders here too, with no
 * rebuild step. afterSquadChange() itself no-ops safely via renderSquadPanel's/
 * renderDecisions' null DOM-ref guards if this module hasn't wired yet.
 */
export function initDashboard() {
  store.subscribe('data:ready', onDataReady);
  store.subscribe('route:changed', onRouteChanged);
  store.subscribe('squad:updated', afterSquadChange);

  // If the store is already hydrated from sessionStorage, data:ready won't
  // fire again — wire the DOM and render immediately.
  if (store.isFresh()) {
    onDataReady();
  }
}
