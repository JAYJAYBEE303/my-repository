/**
 * js/modules/ranker.js
 * Layer: module. Owns the DOM for the Player Ranker view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders a sortable, filterable table of players ranked by projected value
 * over the active horizon. Lazy-loads player summaries on click. The
 * "Avg Pts/GW source" toggle is the one exception to "never bulk-fetch": an
 * explicit click on "Last Season" triggers a chunked, staggered load of every
 * player's summary (FEATURE_ENGINE.md §10.1) — deliberate and user-triggered,
 * never automatic. No analytical logic lives here; all scoring delegated to
 * engine/composite.js.
 * See ARCHITECTURE.md §10, FEATURE_ENGINE.md §11, ROADMAP.md Phase 2B.
 *
 * Subscriptions: data:ready, horizon:changed, route:changed
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import {
  HORIZONS, RANKER_CHUNK_SIZE, SUMMARY_FETCH_CHUNK_SIZE,
  PRICE_FILTER_MIN, PRICE_FILTER_MAX, PRICE_FILTER_STEP,
  RANK_ELITE_COUNT_BY_POS, RANK_STRONG_COUNT_BY_POS,
  RANK_TOP_PERCENTILE, RANK_BOTTOM_PERCENTILE,
} from '../config.js';
import {
  buildScoreContext, scorePlayer, attachRankTiers, calcLastSeasonAvgPointsPerGw,
  bandFromValue, rankTierMapBy,
} from '../engine/composite.js';
import { fetchPlayerSummary } from '../api.js';
import { normalisePlayerSummary } from '../engine/normalise.js';
import { calcSeasonPriceChange } from '../engine/prices.js';
import { groupPerGwSlots, pendingFixturesForTeam } from '../engine/fixtures.js';
import { playtimeBand } from '../engine/form.js';

// ─── Playtime display ────────────────────────────────────────────────────────
// Playtime labels/bands live in config.js (PLAYTIME_BANDS) and are applied by
// engine/form.js's playtimeBand(), so the column, the filter pills and the
// engine can never disagree about where 'Likely' stops and 'Rotation' starts.

// ─── Module-level state ───────────────────────────────────────────────────────

let _table              = null;
let _thead              = null;
let _tbody              = null;
let _loading            = null;
let _teamSelect         = null;
let _priceSelect        = null;
let _avgPtsToggle       = null;

// 'current' | 'lastSeason' — explicit, user-toggled Avg Pts/GW source
// (FEATURE_ENGINE.md §10.1). Never switches itself; the button is the only
// way this changes.
let _avgPtsMode = 'current';

// Incremented on every "Last Season" toggle-on; the in-flight chunked bulk
// loader checks its captured value still matches before continuing each
// chunk, so switching back to "This Season" (or toggling on again) cancels
// the previous run rather than racing it.
let _summaryLoadRunId = 0;

// Scored rows rebuilt on data:ready or horizon:changed; cached so filter and
// sort changes do not re-invoke the engine.
let _rows = [];

// Incremented on every new ranking run; each async chunk checks its captured
// value still matches before continuing, cancelling stale in-flight runs.
let _computeId = 0;

// Active filter / sort / display state.
// Empty set = no filter on that axis (every position / every playtime level
// shows) — selecting a pill narrows to just the selected ones, rather than
// the old "all selected by default" scheme where narrowing to one position
// meant deselecting the other three.
let _activePosSet    = new Set();
let _activePriceBand = 'all';      // 'all' | numeric-string maximum price threshold
let _activeTeamId    = 'all';
let _activeMinSecSet = new Set();
let _sortBy          = 'value';    // 'value' | 'costPerPoint' | 'price' | 'playtime' | 'name' | 'team'
                                   //   | 'avgPointsPerGw' | 'totalPoints' | 'fplForm' | 'nextFixtureScore'
                                   //   | 'priceChange' | 'transfersInEvent' | 'transfersOutEvent'
let _sortDesc        = true;

// In-flight lazy loads keyed by playerId so concurrent clicks on the same
// player share one Promise and never fire duplicate network requests.
const _pendingLoads = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string placed inside innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * True when a scorePlayer result has at least one estimated sub-metric,
 * signalling that the projected score should render with the estimated treatment.
 * Uses the breakdown rather than a top-level confidence field because scorePlayer
 * does not currently compute a single confidence number.
 */
function isScoreEstimated(score) {
  return Boolean(score?.breakdown?.form?.estimated || score?.breakdown?.counter?.estimated);
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

/**
 * What the Player column shows.
 *
 * FPL's `web_name` is a surname or a nickname — "Szoboszlai", "Gakpo" — which
 * is compact but ambiguous across a 700-player pool. `fullName` is first_name
 * and second_name joined by normalise.js.
 *
 * `||` rather than `??`: normalise.js builds fullName by trimming a template
 * string, so a player FPL published neither part for arrives as '' rather than
 * null, and `??` would let that empty string through to the cell.
 *
 * @param {Player} player
 * @returns {string}
 */
function displayName(player) {
  return player.fullName || player.name;
}

/** rankTier (composite.js → calcRankTier) → the .score-chip--rank-* modifier
 *  suffix. Every player gets one of the six now (calcRankTier only returns
 *  null for a malformed/empty pool), so '' is effectively unreachable in
 *  practice — kept as a safe fallback, not a normal case. See FEATURE_ENGINE.md §13. */
function rankTierClass(rankTier) {
  if (rankTier === 'positionBest')     return ' score-chip--rank-gold';
  if (rankTier === 'positionElite')    return ' score-chip--rank-green';
  if (rankTier === 'positionStrong')   return ' score-chip--rank-light-green';
  if (rankTier === 'topPercentile')    return ' score-chip--rank-neutral';
  if (rankTier === 'bottomPercentile') return ' score-chip--rank-red';
  if (rankTier === 'midPercentile')    return ' score-chip--rank-yellow';
  return '';
}

/** Human label for a position, used only in the rank-tier tooltip below. */
const POSITION_LABELS = { GKP: 'goalkeepers', DEF: 'defenders', MID: 'midfielders', FWD: 'forwards' };

/**
 * Tooltip text for a rank-tier chip. positionElite/positionStrong's counts
 * are PER-POSITION (RANK_ELITE_COUNT_BY_POS/RANK_STRONG_COUNT_BY_POS), so the
 * text must read the player's own position rather than a single fixed string
 * — built from the live config constants, not hardcoded numbers, so this
 * never goes stale if either table is retuned. topPercentile/bottomPercentile
 * are POOL-WIDE (not per-position — see calcRankTier's JSDoc), so their text
 * doesn't mention a position; midPercentile's implied width (100% minus the
 * other two) is likewise derived from config, not a hardcoded "35%".
 *
 * `metric` names WHICH column's ranking this is. Three columns now carry these
 * chips and each is ranked on its own number, so a tooltip that only said "top
 * 5 defenders in the game" would be the same sentence under three different
 * colourings — and wrong for two of them.
 */
function rankTierTitle(rankTier, position, metric = 'rating') {
  const posLabel = POSITION_LABELS[position] ?? 'players';
  if (rankTier === 'positionBest')   return `Best ${metric} of all ${posLabel} in the game`;
  if (rankTier === 'positionElite')  return `Top ${RANK_ELITE_COUNT_BY_POS[position]} ${posLabel} in the game by ${metric}`;
  if (rankTier === 'positionStrong') return `Top ${RANK_STRONG_COUNT_BY_POS[position]} ${posLabel} in the game by ${metric}`;
  if (rankTier === 'topPercentile')    return `Top ${Math.round(RANK_TOP_PERCENTILE * 100)}% of players in the game by ${metric}`;
  if (rankTier === 'bottomPercentile') return `Bottom ${Math.round(RANK_BOTTOM_PERCENTILE * 100)}% of players in the game by ${metric}`;
  if (rankTier === 'midPercentile') {
    const midPct = Math.round((1 - RANK_TOP_PERCENTILE - RANK_BOTTOM_PERCENTILE) * 100);
    return `Middle ${midPct}% of players in the game by ${metric}`;
  }
  return '';
}

/**
 * Wrap an already-built cell body in a rank-coloured chip.
 *
 * Returns the body UNWRAPPED when there is no tier — a player outside the
 * ranked pool for this metric (no Cost/Pt, last season's figure still
 * loading). A chip with no colour would read as a fourth state the table does
 * not have; the bare number is the honest rendering of "not ranked here".
 */
function metricChip(body, rankTier, title) {
  if (!rankTier) return body;
  return `<span class="score-chip${rankTierClass(rankTier)}" title="${esc(title)}">${body}</span>`;
}

/**
 * Hover text for the Playtime badge. The column shows one word; the model has
 * four inputs, and which of them is dragging a player down is exactly what the
 * user needs to know — "Rotation because his club plays seven midfielders" is
 * a different decision from "Rotation because he is carrying a knock".
 *
 * @param {object} pt  breakdown.playtime from scorePlayer (§7.3b)
 * @returns {string}   plain text, inserted as a title attribute
 */
function playtimeTitle(pt) {
  const pct = v => `${Math.round((v ?? 0) * 100)}%`;
  const parts = [
    `Starts ${pct(pt.startRate)} of games`,
    `${pct(pt.minutesShare)} of available minutes`,
  ];
  // Only mention crowding when there is actually something to say about it.
  if ((pt.crowding ?? 1) > 1.35) {
    parts.push(`squad is rotating ${pt.crowding.toFixed(1)} players per slot in this position`);
  }
  if ((pt.availability ?? 100) < 100) {
    parts.push(`${Math.round(pt.availability)}% chance of playing`);
  }
  if (pt.estimated) {
    parts.push('early season — still weighted toward the price-implied role');
  }
  return parts.join(' · ');
}

/**
 * Playtime read for one scored row. Prefers the §7.3b squad-context model that
 * scorePlayer attaches; falls back to banding the raw form ratio only if a
 * caller somehow supplies a score from before that existed.
 */
function playtimeOf(score) {
  return score?.breakdown?.playtime
    ?? playtimeBand(score?.breakdown?.form?.minutesSecurity ?? 0);
}

/**
 * Price filter — `band` is either 'all' (unrestricted — includes players both
 * below PRICE_FILTER_MIN and above PRICE_FILTER_MAX) or a numeric-string
 * maximum-price threshold, e.g. '9.0' meaning "£9.0m and below".
 */
function priceInBand(price, band) {
  if (band === 'all') return true;
  return price <= parseFloat(band);
}

/**
 * Populate the price <select> with 'All Prices' plus a generated run of
 * maximum-price thresholds from PRICE_FILTER_MIN to PRICE_FILTER_MAX in
 * PRICE_FILTER_STEP increments (config-driven — see config.js §11).
 */
function populatePriceFilter() {
  if (!_priceSelect) return;
  const options = ['<option value="all">All Prices</option>'];
  // Round to 1dp to avoid floating-point drift (4.0 + 0.5 + 0.5 + ... ).
  const steps = Math.round((PRICE_FILTER_MAX - PRICE_FILTER_MIN) / PRICE_FILTER_STEP);
  for (let i = 0; i <= steps; i++) {
    const price = Math.round((PRICE_FILTER_MIN + i * PRICE_FILTER_STEP) * 10) / 10;
    options.push(`<option value="${price}">£${price.toFixed(1)}m and below</option>`);
  }
  _priceSelect.innerHTML = options.join('');
}

/** First upcoming unplayed fixture for `teamId`, GW ascending. */
function getNextFixtureForTeam(teamId) {
  return store.getFixtures()
    .filter(f => !f.played && f.gw !== null &&
                 (f.homeTeamId === teamId || f.awayTeamId === teamId))
    .sort((a, b) => a.gw - b.gw || (a.kickoff || '').localeCompare(b.kickoff || ''))[0]
    ?? null;
}

/**
 * A tbody of placeholder rows, shown while the pool cannot yet be ranked.
 *
 * WHY THE WHOLE TABLE AND NOT JUST THE SCORE CELLS. This table is SORTED by
 * the number that is still settling. Skeletoning the two score columns alone
 * would leave every other column readable but in an order that reshuffles
 * itself the moment the last Understat payload lands — a row the reader was
 * about to click moves out from under them. Withholding the ordering as well
 * as the values is the honest version of the same state.
 *
 * @param {number} rowCount  roughly a screenful — enough to read as a table,
 *   not so many that the placeholder costs more to build than it saves.
 * @returns {string} tbody HTML
 */
function buildSkeletonRows(rowCount = 12) {
  // ONE placeholder per row, spanning every column, rather than one per cell.
  // Per-cell would read marginally more like a table, but this table is 15
  // columns wide, so a screenful of them is ~180 simultaneously animating
  // elements — and the shimmer animates background-position, which the
  // compositor cannot take off the main thread. Trading that for 12 bars costs
  // nothing legible: the state being communicated is "the whole table is
  // still coming", which does not need per-column resolution.
  //
  // The colspan keeps the <thead>'s column widths, so the table does not
  // reflow when the real rows replace these.
  return Array.from(
    { length: rowCount },
    () => `<tr class="ranker-table__row ranker-table__row--skeleton" aria-hidden="true">`
      + `<td class="ranker-table__td" colspan="${colCount()}">`
      + `<span class="skeleton skeleton--text"></span></td></tr>`,
  ).join('');
}

// ─── Build: scored rows ───────────────────────────────────────────────────────

/**
 * Score all players over `horizon` in chunks of RANKER_CHUNK_SIZE, yielding
 * back to the browser between chunks so the UI stays responsive. Shows a live
 * progress indicator while working. Any in-flight run whose `computeId` no
 * longer matches `_computeId` is silently abandoned — this happens when the
 * user changes the horizon or data refreshes mid-compute.
 *
 * Never renders partial results: `_rows` and `renderTable()` are only touched
 * after all chunks complete and the run is confirmed non-stale.
 */
async function rebuildRowsChunked() {
  const computeId = ++_computeId;

  // Every score in this table blends counter-matchup, which needs the whole
  // league's Understat payloads — the pool spans all 20 teams, so unlike the
  // Matchup Analyser there is no smaller set to wait on. Until the prefetch
  // settles, rank nothing and show placeholders.
  //
  // This is also the cheaper path, not just the more honest one: data:ready
  // fires several times through the prefetch, and each full-pool rank costs
  // ~920ms of blocking work whose result was going to be superseded anyway.
  // The last settle schedules one more data:ready (main.js), which is what
  // brings us back here to do the single ranking run that counts.
  if (!store.isTeamXgSettled()) {
    _rows = [];
    renderThead();
    _tbody.innerHTML = buildSkeletonRows();
    _tbody.setAttribute('aria-busy', 'true');
    // The banner reads "Computing rankings…", which is not what is happening
    // here — nothing is being computed, the inputs have not all arrived. The
    // skeleton rows already say "still coming"; a banner claiming work is in
    // progress would be a second, wrong account of the same state.
    if (_loading) _loading.classList.remove('is-visible');
    return;
  }
  _tbody.removeAttribute('aria-busy');

  // Show the progress banner and yield one macrotask tick before snapshotting
  // ctx. This matches the single-tick deferral the old synchronous rebuildRows
  // had via its outer setTimeout(0) wrapper. The yield lets any microtasks
  // queued alongside data:ready (e.g. leagueXg resolving, sessionStorage
  // hydration completing) settle into the store before we freeze ctx, preventing
  // false estimated flags from a stale snapshot.
  _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">Ranking players…</td></tr>`;
  if (_loading) _loading.classList.add('is-visible');
  await new Promise(resolve => setTimeout(resolve, 0));

  if (computeId !== _computeId) return;

  const ctx = buildCtx();
  if (!ctx) return;

  const horizonKey = store.getActiveHorizon();
  const horizon    = HORIZONS[horizonKey] ?? HORIZONS.GW1;
  const players    = store.getPlayers();
  const total      = players.length;
  const pending    = [];

  _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">Ranking players… (0 / ${total})</td></tr>`;

  for (let i = 0; i < total; i += RANKER_CHUNK_SIZE) {
    // Yield between chunks so the browser can paint progress and process input.
    await new Promise(resolve => setTimeout(resolve, 0));

    if (computeId !== _computeId) return;

    const end = Math.min(i + RANKER_CHUNK_SIZE, total);
    for (let j = i; j < end; j++) {
      const player = players[j];
      const score  = scorePlayer(player, horizon, ctx);
      pending.push({ player, team: store.getTeam(player.teamId), score });
    }

    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">Ranking players… (${end} / ${total})</td></tr>`;
  }

  // Final stale-check before committing — a horizon change could have fired
  // during the last chunk's execution.
  if (computeId !== _computeId) return;

  // Sort descending by value, matching rankPlayers ordering.
  pending.sort((a, b) => b.score.value - a.score.value);
  // Rank tier (FEATURE_ENGINE.md §13) is computed against the FULL unfiltered
  // pool, before applyFilters() ever runs — "top 30 in the game" must mean the
  // same thing regardless of which position/price/team pills are active, and
  // must match what Dashboard/Planner (which have no filters at all) compute
  // for the same players.
  _rows = attachRankTiers(pending);

  if (_loading) _loading.classList.remove('is-visible');
  renderTable();
}

// ─── Filter and sort ──────────────────────────────────────────────────────────

function applyFilters(rows) {
  return rows.filter(({ player, score }) => {
    // Empty set = axis not filtered (see _activePosSet's declaration) — only
    // a non-empty set narrows the table down to its members.
    if (_activePosSet.size > 0 &&
        !_activePosSet.has(player.position))          return false;
    if (!priceInBand(player.price, _activePriceBand)) return false;
    if (_activeTeamId !== 'all' &&
        String(player.teamId) !== _activeTeamId)      return false;
    if (_activeMinSecSet.size > 0 &&
        !_activeMinSecSet.has(playtimeOf(score).label)) return false;
    return true;
  });
}

/**
 * Rank every row in `rows` by nextFixtureScore (descending), independent of
 * whatever column the table is currently sorted by — "next-fixture rank" is a
 * standing among the CURRENTLY-FILTERED players, not the whole ~700-player
 * pool, since that's the set the user is actually choosing among.
 * @returns {Map<number, number>} playerId → 1-based rank
 */
function buildNextFixtureRanks(rows) {
  const ranked = rows.slice()
    .sort((a, b) => b.score.nextFixtureScore.value - a.score.nextFixtureScore.value);
  const rankById = new Map();
  ranked.forEach((row, i) => rankById.set(row.player.id, i + 1));
  return rankById;
}

/**
 * @param {Array} rows
 * @param {Map<number,{avg:number|null,cost:number|null}>} [lastSeasonByPlayerId]
 *   from buildLastSeasonLookup — present only when _avgPtsMode==='lastSeason'.
 *   When present, sorting by 'avgPointsPerGw'/'costPerPoint' follows the
 *   DISPLAYED (last-season) values instead of the current-season ones, so the
 *   sort arrow never contradicts what's actually on screen.
 */
function applySort(rows, lastSeasonByPlayerId = null) {
  return rows.slice().sort((a, b) => {
    // costPerPoint can be null (no scoring record, or — in 'lastSeason' mode —
    // no past-season data / not loaded yet) — nulls always sort last,
    // regardless of sort direction, rather than comparing as 0.
    if (_sortBy === 'costPerPoint') {
      const av = lastSeasonByPlayerId
        ? lastSeasonByPlayerId.get(a.player.id)?.cost ?? null
        : a.score.costPerPoint;
      const bv = lastSeasonByPlayerId
        ? lastSeasonByPlayerId.get(b.player.id)?.cost ?? null
        : b.score.costPerPoint;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return _sortDesc ? (bv - av) : (av - bv);
    }
    // Same null-sorts-last treatment as costPerPoint above, for the same
    // reason: in 'lastSeason' mode a player may have no past-season data yet.
    if (_sortBy === 'avgPointsPerGw' && lastSeasonByPlayerId) {
      const av = lastSeasonByPlayerId.get(a.player.id)?.avg ?? null;
      const bv = lastSeasonByPlayerId.get(b.player.id)?.avg ?? null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return _sortDesc ? (bv - av) : (av - bv);
    }
    // String columns use localeCompare, not subtraction. Same descending-first
    // convention as every numeric column, for consistency (first click = 'Z'
    // first) — the sort-arrow indicator shows the direction either way.
    if (_sortBy === 'name' || _sortBy === 'team') {
      const av = _sortBy === 'name' ? displayName(a.player) : (a.team?.name ?? '');
      const bv = _sortBy === 'name' ? displayName(b.player) : (b.team?.name ?? '');
      const cmp = av.localeCompare(bv);
      return _sortDesc ? -cmp : cmp;
    }
    let av, bv;
    if (_sortBy === 'price') {
      av = a.player.price; bv = b.player.price;
    } else if (_sortBy === 'playtime') {
      av = playtimeOf(a.score).value ?? 0;
      bv = playtimeOf(b.score).value ?? 0;
    } else if (_sortBy === 'totalPoints') {
      av = a.player.totals?.points ?? 0;
      bv = b.player.totals?.points ?? 0;
    } else if (_sortBy === 'fplForm') {
      av = a.player.fplForm ?? 0;
      bv = b.player.fplForm ?? 0;
    } else if (_sortBy === 'priceChange') {
      // Sorted on the RAW tenths, not calcSeasonPriceChange's millions: the
      // divide by 10 is monotonic, so the ordering is identical and this skips
      // ~7,000 object allocations per sort. Signed, so descending puts the
      // season's biggest risers on top and the biggest fallers at the bottom.
      av = a.player.costChangeStart ?? 0;
      bv = b.player.costChangeStart ?? 0;
    } else if (_sortBy === 'transfersInEvent') {
      av = a.player.transfersInEvent ?? 0;
      bv = b.player.transfersInEvent ?? 0;
    } else if (_sortBy === 'transfersOutEvent') {
      av = a.player.transfersOutEvent ?? 0;
      bv = b.player.transfersOutEvent ?? 0;
    } else if (_sortBy === 'avgPointsPerGw') {
      av = a.score.avgPointsPerGw.value; bv = b.score.avgPointsPerGw.value;
    } else if (_sortBy === 'nextFixtureScore') {
      av = a.score.nextFixtureScore.value; bv = b.score.nextFixtureScore.value;
    } else {
      av = a.score.value; bv = b.score.value;
    }
    return _sortDesc ? (bv - av) : (av - bv);
  });
}

/**
 * Precompute each player's 'lastSeason' avg/cost ONCE per render (not once
 * per sort comparison, and not once per row) — cheap lookups thereafter for
 * both applySort and buildRow. Only built while _avgPtsMode==='lastSeason'.
 * @param {Array} rows
 * @param {object} ctx
 * @returns {Map<number, {avg:number|null, cost:number|null, seasonName:string|null, loaded:boolean}>}
 */
function buildLastSeasonLookup(rows, ctx) {
  const map = new Map();
  for (const { player } of rows) {
    const loaded = Boolean(ctx.playerSummariesById?.[player.id]);
    const lastSeason = calcLastSeasonAvgPointsPerGw(player, ctx);
    const cost = (lastSeason && player.price > 0 && lastSeason.value > 0)
      ? player.price / lastSeason.value : null;
    map.set(player.id, {
      avg:        lastSeason?.value ?? null,
      cost,
      seasonName: lastSeason?.seasonName ?? null,
      loaded,
    });
  }
  return map;
}

// ─── Build: HTML fragments ────────────────────────────────────────────────────

/**
 * Per-GW fixture strip for one player row, rendered as one slot per GAMEWEEK.
 *
 * Each slot holds zero (blank), one, or two (double) fixture cells, so a 6-GW
 * horizon always shows six slots — it previously showed one cell per FIXTURE,
 * which meant a horizon containing a double rendered seven cells with nothing
 * tying two of them to the same week. Postponed fixtures have no gameweek at
 * all, so they trail the strip as a pill rather than sitting inside it.
 *
 * Reuses .pgw-cell + .pgw-cell--<band> from components.css so band colours stay
 * consistent across all modules (CONVENTIONS.md §5.2); schedule structure is
 * carried by the slot geometry instead. See FEATURE_ENGINE.md §9.1.
 *
 * @param {Array} perGw   from scoreOverHorizon
 * @param {Array} pending from pendingFixturesForTeam — postponed, no gameweek
 */
function buildFixtureStrip(perGw, pending = []) {
  const slots = groupPerGwSlots(perGw);
  if (slots.length === 0) {
    return '<span class="ranker-no-fixtures">—</span>';
  }

  const slotHtml = slots.map(slot => {
    const cells = slot.fixtures.map(entry => {
      const band    = entry.isBlank ? 'neutral' : entry.band;
      const tooltip = entry.isBlank
        ? `GW${entry.gw} — blank (no fixture)`
        : `GW${entry.gw} ${entry.opponent ?? ''} (${entry.venue ?? ''}) — ${Math.round(entry.value)}`
          + `${entry.provisional ? ' ~est' : ''}`
          + `${entry.provisionalKickoff ? ' — kickoff TBC' : ''}`;
      // '∅' rather than the old '–': a dash is what missing data looks like,
      // and a blank gameweek is a known fact, not an absence of one.
      const label    = entry.isBlank ? '∅' : (entry.opponent ?? '?');
      const estClass = (!entry.isBlank && entry.provisional) ? ' pgw-cell--estimated' : '';
      const blkClass = entry.isBlank ? ' pgw-cell--blank' : '';
      const tbcClass = entry.provisionalKickoff ? ' pgw-cell--tbc' : '';
      return `<span class="pgw-cell pgw-cell--${esc(band)}${estClass}${blkClass}${tbcClass}" title="${esc(tooltip)}">${esc(label)}</span>`;
    }).join('');

    const dblClass = slot.isDouble ? ' pgw-slot--double' : '';
    const dblMark  = slot.isDouble ? ' ··' : '';
    return `<span class="pgw-slot${dblClass}">`
      + `<span class="pgw-slot__cells">${cells}</span>`
      + `<span class="pgw-slot__label">${esc(String(slot.gw))}${dblMark}</span>`
      + `</span>`;
  }).join('');

  const pendingHtml = pending.length > 0
    ? `<span class="pgw-pending" title="${pending.length} postponed fixture${pending.length > 1 ? 's' : ''} awaiting a rearranged date">+${pending.length} TBD</span>`
    : '';

  return `<span class="ranker-fixtures">${slotHtml}${pendingHtml}</span>`;
}

/**
 * Build a single <tr> HTML string for one player row.
 * minutesSecurity is read from score.breakdown.form (set by composite.js's
 * scorePlayer) to avoid a second calcPlayerForm call per row.
 *
 * @param {{player: Player, team: Team, score: object, rankTier: string|null}} row
 *   rankTier from attachRankTiers, computed against the FULL pool (FEATURE_ENGINE.md §13)
 * @param {Map<number, number>} nextFixtureRankById  from buildNextFixtureRanks
 * @param {Map<number, object>|null} lastSeasonByPlayerId  from buildLastSeasonLookup,
 *   present only when the "Avg Pts/GW source" toggle is set to 'lastSeason'.
 *   When present, it overrides both the Avg Pts/GW and Cost/Pt cells below —
 *   the toggle is explicit, so the displayed figures must match its label
 *   exactly, not silently fall back to current-season numbers.
 */
/**
 * @param {object} pendingCtx  the Season, read for pendingFixturesByTeam only.
 *   Passed down rather than rebuilt per row: buildCtx() is far too expensive to
 *   call ~700 times per render, and the pending index is identical for every row.
 * @param {{avg: Map, cost: Map}} metricRanks  per-metric rank-tier lookups for
 *   the Avg Pts/GW and Cost/Pt columns (renderTable → rankTierMapBy). Each
 *   column is ranked on ITS OWN number — reusing the Value tier here would
 *   colour three columns by one metric and say nothing about the other two.
 */
function buildRow({ player, team, score, rankTier }, nextFixtureRankById, lastSeasonByPlayerId, pendingCtx, metricRanks) {
  const statusMark = player.status !== 'available'
    ? `<span class="ranker-status-badge" title="${esc(player.statusNote || player.status)}">!</span>`
    : '';
  const pt       = playtimeOf(score);
  const estClass = isScoreEstimated(score) ? ' score-chip--estimated' : '';

  let avgPtsDisplay, costPerPointDisplay;

  if (lastSeasonByPlayerId) {
    // 'lastSeason' mode (FEATURE_ENGINE.md §10.1) — three distinct states per
    // player, not just loaded/unloaded: still loading (bulk fetch in flight),
    // loaded but no past-season record at all (a definitive "—", not an
    // estimate), or loaded with a real last-season figure (always flagged ~,
    // since by definition it isn't this season's number).
    const ls = lastSeasonByPlayerId.get(player.id);
    if (!ls?.loaded) {
      avgPtsDisplay = '<span class="ranker-no-fixtures" title="Loading last season’s data…">…</span>';
      costPerPointDisplay = '<span class="ranker-no-fixtures" title="Loading last season’s data…">…</span>';
    } else if (ls.avg === null) {
      avgPtsDisplay = '<span class="ranker-no-fixtures" title="No past-season data for this player">—</span>';
      costPerPointDisplay = '<span class="ranker-no-fixtures" title="No past-season data for this player">—</span>';
    } else {
      const seasonLabel = esc(ls.seasonName ?? 'last season');
      const title = `${seasonLabel}'s average — not this season's`;
      avgPtsDisplay = metricChip(
        `${ls.avg.toFixed(1)}<span class="ranker-est-mark" title="${title}">~</span>`,
        metricRanks.avg.get(player.id),
        rankTierTitle(metricRanks.avg.get(player.id), player.position, `Avg Pts/GW (${seasonLabel})`));
      costPerPointDisplay = ls.cost !== null
        ? metricChip(
            `£${esc(ls.cost.toFixed(2))}m<span class="ranker-est-mark" title="Derived from ${title}">~</span>`,
            metricRanks.cost.get(player.id),
            rankTierTitle(metricRanks.cost.get(player.id), player.position, `Cost/Pt (${seasonLabel})`))
        : '<span class="ranker-no-fixtures" title="No past-season data for this player">—</span>';
    }
  } else {
    // 'current' mode — unchanged from before the toggle existed.
    const avgPts = score.avgPointsPerGw;
    const avgPtsTitle = 'Estimated — season totals ÷ estimated games played, no per-GW history loaded yet';
    const avgPtsEstMark = avgPts.estimated
      ? `<span class="ranker-est-mark" title="${avgPtsTitle}">~</span>`
      : '';
    avgPtsDisplay = metricChip(
      `${avgPts.value.toFixed(1)}${avgPtsEstMark}`,
      metricRanks.avg.get(player.id),
      rankTierTitle(metricRanks.avg.get(player.id), player.position, 'Avg Pts/GW'));

    // Cost/Pt is DERIVED from avgPointsPerGw (price ÷ avgPointsPerGw.value) —
    // when that input is estimated, flag the derived figure too, for the same
    // explainability reason.
    costPerPointDisplay = score.costPerPoint !== null
      ? metricChip(
          `£${esc(score.costPerPoint.toFixed(2))}m${avgPts.estimated
            ? `<span class="ranker-est-mark" title="Derived from an estimated Avg Pts/GW — ${avgPtsTitle}">~</span>`
            : ''}`,
          metricRanks.cost.get(player.id),
          rankTierTitle(metricRanks.cost.get(player.id), player.position, 'Cost/Pt'))
      : '<span class="ranker-no-fixtures">—</span>';
  }

  const nfScore    = score.nextFixtureScore;
  const nfRank     = nextFixtureRankById?.get(player.id);
  const nfBand     = bandFromValue(Math.round(nfScore.value));
  const nfEstClass = nfScore.estimated ? ' score-chip--estimated' : '';

  return `
    <tr class="ranker-table__row" data-player-id="${player.id}"
        tabindex="0" role="button"
        aria-label="Analyse ${esc(displayName(player))} in Matchup Analyser">
      <td class="ranker-table__td ranker-table__td--name" title="${esc(displayName(player))}">
        ${esc(displayName(player))}${statusMark}
      </td>
      <td class="ranker-table__td ranker-table__td--team">
        ${team ? `<img class="ranker-team-badge" src="${esc(team.badgeUrl)}" alt=""
                       width="16" height="16" loading="lazy" decoding="async">` : ''}${team ? esc(team.shortName) : '—'}
      </td>
      <td class="ranker-table__td ranker-table__td--pos">
        <span class="ranker-pos-badge ranker-pos-badge--${player.position.toLowerCase()}">${esc(player.position)}</span>
      </td>
      <td class="ranker-table__td ranker-table__td--price">
        £${esc(player.price.toFixed(1))}m
      </td>
      ${buildPriceChangeCell(player)}
      <td class="ranker-table__td ranker-table__td--cost-per-point">
        ${costPerPointDisplay}
      </td>
      <td class="ranker-table__td ranker-table__td--avg-pts">
        ${avgPtsDisplay}
      </td>
      <td class="ranker-table__td ranker-table__td--total-pts">
        ${player.totals?.points ?? 0}
      </td>
      <td class="ranker-table__td ranker-table__td--form"
          title="FPL's own form figure — average points per match over the last 30 days">
        ${(player.fplForm ?? 0).toFixed(1)}
      </td>
      <td class="ranker-table__td ranker-table__td--tsfr-in"
          title="Transfers IN this gameweek">
        ${esc(fmtCount(player.transfersInEvent))}
      </td>
      <td class="ranker-table__td ranker-table__td--tsfr-out"
          title="Transfers OUT this gameweek">
        ${esc(fmtCount(player.transfersOutEvent))}
      </td>
      <td class="ranker-table__td ranker-table__td--value">
        <span class="score-chip score-chip--${esc(score.band)}${estClass}${rankTierClass(rankTier)}"
              title="${rankTier ? esc(rankTierTitle(rankTier, player.position, 'rating')) : ''}">${Math.round(score.value)}</span>
      </td>
      <td class="ranker-table__td ranker-table__td--next-fixture"
          title="Fixture + counter-matchup favourability, excluding form">
        <span class="score-chip score-chip--${esc(nfBand)}${nfEstClass}">${Math.round(nfScore.value)}</span>
        ${nfRank ? `<span class="ranker-rank-tag">#${nfRank}</span>` : ''}
      </td>
      <td class="ranker-table__td ranker-table__td--fixtures">
        ${buildFixtureStrip(score.perGw, pendingFixturesForTeam(player.teamId, pendingCtx))}
      </td>
      <td class="ranker-table__td ranker-table__td--min">
        <span class="ranker-min-badge ranker-min-badge--${esc(pt.band)}${pt.estimated ? ' ranker-min-badge--estimated' : ''}"
              title="${esc(playtimeTitle(pt))}">${esc(pt.label)}</span>
      </td>
    </tr>
  `.trim();
}

// ─── Price change helpers ─────────────────────────────────────────────────────

/**
 * Fixed column count: Player, Team, Pos, Price, £ ↑/↓, Cost/Pt, Avg Pts,
 * Total Pts, Form, Tsfr In, Tsfr Out, Value, Next Fixture, Fixtures,
 * Playtime — always all 15, no toggle.
 *
 * Anything that spans the whole table (the empty/loading rows here, the
 * fallback colspan in index.html) must agree with this number.
 */
function colCount() {
  return 15;
}

/**
 * Build the season price-change <td> for one player row.
 * ↑ (green) = risen since the season opened, ↓ (red) = fallen, no arrow
 * (muted) = unmoved. This is banked FACT, not the transfer-flow forecast that
 * calcPriceChangeRisk produces — that prediction column was removed from the
 * Ranker; the Transfer Planner still carries it.
 * @param {Player} player
 * @returns {string} HTML <td> string
 */
function buildPriceChangeCell(player) {
  const change = calcSeasonPriceChange(player);

  // Flat is a real reading, not missing data — it shows "£0.0m" in the muted
  // style rather than a dash, so an unmoved player is visibly distinct from
  // one whose data failed to load.
  if (change.direction === 'flat') {
    return `<td class="ranker-table__td ranker-table__td--price-change">
      <span class="ranker-price-change ranker-price-change--stable" title="Unchanged since the start of the season">${esc(change.label)}</span>
    </td>`.trim();
  }
  const isRise = change.direction === 'rise';
  const arrow  = isRise ? '↑' : '↓';
  const mod    = isRise ? 'rise' : 'fall';
  const title  = `${isRise ? 'Risen' : 'Fallen'} ${esc(change.label)} since the start of the season`;
  return `<td class="ranker-table__td ranker-table__td--price-change">
    <span class="ranker-price-change ranker-price-change--${mod}" title="${title}">${arrow} ${esc(change.label)}</span>
  </td>`.trim();
}

/**
 * Thousands-separated integer for the transfer columns — 45231 → "45,231".
 * Deliberately NOT the "45.2k" shortening engine/prices.js uses in its
 * reasoning strings: this column is read as a magnitude to compare across
 * rows, and the full figure sorts visually as well as it sorts numerically.
 * @param {number} n
 * @returns {string}
 */
function fmtCount(n) {
  return Number(n ?? 0).toLocaleString('en-GB');
}

// ─── Render ───────────────────────────────────────────────────────────────────

/** (Re-)render the <thead> row, including the active sort-column indicator. */
function renderThead() {
  const horizonKey = store.getActiveHorizon();
  const horizon    = HORIZONS[horizonKey] ?? HORIZONS.GW1;

  // Stamps the active horizon onto the table element. Nothing in components.css
  // keys off it any more — the horizon is fixed at GW5 since the switcher was
  // removed, so the per-horizon width overrides were folded into the base
  // rules. Kept because it costs nothing and is the hook a restored switcher
  // would need back.
  if (_table) _table.dataset.horizon = horizonKey;

  function thSortable(label, col) {
    const active = _sortBy === col;
    const icon   = active
      ? ` <span class="sort-icon" aria-hidden="true">${_sortDesc ? '↓' : '↑'}</span>`
      : '';
    return `<th class="ranker-table__th ranker-table__th--sortable${active ? ' is-sorted' : ''}" data-sort="${esc(col)}">${esc(label)}${icon}</th>`;
  }
  function thStatic(label, col) {
    return `<th class="ranker-table__th" data-col="${esc(col)}">${esc(label)}</th>`;
  }

  // Cost/Pt and Avg Pts/GW both switch source with the toggle (FEATURE_ENGINE.md
  // §10.1) — labelling them here means the meaning is clear even scrolled away
  // from the toggle button itself.
  const seasonSuffix = _avgPtsMode === 'lastSeason' ? ' (last season)' : '';

  _thead.innerHTML = `
    <tr>
      ${thSortable('Player',    'name')}
      ${thSortable('Team',      'team')}
      ${thStatic('Pos',         'pos')}
      ${thSortable('Price',     'price')}
      ${thSortable('£ ↑/↓',     'priceChange')}
      ${thSortable(`Cost/Pt${seasonSuffix}`,    'costPerPoint')}
      ${thSortable(`Avg Pts/GW${seasonSuffix}`, 'avgPointsPerGw')}
      ${thSortable('Total Pts', 'totalPoints')}
      ${thSortable('Form',      'fplForm')}
      ${thSortable('Tsfr In',   'transfersInEvent')}
      ${thSortable('Tsfr Out',  'transfersOutEvent')}
      ${thSortable('Value',     'value')}
      ${thSortable('Next Fixture', 'nextFixtureScore')}
      ${thStatic(horizon.label, 'fixtures')}
      ${thSortable('Playtime',  'playtime')}
    </tr>
  `;
}

/**
 * Full table render: rebuilds thead (sort indicators) and tbody (filtered,
 * sorted rows). Engine results in `_rows` are not recomputed; this only
 * re-applies filter, sort, and display-mode state.
 */
function renderTable() {
  renderThead();

  if (_rows.length === 0) {
    // Two different empty states wearing the same shape. "No player data" is a
    // verdict; an unsettled prefetch is a wait, and saying the former during
    // the latter tells the reader the data failed when it is simply late.
    // Reached through the filter/sort handlers, which re-render off the cached
    // _rows without going back through rebuildRowsChunked.
    if (!store.isTeamXgSettled()) {
      _tbody.innerHTML = buildSkeletonRows();
      _tbody.setAttribute('aria-busy', 'true');
      return;
    }
    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">No player data loaded.</td></tr>`;
    return;
  }

  const filtered = applyFilters(_rows);

  if (filtered.length === 0) {
    _tbody.innerHTML = `<tr><td class="ranker-table__empty" colspan="${colCount()}">No players match the current filters.</td></tr>`;
    return;
  }

  // Ranked among the filtered set, independent of the active sort column.
  const nextFixtureRankById = buildNextFixtureRanks(filtered);

  // Only built in 'lastSeason' mode. buildCtx() is safe to call unconditionally
  // here — _rows is only ever populated after rebuildRowsChunked has already
  // built (and required a non-null) ctx once, so the season is guaranteed loaded.
  //
  // Built over _rows, not `filtered`: the rank tiers below are computed from it,
  // and they follow the same full-pool rule as the Value column — "best forward
  // for Cost/Pt" has to mean the same thing whichever filter pills are active.
  const lastSeasonByPlayerId = _avgPtsMode === 'lastSeason'
    ? buildLastSeasonLookup(_rows, buildCtx())
    : null;

  // Avg Pts/GW and Cost/Pt each get their OWN per-position ranking, on their
  // own number — not the Value column's tier repeated across the row, which
  // would colour a Cost/Pt cell by something that is not Cost/Pt.
  //
  // Both read whichever season the toggle is showing, so the colours always
  // describe the figures actually on screen. Recomputed per render rather than
  // cached because the inputs move underneath them: last-season averages land
  // row by row as the bulk load streams in.
  const metricRanks = {
    avg: rankTierMapBy(_rows, ({ player, score }) => (lastSeasonByPlayerId
      ? lastSeasonByPlayerId.get(player.id)?.avg ?? null
      : score.avgPointsPerGw.value)),
    // Ascending: Cost/Pt is £ per point, so the CHEAPEST points in the game are
    // the top of this column.
    cost: rankTierMapBy(_rows, ({ player, score }) => (lastSeasonByPlayerId
      ? lastSeasonByPlayerId.get(player.id)?.cost ?? null
      : score.costPerPoint), { ascending: true }),
  };

  const sorted = applySort(filtered, lastSeasonByPlayerId);

  // Read once per render, not once per row — the pending-fixture index is the
  // same for all ~700 rows.
  const pendingCtx = store.getSeason();

  _tbody.innerHTML = sorted
    .map(row => buildRow(row, nextFixtureRankById, lastSeasonByPlayerId, pendingCtx, metricRanks))
    .join('');
  _tbody.removeAttribute('aria-busy');
}

// ─── Lazy loading ─────────────────────────────────────────────────────────────

/**
 * Ensure a player summary is in the store, fetching lazily if needed.
 * Only api.js calls fetch() (ARCHITECTURE.md §3 rule 1); this module
 * calls the exported fetchPlayerSummary function and caches the result.
 * Deduplicates concurrent requests via `_pendingLoads`.
 *
 * @param {number} playerId
 */
async function ensurePlayerSummary(playerId) {
  if (store.getPlayerSummary(playerId)) return;
  if (!_pendingLoads.has(playerId)) {
    const p = (async () => {
      const raw     = await fetchPlayerSummary(playerId);
      const summary = normalisePlayerSummary(raw);
      store.setPlayerSummary(playerId, summary);
    })();
    _pendingLoads.set(playerId, p);
  }
  try {
    await _pendingLoads.get(playerId);
  } finally {
    _pendingLoads.delete(playerId);
  }
}

/**
 * Fetch every player's element-summary in chunks of SUMMARY_FETCH_CHUNK_SIZE,
 * yielding between chunks — mirrors rebuildRowsChunked's chunk/yield pattern,
 * reusing the same `ensurePlayerSummary` lazy-loader the row-click path uses
 * (so a player already loaded via a click is not re-fetched). Re-renders after
 * every chunk so rows fill in progressively instead of all at once at the end.
 *
 * This IS an explicit bulk fetch of all ~700 players — but triggered only by
 * the user clicking "Last Season" on the Avg Pts/GW toggle, not automatically
 * on load, which is what ARCHITECTURE.md's no-bulk-fetch rule actually
 * targets. See FEATURE_ENGINE.md §10.1.
 *
 * Guarded by _summaryLoadRunId: if the user switches back to 'current' (or
 * re-triggers 'lastSeason') mid-load, the stale run's captured id no longer
 * matches _summaryLoadRunId and the loop quietly stops after its current chunk.
 */
async function loadAllSummariesChunked() {
  const runId   = ++_summaryLoadRunId;
  const players = store.getPlayers();

  for (let i = 0; i < players.length; i += SUMMARY_FETCH_CHUNK_SIZE) {
    if (runId !== _summaryLoadRunId) return;

    const chunk = players.slice(i, i + SUMMARY_FETCH_CHUNK_SIZE);
    await Promise.all(chunk.map(p =>
      ensurePlayerSummary(p.id).catch(err => {
        console.warn('[ranker] summary fetch failed:', p.id, err.message ?? err);
      })
    ));

    if (runId !== _summaryLoadRunId) return;
    renderTable();

    // Yield so the browser can paint the progressive render and process input.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * Handle a player row click. Shows loading state on the row while the
 * element-summary is fetched (first click only — subsequent clicks use the
 * cached summary). On completion emits player:selected so the Matchup
 * Analyser pre-selects the player's next fixture, then navigates there.
 */
async function onPlayerClick(playerId) {
  const player = store.getPlayer(playerId);
  if (!player) return;

  // Mark the clicked row as loading — visible feedback without changing the
  // global banner (which says "Computing rankings…" and would be misleading here).
  const tr = _tbody.querySelector(`[data-player-id="${playerId}"]`);
  if (tr) tr.classList.add('is-loading');

  try {
    await ensurePlayerSummary(playerId);
  } catch (err) {
    // Non-fatal: navigate anyway; matchup will render with estimated scores.
    console.warn('[ranker] player summary fetch failed:', err.message ?? err);
  } finally {
    if (tr) tr.classList.remove('is-loading');
  }

  const nextFixture = getNextFixtureForTeam(player.teamId);
  if (nextFixture) {
    store.emit('player:selected', { fixtureId: nextFixture.id });
  }
  window.location.hash = 'matchup';
}

/**
 * Toggle handler for the "Avg Pts/GW source" button (FEATURE_ENGINE.md §10.1).
 * Switching to 'lastSeason' re-renders immediately (showing the loading
 * placeholder for every row) then kicks off the chunked bulk load. Switching
 * back to 'current' just bumps _summaryLoadRunId to cancel any in-flight load
 * and re-renders — no fetch needed, current-season data is already in `_rows`.
 */
function onAvgPtsToggleClick() {
  if (_avgPtsMode === 'current') {
    _avgPtsMode = 'lastSeason';
    _avgPtsToggle.classList.add('is-active');
    _avgPtsToggle.textContent = 'Last Season';
    _avgPtsToggle.setAttribute('aria-pressed', 'true');
    renderTable();
    loadAllSummariesChunked();
  } else {
    _avgPtsMode = 'current';
    _summaryLoadRunId++;
    _avgPtsToggle.classList.remove('is-active');
    _avgPtsToggle.textContent = 'This Season';
    _avgPtsToggle.setAttribute('aria-pressed', 'false');
    renderTable();
  }
}

/**
 * Set when data changed while the Ranker was off screen, so activation knows
 * it owes a rebuild. See onRouteChanged.
 */
let _pendingRebuild = false;

function onDataReady() {
  // Cheap enough to keep eager, and it leaves the filter correct for whenever
  // the tab is next opened.
  populateTeamFilter();

  // Ranking the full pool is by far the most expensive thing this module does
  // (~920ms for 604 players, measured). data:ready fires once per team-xG
  // payload at boot, so doing this off screen burned seconds ranking a table
  // nobody was looking at. Defer to activation — store.js's activeModule note
  // has the full measurement.
  if (store.getActiveModule() !== 'ranker') {
    _pendingRebuild = true;
    return;
  }
  _pendingRebuild = false;
  rebuildRowsChunked();
}

/** Flush a rebuild deferred while off screen, once the Ranker is shown. */
function onRouteChanged(module) {
  if (module !== 'ranker' || !_pendingRebuild) return;
  _pendingRebuild = false;
  rebuildRowsChunked();
}

function onHorizonChanged() {
  if (!store.isFresh()) return;
  rebuildRowsChunked();
}

/** Fill the team <select> with all teams sorted alphabetically. */
function populateTeamFilter() {
  if (!_teamSelect) return;
  const current = _teamSelect.value;
  const teams   = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
  _teamSelect.innerHTML =
    '<option value="all">All teams</option>' +
    teams.map(t =>
      `<option value="${t.id}"${String(t.id) === current ? ' selected' : ''}>${esc(t.name)}</option>`
    ).join('');
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the Player Ranker module. Called once from main.js on bootstrap.
 * Caches DOM refs, wires all control event listeners, registers store
 * subscriptions, and triggers an immediate render if the store is already
 * hydrated from sessionStorage.
 */
export function initRanker() {
  const root          = document.querySelector('[data-module="ranker"]');
  _table              = root.querySelector('.ranker-table');
  _thead              = root.querySelector('#ranker-thead');
  _tbody              = root.querySelector('#ranker-tbody');
  _loading            = root.querySelector('#ranker-loading');
  _teamSelect         = root.querySelector('#ranker-team');
  _priceSelect        = root.querySelector('#ranker-price');
  _avgPtsToggle       = root.querySelector('#ranker-avgpts-toggle');

  populatePriceFilter();

  // ── Position filter toggle buttons ──────────────────────────────────────
  // Start deselected (see _activePosSet's declaration) — a click just
  // toggles membership, freely down to zero, since zero means "unfiltered"
  // rather than "nothing matches".
  root.querySelectorAll('.ranker-pos-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      if (_activePosSet.has(pos)) {
        _activePosSet.delete(pos);
        btn.classList.remove('is-active');
      } else {
        _activePosSet.add(pos);
        btn.classList.add('is-active');
      }
      renderTable();
    });
  });

  // ── Minutes-security filter toggle buttons (mirrors position buttons) ───
  root.querySelectorAll('.ranker-minsec-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = btn.dataset.minsec;
      if (_activeMinSecSet.has(lvl)) {
        _activeMinSecSet.delete(lvl);
        btn.classList.remove('is-active');
      } else {
        _activeMinSecSet.add(lvl);
        btn.classList.add('is-active');
      }
      renderTable();
    });
  });

  // ── Price and team filters ───────────────────────────────────────────────
  _priceSelect?.addEventListener('change', () => {
    _activePriceBand = _priceSelect.value;
    renderTable();
  });

  _teamSelect?.addEventListener('change', () => {
    _activeTeamId = _teamSelect.value;
    renderTable();
  });

  _avgPtsToggle?.addEventListener('click', onAvgPtsToggleClick);

  // ── Header sort — event delegation on <thead> ────────────────────────────
  _thead.addEventListener('click', e => {
    const th = e.target.closest('[data-sort]');
    if (!th) return;
    const col = th.dataset.sort;
    if (_sortBy === col) {
      _sortDesc = !_sortDesc;
    } else {
      _sortBy   = col;
      _sortDesc = true;
    }
    renderTable();
  });

  // ── Row click — event delegation on <tbody> ──────────────────────────────
  _tbody.addEventListener('click', e => {
    const tr = e.target.closest('[data-player-id]');
    if (tr && !tr.classList.contains('is-loading')) {
      onPlayerClick(Number(tr.dataset.playerId));
    }
  });

  store.subscribe('data:ready',      onDataReady);
  store.subscribe('horizon:changed', onHorizonChanged);
  store.subscribe('route:changed',   onRouteChanged);

  // If the store already has data (hydrated from sessionStorage, or data:ready
  // fired before this module registered its subscription), render right now
  // rather than waiting for an event that won't fire again. Routed through
  // onDataReady so the off-screen guard applies here too — on a cold load of
  // any other tab this now marks the rebuild pending instead of running it.
  if (store.isFresh()) onDataReady();
}
