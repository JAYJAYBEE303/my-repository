/**
 * js/main.js
 * Layer: entry point. Bootstrap only — kicks off the initial data load,
 * subscribes to store events, reads URL hash to pick the active view,
 * wires the nav, and delegates all rendering to modules.
 * Contains no analytical logic and no per-module rendering.
 * See ARCHITECTURE.md §4 for the module loading strategy.
 */

import {
  HORIZONS, WEIGHTS,
  PROJ_FORM, PROJ_FIXTURE, PROJ_COUNTER, PROJ_MINUTES,
} from './config.js';
import { store } from './store.js';
import {
  UNDERSTAT_SEASON, UNDERSTAT_PREV_SEASON, UNDERSTAT_HISTORY_SEASONS,
  TEAM_XG_COALESCE_MS,
  TEAM_XG_SETTLE_TIMEOUT_MS,
} from './config.js';
import {
  fetchBootstrap, fetchFixtures, fetchPlayerSummary,
  fetchLeagueXg, fetchTeamXg, ApiError,
} from './api.js';
import { normaliseSeason, normalisePlayerSummary } from './engine/normalise.js';
import { buildScoreContext, scoreFixture, scoreOverHorizon, scorePlayer, rankPlayers } from './engine/composite.js';
import { calcBaseDifficulty, calcHomeAwaySplit, calcVenueEffect, calcFixtureHistory } from './engine/fixtures.js';
import { calcTeamForm, calcPlayerForm, calcPlayingLikelihood } from './engine/form.js';
import { calcStyleProfile, calcStyleClash } from './engine/style.js';
import { buildUnderstatSlugsByTeamId } from './engine/channel.js';
import { pickStartingXI, calcXiExpectedPoints } from './engine/lineup.js';
import { enumerateSwaps, calcSquadFlexibility } from './engine/transfers.js';
import { buildVerdict } from './engine/strategy.js';
import {
  calcCounterMatchup, calcIndividualDuels, duelsForPairing,
} from './engine/counter.js';

import { initLanding }      from './modules/landing.js';
import { initMatchup }      from './modules/matchup.js';
import { initFullSeason }   from './modules/fullSeason.js';
import { initFixtures }     from './modules/fixtures.js';
import { initRanker }       from './modules/ranker.js';
import { initDashboard }    from './modules/dashboard.js';
import { initPlanner }      from './modules/planner.js';
import { initScheduleBar }  from './modules/scheduleBar.js';
import { initCalibration }  from './calibration.js';

// ─── Data loading ─────────────────────────────────────────────────────────────

// Slugs whose team-xG fetch has already been started this session, so a
// re-render mid-flight can't fire a duplicate request.
const _teamXgRequested = new Set();

// Deadline handle for the prefetch as a whole (armTeamXgDeadline, below);
// null when none is armed. Declared beside the Set it is cleared alongside,
// since resetTeamXgPrefetch has to clear both together or the next prefetch
// inherits the previous one's deadline.
let _teamXgTimeoutHandle = null;

// Bumped by resetTeamXgPrefetch, and captured by each in-flight request.
//
// A manual refresh clears the cache and re-dispatches the same slugs, so the
// PREVIOUS run's requests are still outstanding against a pending set that has
// since been rebuilt. Without this, one of those stragglers settling would
// remove a slug the NEW run is still waiting on, and the app would report
// scores as final while a fresher payload was still inbound — the precise
// thing the pending set exists to prevent. A stale request still stores its
// payload (it is real data, just from the previous run); it simply no longer
// gets to say the wait is over.
let _teamXgRunId = 0;

/**
 * Forget which team-xG fetches have been started, so the next
 * prefetchAllTeamXg() re-requests all of them.
 *
 * MUST be called alongside store.clearCache(). clearCache() wipes
 * state.teamXg, but this Set lives in this module and used to survive it — so
 * after a refresh every slug was skipped as "already requested" while the data
 * it guarded was gone. The result was silent: no error, no warning, the whole
 * app just dropped to the role tier for the rest of the session because the
 * channel tier had no payloads left to build from.
 *
 * The Set guards against duplicate IN-FLIGHT requests, so its lifetime has to
 * match the cache's rather than the page's.
 */
function resetTeamXgPrefetch() {
  _teamXgRequested.clear();
  _teamXgRunId += 1;
  if (_teamXgTimeoutHandle !== null) {
    clearTimeout(_teamXgTimeoutHandle);
    _teamXgTimeoutHandle = null;
  }
}

/**
 * Fetches bootstrap + fixtures in parallel, normalises into the internal
 * model, and pushes into the store. Emits data:ready on success or
 * data:error on failure.
 *
 * If the store already holds a season (hydrated from sessionStorage) and
 * `force` is false, we just signal ready without re-hitting the API —
 * ARCHITECTURE.md §6 treats bootstrap/fixtures as fresh for the session.
 */
async function loadInitialData({ force = false } = {}) {
  // Two INDEPENDENT freshness gates. store.isFresh() reflects sessionStorage-
  // backed `season` (ARCHITECTURE.md §6 — bootstrap/fixtures are the only
  // payloads mirrored to sessionStorage), but leagueXg/leagueXgPrev/Prev2/Prev3
  // are memory-only and reset to null on every module load (i.e. every page
  // reload), independently of whether `season` just rehydrated from cache.
  // Gating the Understat fetches on seasonFresh too (as this used to) meant a
  // reload within the same tab session — season rehydrates, so isFresh() is
  // true — skipped the Understat fetches forever, silently and permanently
  // stranding H2H History / Style Clash / venue split on their neutral
  // fallback for the rest of that session even though the proxy was healthy.
  // See git history for the bug report this fixes.
  const seasonFresh = !force && store.isFresh();
  const xgFresh      = !force && store.getLeagueXg() !== null;

  if (seasonFresh && xgFresh) {
    // ORDER MATTERS. The prefetch must be DISPATCHED before ready is announced,
    // not after. Modules skeleton any score whose Understat payloads are still
    // outstanding, and "outstanding" is only distinguishable from "never asked
    // for" once the prefetch has registered what it is waiting on (see
    // store.markTeamXgRequested). Announcing first means every module renders
    // against a store that reports nothing pending — and in the case where
    // there is genuinely nothing to fetch, no later emit ever arrives to
    // correct it, leaving skeletons on screen for the rest of the session.
    // Dispatching first costs nothing: it starts network calls and returns.
    //
    // Fire-and-forget; every module upgrades to the channel tier in place as
    // each team's statistics land. Not gated on any tab being open.
    prefetchAllTeamXg();
    store.markDataReady();
    return;
  }

  try {
    // Phase 3A: league-wide xG is one HTTP call and enriches the whole model,
    // so it loads alongside bootstrap/fixtures rather than lazily. Wrapped in
    // Promise.allSettled so an Understat outage doesn't break the FPL pipeline
    // — engine functions degrade to Phase 1 proxies when leagueXg is null.
    // Phase 3B: also fetches LAST season's leagueXg — purely so
    // calcHomeAwaySplit's rolling 38-game window has real matches before this
    // season has enough of its own (see VENUE_ROLLING_GAMES, config.js).
    // Phase 4: fetches UNDERSTAT_HISTORY_SEASONS further back again, purely to
    // deepen the head-to-head record (engine/h2h.js, and through its shared
    // collector calcFixtureHistory's cross-season window).
    // Each season gets its own allSettled slot: an outage on any one must not
    // block the others. Each slot is skipped (resolved with null, unused
    // below) when its own freshness flag says it's already loaded.
    const settled = await Promise.allSettled([
      seasonFresh ? Promise.resolve(null) : fetchBootstrap(),
      seasonFresh ? Promise.resolve(null) : fetchFixtures(),
      xgFresh ? Promise.resolve(null) : fetchLeagueXg(UNDERSTAT_SEASON),
      xgFresh ? Promise.resolve(null) : fetchLeagueXg(UNDERSTAT_PREV_SEASON),
      ...UNDERSTAT_HISTORY_SEASONS.map(
        season => (xgFresh ? Promise.resolve(null) : fetchLeagueXg(season))),
    ]);

    // The first four slots are fixed; everything after them is one history
    // season each, in UNDERSTAT_HISTORY_SEASONS order.
    const [bootstrapRes, fixturesRes, leagueXgRes, leagueXgPrevRes] = settled;
    const historyResults = settled.slice(4);

    if (!seasonFresh) {
      if (bootstrapRes.status !== 'fulfilled') throw bootstrapRes.reason;
      if (fixturesRes.status  !== 'fulfilled') throw fixturesRes.reason;

      const season = normaliseSeason(bootstrapRes.value, fixturesRes.value);
      store.setSeason(season);
    }

    if (xgFresh) {
      // Already loaded this JS lifetime — leave store.leagueXg* untouched.
    } else if (leagueXgRes.status === 'fulfilled') {
      store.setLeagueXg(leagueXgRes.value);
    } else {
      // MODEL: Understat is supplementary — log and continue with FPL-only data.
      // style.js + form.js fall back to Phase 1 proxies and flag estimated:true
      // on the breakdown. A failed Understat fetch must never block the main load.
      // ROADMAP.md §3A — this path is intentionally non-fatal; no store.setError().
      console.warn('[Gaffer IQ] Understat league xG unavailable — falling back to FPL proxies.',
        leagueXgRes.reason?.message ?? leagueXgRes.reason);
    }

    if (xgFresh) {
      // Already loaded this JS lifetime — leave store.leagueXgPrev untouched.
    } else if (leagueXgPrevRes.status === 'fulfilled') {
      store.setLeagueXgPrev(leagueXgPrevRes.value);
    } else {
      // Same non-fatal treatment — calcHomeAwaySplit falls back to
      // current-season-only (ctx.playedFixtures) when this is unavailable.
      console.warn('[Gaffer IQ] Understat previous-season xG unavailable — venue split uses this season only.',
        leagueXgPrevRes.reason?.message ?? leagueXgPrevRes.reason);
    }

    if (xgFresh) {
      // Already loaded this JS lifetime — leave store.leagueXgHistory untouched.
    } else {
      // Same non-fatal treatment as the two above: a season that fails is left
      // OUT of the list rather than stored as a hole, so the head-to-head record
      // is simply one season shorter instead of breaking.
      const loaded = [];
      historyResults.forEach((res, i) => {
        if (res.status === 'fulfilled') loaded.push(res.value);
        else console.warn(
          `[Gaffer IQ] Understat ${UNDERSTAT_HISTORY_SEASONS[i]} xG unavailable — the head-to-head record is one season shorter.`,
          res.reason?.message ?? res.reason);
      });
      store.setLeagueXgHistory(loaded);
    }

    // Prefetch first, then announce — see the note on the early-return path
    // above. Same reason, same ordering requirement.
    prefetchAllTeamXg();
    store.markDataReady();
  } catch (err) {
    // store.setError() clears season state before emitting — the store is left
    // cleanly empty, not partially populated (CONVENTIONS.md §9, store.js §setError).
    const apiErr = err instanceof ApiError ? err : new ApiError(String(err?.message ?? err));
    store.setError(apiErr);
  }
}

/**
 * Fetch Understat team statistics for every team in the league once, at
 * startup, so every module scores every team on the same counter-matchup
 * tier from the first render.
 *
 * MODEL: replaces a per-fixture lazy fetch. That version cached a team's
 * statistics only once its fixture was opened in Matchup, then let every
 * other module pick up the same cached entry — which meant the SAME team
 * could score differently for two users, or in two tabs of the same
 * session, purely from click order rather than any real data change. 20
 * proxy calls at boot is the same order of magnitude as the existing
 * leagueXg fetch, so fetching every team eagerly costs little and removes
 * the inconsistency outright rather than flagging it in the UI. See design
 * spec §8 (revised 2026-08-21).
 *
 * Fire-and-forget: the app renders immediately on whatever tier the data
 * supports and upgrades in place as each team's payload lands. Failures are
 * swallowed to a console warning, never store.setError() — the channel tier
 * is an ENRICHMENT, so a dead Understat upstream must not surface as a page
 * error. Same policy as the league-xG fetch (see js/api.js, ROADMAP §3A).
 *
 * Re-render on arrival goes through store.markDataReady(): this codebase has
 * no per-tab render dispatcher — every module re-renders off the 'data:ready'
 * event it already subscribes to (matchup/dashboard/planner/ranker), and
 * markDataReady() is a bare emit with no other side effects, so re-firing it
 * is the existing and only post-boot re-render path.
 */
// Pending coalesce timer for team-xG arrivals; null when none is scheduled.
let _dataReadyHandle = null;

/**
 * Batch the re-render that follows a team-xG payload landing.
 *
 * WHY: markDataReady() is a global broadcast — every module re-renders on it.
 * Firing it once per payload meant 20 full application-wide rescores at boot
 * on top of the initial one. Measured on the live dataset: ~2.4s of blocking
 * main-thread work per emit, ~50s in total, which is the startup lag this
 * fixes. The fetches themselves were never the problem; they are parallel and
 * cost nothing on the main thread.
 *
 * FIXED WINDOW, not a resetting debounce. The first arrival schedules a flush
 * at +TEAM_XG_COALESCE_MS and later arrivals join that same flush rather than
 * pushing it back. A resetting debounce would let a steady trickle of payloads
 * postpone the upgrade indefinitely; this bounds the wait at one window no
 * matter how the arrivals are spaced, so the burst collapses to a couple of
 * emits and the UI still upgrades promptly.
 *
 * Payloads that land after a flush simply schedule the next one, so nothing is
 * dropped — the store is already updated before this is called, and the emit
 * only tells modules to re-read it.
 */
function scheduleDataReady() {
  if (_dataReadyHandle !== null) return;
  _dataReadyHandle = setTimeout(() => {
    _dataReadyHandle = null;
    store.markDataReady();
  }, TEAM_XG_COALESCE_MS);
}

/**
 * Arm the TEAM_XG_SETTLE_TIMEOUT_MS backstop, once per prefetch.
 *
 * `fetch` carries no timeout, so a request the proxy never answers stays
 * pending for the life of the page — and with it every skeleton waiting on
 * that team's score. At the deadline the store stops waiting and the affected
 * scores render on whatever tier the data supports, which is exactly the
 * behaviour that predates the skeletons. Nothing is cancelled or discarded: a
 * late payload still lands in the store and still upgrades scores in place.
 */
function armTeamXgDeadline() {
  if (_teamXgTimeoutHandle !== null) return;
  const runId = _teamXgRunId;
  _teamXgTimeoutHandle = setTimeout(() => {
    _teamXgTimeoutHandle = null;
    // resetTeamXgPrefetch clears this timer, so a stale firing should not be
    // possible — the guard is here because "should not be possible" is exactly
    // what a force-settle must not rely on.
    if (runId !== _teamXgRunId) return;
    const stranded = store.settleAllTeamXg();
    if (stranded === 0) return;
    console.warn(`[Gaffer IQ] ${stranded} team-xG request(s) did not answer within `
      + `${TEAM_XG_SETTLE_TIMEOUT_MS}ms — scoring on the data in hand.`);
    // Views that were skeletoned need a render to replace those skeletons with
    // the scores they can compute now; nothing else has changed in the store,
    // so this goes through the same coalesced path every other arrival uses.
    scheduleDataReady();
  }, TEAM_XG_SETTLE_TIMEOUT_MS);
}

function prefetchAllTeamXg() {
  const season = store.getSeason();
  if (!season) return;

  const slugs = buildUnderstatSlugsByTeamId(store.getLeagueXg(), season.teamsById);
  const dispatched = [];
  for (const slug of new Set(Object.values(slugs))) {
    if (_teamXgRequested.has(slug) || store.getTeamXg(slug)) continue;
    _teamXgRequested.add(slug);
    dispatched.push(slug);
  }

  // Announced BEFORE the first fetch is started, and unconditionally — even
  // when `dispatched` is empty, which is what latches the store's dispatched
  // flag and lets every score read as settled when there was never anything
  // to wait for (no Understat league payload, so no slugs to resolve). Do this
  // after the loop rather than inside it so the pending set is never
  // momentarily one-slug-deep, which a synchronously-resolving fetch could
  // otherwise read as "prefetch complete".
  store.markTeamXgRequested(dispatched);
  if (dispatched.length > 0) armTeamXgDeadline();

  const runId = _teamXgRunId;
  for (const slug of dispatched) {
    fetchTeamXg(slug)
      .then((data) => {
        store.setTeamXg(slug, data);
      })
      .catch((err) => {
        console.warn(`[Gaffer IQ] team xG unavailable for ${slug}: ${err.message}`);
      })
      .finally(() => {
        // A straggler from a superseded run has already had its payload
        // stored above; what it must not do is close out a wait belonging to
        // the run that replaced it. See _teamXgRunId.
        if (runId !== _teamXgRunId) return;
        // Settled means ANSWERED, not succeeded: a rejected fetch is just as
        // final for "is more data coming?" as a fulfilled one, and a view
        // still skeletoning a team whose payload will never arrive is stuck.
        // Hence .finally rather than a settle inside .then only.
        store.settleTeamXg(slug);
        // Whatever tab is active upgrades in place as each payload lands —
        // but batched, not once per payload. See scheduleDataReady. Also on
        // the failure path, so the last outstanding slug failing still
        // produces the render that clears the remaining skeletons.
        scheduleDataReady();
      });
  }
}

// ─── Error banner ─────────────────────────────────────────────────────────────

const errorBanner = document.getElementById('app-error-banner');
const errorText   = document.getElementById('app-error-text');

store.subscribe('data:error', (err) => {
  // err is a full ApiError — show its message directly. The message already
  // includes the endpoint name and upstream status (e.g. "Failed to load
  // bootstrap data: Proxy 403 — FPL API rate limited"). CONVENTIONS.md §9.
  console.error('[Gaffer IQ] data:error —', err);
  if (errorText)   errorText.textContent = err.message || String(err);
  if (errorBanner) errorBanner.hidden = false;
});

// Hide the banner after a successful retry so the UI resets cleanly.
store.subscribe('data:ready', () => {
  if (errorBanner) errorBanner.hidden = true;
});

document.getElementById('app-error-retry')?.addEventListener('click', () => {
  // Re-trigger the full data fetch sequence. clearCache() first so force:true
  // starts from a clean slate, not a stale sessionStorage snapshot, and reset
  // the prefetch guard alongside it so team xG is actually re-fetched.
  store.clearCache();
  resetTeamXgPrefetch();
  loadInitialData({ force: true });
});

// Dev visibility — confirms the pipeline works.
store.subscribe('data:ready', () => {
  const teams    = store.getTeams();
  const players  = store.getPlayers();
  const fixtures = store.getFixtures();
  console.log(
    `[Gaffer IQ] data:ready — ${teams.length} teams, ${players.length} players, ${fixtures.length} fixtures.`,
    { currentGw: store.getCurrentGw(), nextGw: store.getNextGw() },
  );
});

// ─── Horizon ─────────────────────────────────────────────────────────────────
// The switcher was removed from the nav; the horizon is fixed at store's
// default (GW5). Modules still read store.getActiveHorizon(), so restoring a
// control later means re-adding markup and a listener here, nothing more.

// ─── Hash-based routing ───────────────────────────────────────────────────────

const moduleSections = document.querySelectorAll('.module-view');
const navItems       = document.querySelectorAll('.module-nav__item');

// The route a bare URL resolves to. 'landing', not 'matchup': /projects/apps/
// gaffer-iq/ is the front page a visitor arrives on, and the modules hang off
// it by hash (#matchup, #ranker, …) exactly as before. Changing this default is
// the entire routing change the landing page needed — every existing deep link
// still resolves to the module it always did.
const DEFAULT_MODULE = 'landing';

function routeToHash() {
  // Strip the leading '#'; fall back to the default if hash is absent/unknown.
  const hash   = window.location.hash.slice(1) || DEFAULT_MODULE;
  const target = document.querySelector(`[data-module="${hash}"]`) ? hash : DEFAULT_MODULE;

  moduleSections.forEach(section => {
    section.classList.toggle('is-active', section.dataset.module === target);
  });
  navItems.forEach(link => {
    const module = link.getAttribute('href')?.slice(1);
    link.classList.toggle('is-active', module === target);
  });

  // Publish the route so modules can skip rendering while off screen. Set it
  // AFTER the class toggles above: a module waking on 'route:changed' renders
  // immediately, and it must measure a section that is already visible —
  // measuring a display:none section is what produces the zero-width layout
  // artefacts this codebase has hit before.
  store.setActiveModule(target);
}

window.addEventListener('hashchange', routeToHash);

// ORDER MATTERS: this must run BEFORE the module inits below. It seeds
// store.activeModule from the URL, and each init consults that to decide
// whether to render now or defer. Called after the inits instead, every module
// would read the default ('matchup') and a deep link to any other tab would
// render the wrong one eagerly while the right one sat idle.
routeToHash();

// ─── Module initialisation ────────────────────────────────────────────────────

// Modules register their store subscriptions here, before loadInitialData() is
// called, so they are in place when data:ready fires.
initLanding();
initMatchup();
initFullSeason();
initFixtures();
initRanker();
initDashboard();
initPlanner();
// Outside .app-main: one bar shared by every view, hidden on ordinary weeks.
initScheduleBar();
initCalibration();

// ─── Lazy player-summary loader ───────────────────────────────────────────────

/**
 * Fetch a player summary on demand, cache it in the store, and return it.
 * Returns the cached summary immediately if already loaded. Never bulk-fetches.
 * See ARCHITECTURE.md §6 (lazy loading) and FEATURE_ENGINE.md §7.1.
 *
 * @param {number} playerId
 * @returns {Promise<PlayerSummary>}  normalised summary, cached in store
 */
async function loadPlayerSummary(playerId) {
  const cached = store.getPlayerSummary(playerId);
  if (cached) return cached;
  const raw     = await fetchPlayerSummary(playerId);
  const summary = normalisePlayerSummary(raw);
  store.setPlayerSummary(playerId, summary);
  return summary;
}

// ─── Dev affordances ─────────────────────────────────────────────────────────
// Expose store + engine on window for console exit-criterion verification.

window.__store    = store;
window.__horizons = HORIZONS;
window.__refresh  = () => { store.clearCache(); resetTeamXgPrefetch(); loadInitialData({ force: true }); };

window.__engine = {
  // `overrides` lets a console session build a context with any option
  // replaced — e.g. context({ teamXgBySlug: {} }) forces the role tier, which
  // is how the channel-vs-role before/after comparison is captured now that
  // the boot-time prefetch (prefetchAllTeamXg) puts every team on the channel
  // tier from first paint. Accepts a bare number for the long-standing
  // context(gw) call shape.
  context(gwOverride, overrides = {}) {
    const season = store.getSeason();
    if (!season) return null;
    const gw = typeof gwOverride === 'object' && gwOverride !== null ? undefined : gwOverride;
    const opts = typeof gwOverride === 'object' && gwOverride !== null ? gwOverride : overrides;
    return buildScoreContext(season, {
      playerSummariesById: store.getAllPlayerSummaries(),
      leagueXg: store.getLeagueXg(),
      leagueXgPrev: store.getLeagueXgPrev(),
      leagueXgHistory: store.getLeagueXgHistory(),
      teamXgBySlug: store.getAllTeamXg(),
      currentGw: gw ?? store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
      ...opts,
    });
  },
  scoreFixture,
  scoreOverHorizon,
  scorePlayer,
  rankPlayers,
  buildScoreContext,
  loadPlayerSummary,
  calcBaseDifficulty, calcHomeAwaySplit, calcVenueEffect, calcFixtureHistory,
  calcTeamForm, calcPlayerForm, calcPlayingLikelihood,
  calcStyleProfile, calcStyleClash,
  calcCounterMatchup,
  calcIndividualDuels, duelsForPairing,
  pickStartingXI,
  calcXiExpectedPoints,
  enumerateSwaps,
  calcSquadFlexibility,
  buildVerdict,
};

/**
 * Console-runnable model checks, exposed alongside window.__engine for the same
 * reason: GAFFER_IQ_TESTING_ROADMAP.md's verification steps are run by hand in
 * the browser (F12), which is the only place the engine has real data to chew on.
 *
 * Each returns a plain object and logs a readable table. Run window.__verify.all()
 * after any config.js weight change — see GAFFER_IQ_TESTING_ROADMAP.md.
 */
window.__verify = {
  /** Both weight tables must sum to exactly 1.00 (FEATURE_ENGINE.md §8.1, §10). */
  weights() {
    const EPS = 1e-9;
    const fixtureSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    const projSum    = PROJ_FORM + PROJ_FIXTURE + PROJ_COUNTER + PROJ_MINUTES;
    const rows = [
      { table: 'WEIGHTS (scoreFixture)', sum: fixtureSum, pass: Math.abs(fixtureSum - 1) < EPS },
      { table: 'PROJ_* (scorePlayer)',   sum: projSum,    pass: Math.abs(projSum - 1) < EPS },
    ];
    console.table(rows);
    const pass = rows.every(r => r.pass);
    console.log(pass ? '✅ weight sums OK' : '❌ WEIGHT SUM BROKEN — fix config.js');
    return { pass, rows };
  },

  /**
   * Playing-likelihood impact across the whole player pool: how many players
   * move, and the biggest movers. Compares the live four-term score against the
   * three-term score it would have had before PROJ_MINUTES existed.
   */
  playingLikelihood(limit = 10) {
    const ctx = window.__engine.context();
    if (!ctx) { console.warn('No data loaded yet.'); return null; }
    const horizon = HORIZONS.GW1;
    const rows = [];
    for (const p of store.getPlayers()) {
      let s;
      try { s = scorePlayer(p, horizon, ctx); } catch { continue; }
      const b = s.breakdown;
      if (!b.minutes) continue;
      // Re-normalise the three original terms to sum to 1 so the comparison is
      // like-for-like rather than just smaller because a weight was removed.
      const oldW = PROJ_FORM + PROJ_FIXTURE + PROJ_COUNTER;
      const before =
        ((PROJ_FORM * b.form.value) + (PROJ_FIXTURE * b.fixture.value)
         + (PROJ_COUNTER * b.counter.value)) / oldW;
      rows.push({
        player: p.name,
        playing: Math.round(b.minutes.value),
        before: Math.round(before * 10) / 10,
        after: Math.round(s.value * 10) / 10,
        delta: Math.round((s.value - before) * 10) / 10,
      });
    }
    rows.sort((a, b) => a.delta - b.delta);
    console.log(`Scored ${rows.length} players. Biggest DOWNGRADES (unlikely starters):`);
    console.table(rows.slice(0, limit));
    console.log('Biggest UPGRADES (nailed starters):');
    console.table(rows.slice(-limit).reverse());
    const moved = rows.filter(r => Math.abs(r.delta) >= 1).length;
    console.log(`${moved} of ${rows.length} players moved by ≥1 point.`);
    return rows;
  },

  /** Stacking penalty actually firing on real fixtures (FEATURE_ENGINE.md §8.6). */
  stacking(limit = 10) {
    const ctx = window.__engine.context();
    if (!ctx) { console.warn('No data loaded yet.'); return null; }
    const rows = [];
    for (const f of ctx.fixtures) {
      for (const teamId of [f.homeTeamId, f.awayTeamId]) {
        const team = ctx.teamsById[teamId];
        if (!team) continue;
        let s;
        try { s = scoreFixture(team, f, ctx); } catch { continue; }
        if (!s.stacking) continue;
        rows.push({
          gw: f.gw,
          team: team.shortName,
          linear: Math.round(s.stacking.linearValue * 10) / 10,
          penalty: Math.round(s.stacking.penalty * 10) / 10,
          final: Math.round(s.value * 10) / 10,
          badMetrics: s.stacking.countUnfavourable,
          band: s.band,
        });
      }
    }
    rows.sort((a, b) => b.penalty - a.penalty);
    console.log('Fixtures where secondary metrics stack up most:');
    console.table(rows.slice(0, limit));
    const firing = rows.filter(r => r.penalty > 0.5).length;
    console.log(`${firing} of ${rows.length} team-fixtures took a penalty > 0.5 pts.`);
    return rows;
  },

  /**
   * §8.7 zero-sum check: for every unplayed fixture, score both sides and
   * assert value(home) + value(away) === 100 (within floating-point epsilon).
   * Also reports the biggest genuine mismatches (by |edge|) so you can eyeball
   * that lopsided splits still happen — zero-sum is a relationship, not a
   * flattening toward 50/50.
   */
  zeroSum(limit = 10) {
    const ctx = window.__engine.context();
    if (!ctx) { console.warn('No data loaded yet.'); return null; }
    const EPS = 1e-6;
    const rows = [];
    let worst = 0;
    for (const f of ctx.fixtures) {
      const home = ctx.teamsById[f.homeTeamId];
      const away = ctx.teamsById[f.awayTeamId];
      if (!home || !away) continue;
      let h, a;
      try {
        h = scoreFixture(home, f, ctx);
        a = scoreFixture(away, f, ctx);
      } catch { continue; }
      const sum = h.value + a.value;
      const deviation = Math.abs(sum - 100);
      worst = Math.max(worst, deviation);
      rows.push({
        gw: f.gw,
        home: home.shortName, homeValue: Math.round(h.value * 10) / 10,
        away: away.shortName, awayValue: Math.round(a.value * 10) / 10,
        sum: Math.round(sum * 100) / 100,
        edge: Math.round(Math.abs(h.relative.edge) * 10) / 10,
      });
    }
    const pass = worst < EPS;
    console.log(`Checked ${rows.length} fixtures. `
      + `Worst |sum-100| observed: ${worst.toExponential(2)} `
      + `(${pass ? 'PASS — zero-sum holds' : 'FAIL — investigate'}).`);
    rows.sort((a, b) => b.edge - a.edge);
    console.log(`Biggest edges (genuine mismatches — should be lopsided, still sum to 100):`);
    console.table(rows.slice(0, limit));
    return { pass, worstDeviation: worst, rows };
  },

  /** Named players behind each counter-matchup pairing, for one fixture. */
  pairingPlayers(fixtureId) {
    const ctx = window.__engine.context();
    const f = fixtureId ? store.getFixture(fixtureId) : ctx?.fixtures?.[0];
    if (!ctx || !f) { console.warn('No fixture available.'); return null; }
    const home = ctx.teamsById[f.homeTeamId];
    const away = ctx.teamsById[f.awayTeamId];
    const duels = calcIndividualDuels(home, away, ctx);
    const pairings = scoreFixture(home, f, ctx).breakdown.counterMatchup.pairings;
    const out = {};
    for (const key of Object.keys(pairings)) {
      out[key] = duelsForPairing(duels, key)
        .map(d => `${d.attacker.name} (${d.attacker.role}) vs `
                + `${d.defender.name} (${d.defender.role}) → ${Math.round(d.duelScore)}`);
    }
    console.log(`${home.shortName} attacking pairings vs ${away.shortName}:`);
    console.log(out);
    return out;
  },

  all() {
    const w = this.weights();
    const z = this.zeroSum(5);
    this.stacking(5);
    this.playingLikelihood(5);
    this.pairingPlayers();
    return w.pass && (z?.pass ?? true);
  },
};

// ─── Kick off ─────────────────────────────────────────────────────────────────

loadInitialData();
