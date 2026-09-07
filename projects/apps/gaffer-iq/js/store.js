/**
 * js/store.js
 * Layer: state. In-memory cache mirrored to sessionStorage, app-wide pub/sub.
 * Side effects: state mutation, sessionStorage reads/writes, event emission.
 * The only mutable shared state in the app — modules communicate through
 * store events, never directly with each other.
 * See ARCHITECTURE.md §6 (caching) and CONVENTIONS.md §8 (event naming).
 */

// The ONE engine import this file makes. buildUnderstatSlugsByTeamId is a pure
// lookup builder over payloads the store already holds, and isTeamScoreSettled
// (below) needs the same team-id → Understat-slug mapping the engine uses to
// decide which payload feeds which team. Re-deriving that mapping in every
// module that wants to ask "is this team's score final yet?" is how the two
// would drift apart, so the question is answered here, once, against the same
// function the scoring path uses.
import { buildUnderstatSlugsByTeamId } from './engine/channel.js';

// Bump the version suffix when the normalised model shape changes — old
// cached payloads will then be ignored rather than feeding stale data through.
const SS_KEY_SEASON = 'gaffer-iq:season:v3';

// Shared squad key — the ONE place the user's 15-man squad is persisted.
// Reuses the Dashboard's pre-existing key so an already-saved squad survives
// this change unchanged; the Planner's old separate 'gafferiq_squad_planner'
// key is now unused and simply ages out of sessionStorage.
const SS_KEY_SQUAD = 'gafferiq_squad';

// Saved FPL pick order from the last import: which players the user actually
// has on the pitch and on the bench, plus the armband. Cleared by any manual
// squad edit — see setSquad.
const SS_KEY_PICKS = 'gafferiq_squad_picks';

const state = {
  season: null,         // see engine/normalise.js → normaliseSeason output
  playerSummaries: {},  // playerId → normalised PlayerSummary
  // Phase 3A — Understat (external xG). leagueXg is the CURRENT season's
  // league/EPL payload (teamsData/datesData/playersData) shared by every
  // engine call; teamXg is a per-team lazy cache keyed by Understat slug.
  leagueXg: null,
  // Phase 3B — last season's leagueXg payload, same shape, fetched alongside
  // the current season purely so calcHomeAwaySplit's rolling 38-game window
  // (engine/fixtures.js) has real matches to draw on before the current
  // season has enough of its own — see VENUE_ROLLING_GAMES, config.js.
  // Nothing else in the engine reads this; Style Clash/calcStyleProfile stay
  // on the current season only.
  leagueXgPrev: null,
  // Older leagueXg payloads (UNDERSTAT_HISTORY_SEASONS, config.js), fetched
  // purely to deepen the head-to-head record — engine/h2h.js and, through its
  // shared collector, calcFixtureHistory's cross-season window. Nothing else in
  // the engine reads these. An ARRAY, newest first, so adding a season to the
  // window is a config edit rather than another named slot here; entries that
  // failed to fetch are simply absent, never null.
  leagueXgHistory: [],
  teamXg: {},
  // Understat team-xG PREFETCH BOOKKEEPING (not data — see teamXg above for
  // that). Every team's payload feeds the counter-matchup metric, which is a
  // weighted component of CompositeScore, so a score computed before its
  // team's payload lands is provisional and WILL change when it does. The UI
  // skeleton-loads such scores rather than printing a number that silently
  // moves a second later, and these two fields are what it asks.
  //
  // teamXgPending holds the Understat slugs whose fetch is still outstanding;
  // main.js adds them when it dispatches the prefetch and removes each one as
  // it settles — on FAILURE as well as success, because a failed fetch is just
  // as final an answer as a successful one for "is more data still coming?".
  //
  // teamXgDispatched separates "nothing outstanding because everything has
  // landed" from "nothing outstanding because nothing has been asked for yet".
  // Without it an empty pending set at boot reads as complete, and every score
  // renders as final a beat before the prefetch even starts.
  teamXgPending: new Set(),
  teamXgDispatched: false,
  // Fixtures tab — raw `event/{gw}/live/` payloads keyed by GW. This is the
  // ONLY source of per-fixture match events (scorers, assists, cards) and of
  // who actually featured; bootstrap/fixtures carry neither. Memory-only and
  // never mirrored to sessionStorage: the endpoint is explicitly no-store
  // (see the allowlist in api/fpl.js) because a live GW changes by the minute.
  live: {},
  // Fixtures tab — Understat match detail keyed by FIXTURE id (not by Understat
  // match id, so the consumer never has to re-derive the mapping). Each entry
  // is { events, lineups }: the chronological feed and both teams' teamsheets,
  // which arrive together from the same pair of upstream calls. Memory-only,
  // like `live`: a finished match never changes, so there is nothing to gain
  // from persisting it across a session.
  matchDetail: {},
  // Planning horizon. Fixed at GW5 since the switcher was removed from the
  // nav — every module reads this, nothing writes it any more. setActiveHorizon
  // and the horizon:changed event are kept so a future control can restore the
  // behaviour without re-plumbing five modules.
  activeHorizon: 'GW5',
  // Which module is on screen ('matchup' | 'fixtures' | 'ranker' | 'dashboard'
  // | 'planner'). Written only by main.js's router, which owns the hash; read
  // by every module to skip work it would only throw away.
  //
  // WHY THIS IS STORE STATE rather than each module reading location.hash
  // itself: data:ready is a global broadcast and every module re-renders on
  // it, so at boot the 21 emits (1 + one per team-xG payload) each cost a full
  // application-wide rescore — ~2.4s, of which ~1.8s was two full-pool
  // rankPlayers runs for tabs nobody was looking at. Modules now consult this
  // and defer. Routing is app state, so it belongs here rather than being
  // re-derived from the DOM in five places.
  activeModule: 'matchup',
  // The user's squad: an ordered array of player IDs (max 15), shared by every
  // module that reads/edits it (Dashboard, Planner). Previously each module
  // kept its own private copy with its own sessionStorage key — this is now
  // the single source of truth. See CONVENTIONS.md §8.
  squad: [],
  // Array<{playerId, slot, isCaptain, isViceCaptain}> from the last import, or
  // [] when the squad was built by hand.
  squadPicks: [],
  lastError: null,
  lastRefreshAt: null,
};

// event name → array of callbacks
const subscribers = {};

// ─── Pub/sub ─────────────────────────────────────────────────────────────────

function emit(event, payload) {
  const list = subscribers[event];
  if (!list) return;
  // Iterate a snapshot so a callback may safely unsubscribe itself.
  for (const cb of list.slice()) {
    try { cb(payload); }
    catch (err) { console.error(`[store] subscriber for ${event} threw:`, err); }
  }
}

function subscribe(event, cb) {
  const list = subscribers[event] || (subscribers[event] = []);
  list.push(cb);
  return function unsubscribe() {
    const i = list.indexOf(cb);
    if (i >= 0) list.splice(i, 1);
  };
}

// ─── Getters (pure reads) ────────────────────────────────────────────────────

function getSeason()                  { return state.season; }
function getTeams()                   { return state.season?.teams ?? []; }
function getTeam(teamId)              { return state.season?.teamsById?.[teamId] ?? null; }
function getPlayers()                 { return state.season?.players ?? []; }
function getPlayer(playerId)          { return state.season?.playersById?.[playerId] ?? null; }
function getFixtures()                { return state.season?.fixtures ?? []; }
function getFixture(fixtureId)        { return state.season?.fixturesById?.[fixtureId] ?? null; }
function getPositions()               { return state.season?.positions ?? []; }
function getEvents()                  { return state.season?.events ?? []; }
function getCurrentGw()               { return state.season?.currentGw ?? null; }
function getNextGw()                  { return state.season?.nextGw ?? null; }
// The gameweek still to be played — see engine/normalise.js deriveUpcomingGw.
// Anything asking "which round is coming up" wants THIS, not getCurrentGw(),
// which keeps naming a round for days after its last whistle.
function getUpcomingGw()              { return state.season?.upcomingGw ?? null; }
function getPlayerSummary(playerId)   { return state.playerSummaries[playerId] ?? null; }
function getAllPlayerSummaries()       { return state.playerSummaries; }
function getLeagueXg()                { return state.leagueXg; }
function getLeagueXgPrev()            { return state.leagueXgPrev; }
function getLeagueXgHistory()         { return state.leagueXgHistory; }
function getTeamXg(teamSlug)          { return state.teamXg[teamSlug] ?? null; }
function getLive(gw)                  { return state.live[gw] ?? null; }
function getMatchDetail(fixtureId)    { return state.matchDetail[fixtureId] ?? null; }
function getAllTeamXg()               { return { ...state.teamXg }; }
function getActiveHorizon()           { return state.activeHorizon; }
function getActiveModule()            { return state.activeModule; }
function getSquad()                   { return state.squad; }
function getSquadPicks()              { return state.squadPicks; }

/**
 * The player ids the user actually has in their saved starting XI (slots 1–11).
 * @returns {number[]}  empty when no import has happened or picks were cleared
 */
function getSavedXi() {
  return state.squadPicks
    .filter(p => p && typeof p === 'object'
      && typeof p.playerId === 'number'
      && typeof p.slot === 'number' && p.slot >= 1 && p.slot <= 11)
    .sort((a, b) => a.slot - b.slot)
    .map(p => p.playerId);
}

function getError()                   { return state.lastError; }
function getLastRefreshAt()           { return state.lastRefreshAt; }
function isFresh()                    { return state.season !== null; }

// ─── Setters (mutations + persistence) ───────────────────────────────────────

function setSeason(season) {
  state.season = season;
  state.lastRefreshAt = Date.now();
  state.lastError = null;
  try {
    sessionStorage.setItem(
      SS_KEY_SEASON,
      JSON.stringify({ at: state.lastRefreshAt, data: season }),
    );
  } catch { /* quota exceeded or disabled — non-fatal */ }
}

function setPlayerSummary(playerId, summary) {
  state.playerSummaries[playerId] = summary;
}

function setLeagueXg(data) {
  state.leagueXg = data;
}

function setLeagueXgPrev(data) {
  state.leagueXgPrev = data;
}

/**
 * Replace the older-seasons payload list. Callers pass only what actually
 * loaded — a season whose fetch failed is left out rather than held as a null,
 * so consumers can spread the array without filtering.
 * @param {object[]} list  newest first
 */
function setLeagueXgHistory(list) {
  state.leagueXgHistory = Array.isArray(list) ? list.filter(Boolean) : [];
}

function setTeamXg(teamSlug, data) {
  state.teamXg[teamSlug] = data;
}

// ─── Team-xG prefetch readiness ──────────────────────────────────────────────
// Answers one question for the UI: "can this score still change on its own?"
// Consumers skeleton-load anything whose answer is yes, so a CompositeScore is
// either a settled number or visibly not a number yet — never a settled-looking
// number that quietly rewrites itself when the next payload lands.

/**
 * Record that the boot-time team-xG prefetch has been dispatched, and which
 * slugs it is waiting on.
 *
 * Additive, and safe to call repeatedly: main.js skips slugs it has already
 * requested, so a second call passes only the newly dispatched ones. The
 * dispatched flag latches true on the first call and is cleared only by
 * clearCache(), alongside the payloads it describes.
 *
 * @param {string[]} slugs  Understat slugs whose fetch has just been started.
 */
function markTeamXgRequested(slugs) {
  state.teamXgDispatched = true;
  for (const slug of slugs) state.teamXgPending.add(slug);
}

/**
 * Record that one slug's fetch has finished — fulfilled OR rejected. Both are
 * final answers to "is more data coming for this team?", which is the only
 * thing the pending set tracks; whether the payload is any good is
 * `getTeamXg`'s business, and the engine already degrades gracefully when it
 * is absent.
 *
 * Deliberately emits NOTHING. Views drop their skeletons on the next coalesced
 * data:ready, which main.js schedules from the same settle — introducing a
 * second render path here would let one arrival repaint a view twice, and
 * un-batch precisely what TEAM_XG_COALESCE_MS exists to batch. This function
 * updates the answer; markDataReady is still the only thing that asks views to
 * re-read it.
 * @param {string} teamSlug
 */
function settleTeamXg(teamSlug) {
  state.teamXgPending.delete(teamSlug);
}

/**
 * Stop waiting on every slug still outstanding.
 *
 * The failure backstop behind TEAM_XG_SETTLE_TIMEOUT_MS (config.js): `fetch`
 * has no timeout, so one hung request would otherwise strand skeletons on
 * screen for the rest of the session. This ends the WAIT only — the requests
 * are not cancelled, and a payload arriving afterwards still lands in
 * `teamXg` and still upgrades scores in place through the normal path.
 *
 * Silent, like settleTeamXg — main.js schedules the render that follows, and
 * uses the return value to skip that render when the deadline fired on a
 * prefetch that had already finished. A no-op force-settle must not cost a
 * full application-wide rescore.
 *
 * @returns {number} how many slugs were still outstanding.
 */
function settleAllTeamXg() {
  const stranded = state.teamXgPending.size;
  state.teamXgPending.clear();
  return stranded;
}

// Cached team-id → Understat-slug map, plus the leagueXg payload it was built
// from. buildUnderstatSlugsByTeamId walks the whole league payload, and
// isTeamScoreSettled is called once per rendered score chip — several hundred
// times per Ranker render — so rebuilding it per call is not viable. Keyed by
// payload IDENTITY rather than a dirty flag: leagueXg and season are each
// written exactly once per load, so a reference check is both sufficient and
// impossible to forget to invalidate.
let _slugCacheKey = null;
let _slugCacheSeason = null;
let _slugCacheValue = {};

function slugsByTeamId() {
  const leagueXg = state.leagueXg;
  const season   = state.season;
  if (leagueXg !== _slugCacheKey || season !== _slugCacheSeason) {
    _slugCacheKey = leagueXg;
    _slugCacheSeason = season;
    _slugCacheValue = season
      ? buildUnderstatSlugsByTeamId(leagueXg, season.teamsById)
      : {};
  }
  return _slugCacheValue;
}

/**
 * Is this team's contribution to a CompositeScore final, or can it still move?
 *
 * True once the team's Understat payload has settled — or once it is known
 * that no payload is coming for it at all, which is the case for any team the
 * slug mapping cannot resolve (buildUnderstatSlugsByTeamId does not always
 * map all 20 — see the Coventry note in config.js's club-name aliases). A
 * team with no slug is at its final tier already, so treating it as unsettled
 * would leave its scores skeletoned for ever.
 *
 * False before the prefetch is dispatched: at that point nothing is
 * outstanding purely because nothing has been asked for, and every score on
 * screen is about to change.
 *
 * @param {number} teamId  FPL team id
 * @returns {boolean}
 */
function isTeamScoreSettled(teamId) {
  if (!state.teamXgDispatched) return false;
  const slug = slugsByTeamId()[teamId];
  if (!slug) return true;
  return !state.teamXgPending.has(slug);
}

/**
 * Has the whole prefetch finished?
 *
 * The gate for any score that reads BEYOND the two teams in front of the
 * reader — the Ranker's full-pool ranking, the Dashboard's and Planner's
 * squad scores, the horizon aggregates. Those depend on opponents the view
 * never names, so there is no smaller set of teams to wait on.
 * @returns {boolean}
 */
function isTeamXgSettled() {
  return state.teamXgDispatched && state.teamXgPending.size === 0;
}

/**
 * Cache one gameweek's raw live payload. Emits so any open view re-renders
 * the moment it lands, the same contract as the other async enrichments.
 * @param {number} gw
 * @param {object} data  raw `event/{gw}/live/` JSON
 */
function setLive(gw, data) {
  state.live[gw] = data;
  emit('live:updated', gw);
}

/**
 * Cache one fixture's Understat match detail. Events and lineups land together,
 * so they are stored together and announced once — two emits would mean two
 * full re-renders of the same pane for one logical arrival.
 * @param {number} fixtureId
 * @param {{events: object[], lineups: object|null}} detail
 */
function setMatchDetail(fixtureId, detail) {
  state.matchDetail[fixtureId] = detail;
  emit('match:updated', fixtureId);
}

function setActiveHorizon(key) {
  if (state.activeHorizon === key) return;
  state.activeHorizon = key;
  emit('horizon:changed', key);
}

/**
 * Record which module is on screen. Called by main.js's router on every
 * hashchange and once at boot.
 *
 * Emits 'route:changed' with the new module key AFTER updating state, so a
 * subscriber that wakes on it already reads the new value from
 * getActiveModule(). Modules that deferred a render while hidden use this as
 * their cue to flush — see the _dirty pattern in each module's onDataReady.
 *
 * Fires only on an actual change, so re-selecting the current tab is free.
 */
function setActiveModule(key) {
  if (state.activeModule === key) return;
  state.activeModule = key;
  emit('route:changed', key);
}

/**
 * Replace the whole squad and persist it. The single mutation point for squad
 * state — Dashboard and Planner both call this (never touching sessionStorage
 * or a local array themselves), so a squad built or edited in either module is
 * immediately visible, correctly, in the other via 'squad:updated'.
 * @param {number[]} playerIds  ordered player IDs (position-limit validation
 *   stays with the calling module, same as before — this is a state primitive,
 *   not a rules engine).
 */
function setSquad(playerIds) {
  state.squad = Array.isArray(playerIds) ? playerIds.slice() : [];
  try {
    sessionStorage.setItem(SS_KEY_SQUAD, JSON.stringify(state.squad));
  } catch { /* quota exceeded or disabled — non-fatal */ }
  // A hand-edited squad invalidates the imported pick order — those slots
  // describe a team that no longer exists, and presenting them as current
  // would be a lie. Import calls setSquadPicks() straight after setSquad().
  state.squadPicks = [];
  try { sessionStorage.removeItem(SS_KEY_PICKS); } catch { /* non-fatal */ }
  emit('squad:updated', state.squad);
}

/**
 * Store the imported FPL pick order (slot + armband) for the current squad.
 * Called immediately after setSquad() on import — see the note in setSquad
 * about why order matters here.
 *
 * Emits its OWN 'squadPicks:updated' event rather than 'squad:updated'. The
 * squad ARRAY does not change here — only which slots/armband apply to it —
 * and every board/score a 'squad:updated' subscriber recomputes (Planner's
 * full lens-board re-enumeration, Dashboard's re-score) depends only on
 * squad MEMBERSHIP, never on pick order. Reusing 'squad:updated' would make
 * setSquad()'s own emit, immediately followed by this one on import, pay for
 * that expensive work twice for a single logical "import a squad" action.
 * Only the saved-XI diff markers (store.getSavedXi(), read by the Planner's
 * squad rail) depend on pick order, so that is the only listener this event
 * needs to reach.
 * @param {Array<{playerId: number, slot: number|null, isCaptain: boolean,
 *   isViceCaptain: boolean}>} picks
 */
function setSquadPicks(picks) {
  state.squadPicks = Array.isArray(picks) ? picks.slice() : [];
  try {
    sessionStorage.setItem(SS_KEY_PICKS, JSON.stringify(state.squadPicks));
  } catch { /* quota exceeded — non-fatal */ }
  emit('squadPicks:updated', state.squadPicks);
}

function setError(err) {
  // Clear season state before emitting — the store must never be left in a
  // half-initialised state where a stale session is still visible alongside
  // an active error. Player summaries are retained: they are lazily loaded
  // and will be re-fetched on demand after a successful reload.
  state.season = null;
  state.leagueXg = null;
  state.leagueXgPrev = null;
  state.leagueXgHistory = [];
  state.live = {};
  state.matchDetail = {};
  state.lastRefreshAt = null;
  try { sessionStorage.removeItem(SS_KEY_SEASON); } catch { /* non-fatal */ }
  state.lastError = err;
  emit('data:error', err);
}

function markDataReady() {
  emit('data:ready');
}

function clearCache() {
  state.season = null;
  state.playerSummaries = {};
  state.leagueXg = null;
  state.leagueXgPrev = null;
  state.leagueXgHistory = [];
  state.teamXg = {};
  // Must reset alongside the payloads they describe: a stale dispatched flag
  // with an empty pending set would report every score as settled through the
  // whole of the next prefetch, which is exactly the window the skeletons
  // exist to cover.
  state.teamXgPending = new Set();
  state.teamXgDispatched = false;
  state.live = {};
  state.matchDetail = {};
  state.lastRefreshAt = null;
  state.lastError = null;
  try { sessionStorage.removeItem(SS_KEY_SEASON); } catch { /* non-fatal */ }
}

// ─── Hydration ────────────────────────────────────────────────────────────────
// On module load, restore the season from sessionStorage if present so a
// reload within the same tab skips the network round-trip. The decision to
// re-fetch vs use the cache is made by main.js using isFresh().
(function hydrate() {
  try {
    const raw = sessionStorage.getItem(SS_KEY_SEASON);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data) {
        state.season = parsed.data;
        state.lastRefreshAt = parsed.at ?? null;
      }
    }
  } catch { /* corrupt or absent — ignore and re-fetch */ }

  // Squad hydrates independently of season freshness — it's the user's own
  // list, not derived from the fetched data, so it survives a reload even
  // when the season cache above is stale/absent.
  try {
    const rawSquad = sessionStorage.getItem(SS_KEY_SQUAD);
    if (rawSquad) {
      const parsedSquad = JSON.parse(rawSquad);
      if (Array.isArray(parsedSquad)) {
        state.squad = parsedSquad.filter(id => typeof id === 'number');
      }
    }
  } catch { /* corrupt or absent — ignore and start fresh */ }

  try {
    const rawPicks = sessionStorage.getItem(SS_KEY_PICKS);
    if (rawPicks) {
      const parsed = JSON.parse(rawPicks);
      if (Array.isArray(parsed)) state.squadPicks = parsed;
    }
  } catch { /* corrupt — start with no saved picks */ }
})();

export const store = {
  subscribe, emit,
  getSeason, getTeams, getTeam, getPlayers, getPlayer,
  getFixtures, getFixture, getPositions, getEvents,
  getCurrentGw, getNextGw, getUpcomingGw, getPlayerSummary, getAllPlayerSummaries,
  getLeagueXg, getLeagueXgPrev, getLeagueXgHistory, getTeamXg, getAllTeamXg,
  isTeamScoreSettled, isTeamXgSettled,
  getLive, getMatchDetail,
  getActiveHorizon, getActiveModule, getSquad, getSquadPicks, getSavedXi,
  getError, getLastRefreshAt, isFresh,
  setSeason, setPlayerSummary, setLeagueXg, setLeagueXgPrev, setLeagueXgHistory, setTeamXg,
  markTeamXgRequested, settleTeamXg, settleAllTeamXg,
  setLive, setMatchDetail,
  setActiveHorizon, setActiveModule, setSquad, setSquadPicks, setError, markDataReady,
  clearCache,
};
