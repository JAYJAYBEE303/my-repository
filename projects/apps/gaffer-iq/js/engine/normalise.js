/**
 * js/engine/normalise.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Transforms raw FPL API payloads into the clean internal models defined in
 * ARCHITECTURE.md §8 (Team, Player, Fixture, plus per-GW player stats).
 * This is the ONLY file in the codebase that may reference raw FPL field
 * names (element_type, team_h_difficulty, web_name, etc.). Everything
 * downstream speaks the internal model. A schema drift upstream breaks
 * exactly one file: this one.
 *
 * The same rule now covers one non-FPL payload: normaliseMatchLineups() at
 * the foot of this file reads Understat's match rosters, which are the only
 * source of a real teamsheet anywhere in the stack.
 */

import {
  PL_SEASONS, PL_TENURE_LOOKBACK, TEAM_NAME_ALIASES, TENURE_RECENCY_DECAY,
  TEAM_DISPLAY_NAME_OVERRIDES,
} from '../config.js';

// element_type id → internal position code. FPL uses 1=GKP, 2=DEF, 3=MID, 4=FWD.
const POSITION_BY_ELEMENT_TYPE = {
  1: 'GKP',
  2: 'DEF',
  3: 'MID',
  4: 'FWD',
};

// FPL status code → internal status string. The full set per FPL: a=available,
// d=doubtful, i=injured, s=suspended, n=not in squad, u=unavailable.
const STATUS_MAP = {
  a: 'available',
  d: 'doubtful',
  i: 'injured',
  s: 'suspended',
  n: 'unavailable',
  u: 'unavailable',
};

// ─── Premier League tenure ───────────────────────────────────────────────────
// Derives how much recent top-flight history a club has, from the static
// PL_SEASONS table in config.js. See FEATURE_ENGINE.md §2.1.

/** Collapses a club name or short code to a comparable key: 'Nott'm Forest' → 'nottmforest'. */
export function normaliseClubKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Season labels newest-first, capped at the configured lookback. Sorted
// explicitly rather than trusting object key order, so a reordered PL_SEASONS
// literal can never silently change every club's tenure.
const SEASONS_NEWEST_FIRST = Object.keys(PL_SEASONS)
  .sort()
  .reverse()
  .slice(0, PL_TENURE_LOOKBACK);

// club key → Set of "seasons ago" indices (0 = most recent season in the table).
const PL_PRESENCE_BY_CLUB = (() => {
  const out = {};
  SEASONS_NEWEST_FIRST.forEach((label, seasonsAgo) => {
    for (const club of PL_SEASONS[label]) {
      (out[normaliseClubKey(club)] ||= new Set()).add(seasonsAgo);
    }
  });
  return out;
})();

// Alias key → canonical club key, both normalised.
const CANONICAL_BY_ALIAS = (() => {
  const out = {};
  for (const [alias, canonical] of Object.entries(TEAM_NAME_ALIASES)) {
    out[normaliseClubKey(alias)] = normaliseClubKey(canonical);
  }
  return out;
})();

/**
 * Resolves any club name/short-form to its canonical normalised key via
 * TEAM_NAME_ALIASES, falling back to the value's own normalised form when it
 * isn't a known alias (i.e. it's already canonical, or genuinely unmatched —
 * the caller decides which). Shared by buildPlTenure below and by
 * engine/style.js's Understat team matcher — both are the same class of
 * problem (reconcile one source's club-name spelling against another's), and
 * both must NEVER join on FPL's numeric team id (see buildPlTenure's doc).
 *
 * @param {string} value  a club name or short code, from any source
 * @returns {string}      normalised canonical key, e.g. 'tottenhamhotspur'
 */
export function canonicalClubKey(value) {
  const key = normaliseClubKey(value);
  return CANONICAL_BY_ALIAS[key] ?? key;
}

// Denominator for the recency-weighted ratio: an ever-present club's total.
const TENURE_TOTAL_WEIGHT = SEASONS_NEWEST_FIRST
  .reduce((sum, _label, seasonsAgo) => sum + (TENURE_RECENCY_DECAY ** seasonsAgo), 0);

/**
 * Recency-weighted Premier League tenure for a club, matched by name then short
 * name (never by FPL team id — ids are reassigned as clubs are promoted and
 * relegated, so an id join silently mismatches exactly the clubs this measures).
 *
 * MODEL: recent seasons dominate. A club relegated last season loses the full
 * weight of the newest season; one that missed a season eight years ago loses
 * only TENURE_RECENCY_DECAY^8 of it.
 *
 * @param {string} name       club name as FPL reports it
 * @param {string} shortName  FPL short code, used as the fallback join key
 * @returns {{seasons: number, lookback: number, ratio: number, matched: boolean}}
 *   ratio: 0–1, 1 = present in every season of the lookback.
 *   matched: false when the club appears nowhere in PL_SEASONS. That covers both
 *   a genuine newcomer and a join failure; both correctly yield ratio 0, so the
 *   ambiguity has no behavioural consequence.
 */
export function buildPlTenure(name, shortName) {
  let clubKey = null;
  for (const raw of [name, shortName]) {
    if (!raw) continue;
    const resolved = canonicalClubKey(raw);
    if (PL_PRESENCE_BY_CLUB[resolved]) {
      clubKey = resolved;
      break;
    }
  }

  if (!clubKey) {
    return { seasons: 0, lookback: SEASONS_NEWEST_FIRST.length, ratio: 0, matched: false };
  }

  const seasonsAgoPresent = PL_PRESENCE_BY_CLUB[clubKey];
  let weighted = 0;
  for (const seasonsAgo of seasonsAgoPresent) {
    weighted += TENURE_RECENCY_DECAY ** seasonsAgo;
  }

  return {
    seasons:  seasonsAgoPresent.size,
    lookback: SEASONS_NEWEST_FIRST.length,
    ratio:    TENURE_TOTAL_WEIGHT === 0 ? 0 : weighted / TENURE_TOTAL_WEIGHT,
    matched:  true,
  };
}

/**
 * @param {object} raw  one entry from bootstrap-static.teams[]
 * @returns {Team}      internal Team — see ARCHITECTURE.md §8
 */
export function normaliseTeam(raw) {
  return {
    id: raw.id,
    // FPL's own `name` is what every view renders, and it is not always the
    // club's actual name — Nottingham Forest ships as the abbreviation
    // "Nott'm Forest". TEAM_DISPLAY_NAME_OVERRIDES (config.js) corrects it
    // here, at the one place raw FPL field names are allowed, so every
    // downstream reader of team.name gets the fix for free.
    name: TEAM_DISPLAY_NAME_OVERRIDES[raw.name] ?? raw.name,
    shortName: raw.short_name,
    // raw.code is a separate, stable per-club id (distinct from raw.id, which
    // is this season's fixture-list index) — it's what the official crest CDN
    // keys badges on. badgeUrl is precomputed here rather than built ad hoc
    // at render time so every module (matchup, ranker, dashboard, …) gets the
    // same URL for free. See PREMIER_LEAGUE badge pattern in ARCHITECTURE.md.
    code: raw.code,
    badgeUrl: `https://resources.premierleague.com/premierleague/badges/70/t${raw.code}.png`,
    strength: {
      overall:      raw.strength,
      overallHome:  raw.strength_overall_home,
      overallAway:  raw.strength_overall_away,
      attackHome:   raw.strength_attack_home,
      attackAway:   raw.strength_attack_away,
      defenceHome:  raw.strength_defence_home,
      defenceAway:  raw.strength_defence_away,
    },
    // Recency-weighted top-flight history — drives the promoted-team penalty in
    // engine/fixtures.js → calcBaseDifficulty. See FEATURE_ENGINE.md §2.1.
    plTenure: buildPlTenure(raw.name, raw.short_name),
    fixtures: [],   // fixture ids, populated by normaliseSeason
    form:  null,    // filled by engine/form.js
    style: null,    // filled by engine/style.js
  };
}

/**
 * @param {object} raw  one entry from bootstrap-static.elements[]
 * @returns {Player}    internal Player — see ARCHITECTURE.md §8
 */
export function normalisePlayer(raw) {
  return {
    id: raw.id,
    name: raw.web_name,
    fullName: `${raw.first_name || ''} ${raw.second_name || ''}`.trim(),
    teamId: raw.team,
    position: POSITION_BY_ELEMENT_TYPE[raw.element_type] || 'UNK',
    // now_cost is in tenths of millions (e.g. 75 → £7.5m).
    price: raw.now_cost / 10,
    ownership: parseFloat(raw.selected_by_percent) || 0,
    status: STATUS_MAP[raw.status] || 'available',
    statusNote: raw.news || null,
    // FPL's own forward-looking playing chance (0–100), set from press-conference
    // news. null for most players because FPL populates it only when there IS
    // news — so null means "no doubt reported", NOT "no data". Consumed by
    // engine/form.js → calcPlayingLikelihood, which falls back to STATUS_PLAY_CHANCE.
    chanceOfPlayingNext: typeof raw.chance_of_playing_next_round === 'number'
      ? raw.chance_of_playing_next_round
      : null,
    // FPL's own rolling form figure: average points per match over the last 30
    // days, as a decimal string upstream. NOT the same thing as `form` below,
    // which engine/form.js computes — hence the distinct name. Surfaced raw in
    // the Ranker's Form column so it can be read against our own model.
    fplForm: parseFloat(raw.form) || 0,
    totals: {
      points:      raw.total_points || 0,
      minutes:     raw.minutes || 0,
      // Appearances in the starting XI. Present in bootstrap-static since
      // 2021/22. Defensive fallback: if the field ever disappears, estimate
      // from minutes so engine/form.js's playtime model degrades to "assume a
      // full game per 90 played" instead of reading every player as a
      // never-starter, which is the single most damaging way this could fail.
      starts:      typeof raw.starts === 'number'
        ? raw.starts
        : Math.round((raw.minutes || 0) / 90),
      goals:       raw.goals_scored || 0,
      assists:     raw.assists || 0,
      xG:          parseFloat(raw.expected_goals)   || 0,
      xA:          parseFloat(raw.expected_assists) || 0,
      cleanSheets: raw.clean_sheets || 0,
    },
    // FPL ICT index components (season totals as decimal strings upstream).
    // Used by engine/counter.js → classifyRole to refine raw element_type
    // groupings into roles (CB vs FB, DM vs CM vs WM, ST vs SS).
    ict: {
      influence:  parseFloat(raw.influence)  || 0,
      creativity: parseFloat(raw.creativity) || 0,
      threat:     parseFloat(raw.threat)     || 0,
    },
    // In-GW transfer counts — used by engine/prices.js for price change prediction.
    // Phase 4-4: present in bootstrap-static.elements[]; zero-safe.
    transfersInEvent:  raw.transfers_in_event  || 0,
    transfersOutEvent: raw.transfers_out_event || 0,
    // Total price movement since the season opened, in TENTHS of a million
    // (3 → +£0.3m, -1 → -£0.1m) — same unit as now_cost above, NOT the same
    // unit as `price`. Kept in raw tenths here so the divide happens once, in
    // engine/prices.js → calcSeasonPriceChange, rather than at every call site.
    // Present in bootstrap-static.elements[]; zero-safe.
    costChangeStart:   raw.cost_change_start   || 0,
    history: null,   // populated lazily by normalisePlayerSummary
    form:    null,   // filled by engine/form.js
  };
}

/**
 * @param {object} raw  one entry from fixtures[]
 * @returns {Fixture}   internal Fixture — see ARCHITECTURE.md §8
 */
export function normaliseFixture(raw) {
  // FPL uses THREE flags, not two, and the difference matters:
  //   started              → flipped at kickoff
  //   finished_provisional → flipped at full time. The match is over.
  //   finished             → flipped LATER, once bonus points are confirmed.
  //
  // Reading `finished` alone (as this did) meant a match that ended hours ago
  // still counted as unplayed and carried no result — so the league table sat
  // empty, completed fixtures showed a LIVE chip, and every engine metric fed
  // by ctx.playedFixtures (team form, style profile, venue split, H2H) quietly
  // ignored the round for the rest of the evening. `played` therefore means
  // "the match has been played", which is what every caller already assumes.
  const started  = Boolean(raw.started);
  const complete = Boolean(raw.finished) || Boolean(raw.finished_provisional);
  const hasScore = typeof raw.team_h_score === 'number'
                && typeof raw.team_a_score === 'number';

  return {
    id: raw.id,
    gw: raw.event,                  // null for unscheduled fixtures (rare)
    kickoff: raw.kickoff_time,       // ISO string; engine never reformats
    // FPL sets provisional_start_time while a kickoff is unconfirmed — often the
    // precursor to a postponement. This is SCHEDULE confidence, a different axis
    // from the MODEL confidence that `provisional` carries on a CompositeScore,
    // so it must never be rendered with --estimated-border-style: that style is
    // already spoken for. See FEATURE_ENGINE.md §9.1.
    provisionalKickoff: Boolean(raw.provisional_start_time),
    homeTeamId: raw.team_h,
    awayTeamId: raw.team_a,
    played: complete,
    started,
    // Bonus points are still provisional between finished_provisional and
    // finished; the SCORELINE is not — it is final at full time. Only a
    // consumer that cares about bonus (not the scoreline) should read this.
    bonusConfirmed: Boolean(raw.finished),
    // The score as it currently stands — set as soon as FPL publishes one, so
    // an in-progress match can show its running score. `played` is what says
    // whether that score is final, and every engine consumer reaches results
    // through ctx.playedFixtures (composite.js: f.played && f.result), so a
    // mid-match score can never leak into a metric.
    result: hasScore
      ? { homeGoals: raw.team_h_score, awayGoals: raw.team_a_score }
      : null,
    fplDifficulty: {                 // the official 1–5 FDR Gaffer IQ replaces
      home: raw.team_h_difficulty,
      away: raw.team_a_difficulty,
    },
    gafferScore: null,               // filled by engine/composite.js
  };
}

/**
 * @param {object} raw  one entry from element-summary.history[]
 * @returns {GwStat}    per-GW stat for a player
 */
export function normaliseGwStat(raw) {
  return {
    gw: raw.round,
    fixtureId: raw.fixture,
    opponentTeamId: raw.opponent_team,
    isHome: Boolean(raw.was_home),
    minutes:       raw.minutes || 0,
    points:        raw.total_points || 0,
    goals:         raw.goals_scored || 0,
    assists:       raw.assists || 0,
    xG:            parseFloat(raw.expected_goals)   || 0,
    xA:            parseFloat(raw.expected_assists) || 0,
    cleanSheet:    Boolean(raw.clean_sheets),
    goalsConceded: raw.goals_conceded || 0,
    saves:         raw.saves || 0,
    bonus:         raw.bonus || 0,
    yellowCards:   raw.yellow_cards || 0,
    redCards:      raw.red_cards || 0,
  };
}

/**
 * Normalises a single element-summary payload — a player's history and upcoming fixtures.
 * @param {object} raw  the full element-summary/{id}/ response
 * @returns {PlayerSummary}  { history, historyPast, upcoming }
 */
export function normalisePlayerSummary(raw) {
  return {
    history: (raw.history || []).map(normaliseGwStat),
    historyPast: (raw.history_past || []).map(s => ({
      seasonName: s.season_name,
      points:     s.total_points || 0,
      minutes:    s.minutes || 0,
    })),
    upcoming: (raw.fixtures || []).map(f => ({
      id: f.id,
      gw: f.event,
      kickoff: f.kickoff_time,
      isHome: Boolean(f.is_home),
      opponentTeamId: f.is_home ? f.team_a : f.team_h,
      fplDifficulty: f.difficulty,
    })),
  };
}

/**
 * Stamp each event with `complete` — whether its football is actually over.
 *
 * MODEL: FPL's `event.finished` does NOT flip at full time. Like the fixture
 * flag of the same name it waits for BONUS CONFIRMATION, which lands hours
 * after the last whistle and, across an international break, can sit unset for
 * days. On 2026-09-07 all ten GW3 matches read `finished_provisional` while
 * event 3 still read `finished: false` — so every view anchored on the event
 * flag (Full Season strip, the Matchup Outlook window, the Ranker horizon) was
 * still offering a round that had finished the previous afternoon, while the
 * fixture rails beside them, reading `played`, had already moved on.
 *
 * The fixtures are the authority: a round is complete when every fixture
 * assigned to it has been played. This is the event-level twin of the
 * `finished || finished_provisional` rule normaliseFixture already applies —
 * see its comment for why reading `finished` alone is never enough.
 *
 * `event.finished` stays as a floor. Once FPL agrees, so do we.
 *
 * Two exclusions, both deliberate:
 *   - Fixtures with `gw === null` are postponed and awaiting a rearranged
 *     date. They are not a pending result for any round and must not hold one
 *     open.
 *   - A round with NO fixtures assigned falls back to the raw flag. An empty
 *     `every()` is true, which would otherwise report a round nobody has
 *     played as finished — the state before the fixtures payload lands.
 *
 * @param {{id: number, finished: boolean}[]} events
 * @param {{gw: number|null, played: boolean}[]} fixtures  normalised fixtures
 * @returns {object[]} the same events, each with an added `complete` boolean
 */
export function deriveEventCompletion(events, fixtures) {
  const total  = new Map();   // gw -> fixtures assigned
  const played = new Map();   // gw -> fixtures already played

  for (const f of fixtures || []) {
    if (f.gw === null || f.gw === undefined) continue;
    total.set(f.gw, (total.get(f.gw) || 0) + 1);
    if (f.played) played.set(f.gw, (played.get(f.gw) || 0) + 1);
  }

  return (events || []).map(e => ({
    ...e,
    complete: total.has(e.id)
      ? Boolean(e.finished) || (played.get(e.id) || 0) === total.get(e.id)
      : Boolean(e.finished),
  }));
}

/**
 * The earliest gameweek that still has football to come.
 *
 * MODEL: FPL's `is_current` is NOT "the round we are looking forward to". It
 * is set at a round's own deadline and stays there until the NEXT round's
 * deadline — so from Sunday full time until the following Friday it names a
 * gameweek in which every match has already been played. Anything that asks
 * "which round is coming up" and reads currentGw therefore offers a finished
 * gameweek as the next matchup, which is what the Ranker's fixture horizon and
 * the Full Season strip were both doing between rounds.
 *
 * The rule is one line: once the current round is FINISHED, the upcoming round
 * is the next one. While it is still being played it stays the upcoming round,
 * because its remaining fixtures genuinely are still to come and belong in a
 * horizon.
 *
 * Distinct from planner.js's `planningGw`, which advances at KICKOFF rather
 * than at full time — a transfer deadline is gone the moment the round starts,
 * so the planner must look further ahead than a fixture horizon does. Both
 * live alongside `currentGw`, which the Dashboard's live scoreboard and
 * calibration's snapshot still want in its raw FPL meaning.
 *
 * @param {{id: number, finished: boolean, complete?: boolean,
 *          isCurrent: boolean, isNext: boolean}[]} events
 *   `complete` from deriveEventCompletion — the round's real full-time state.
 *   Falls back to the raw `finished` flag when absent.
 * @returns {number} a gameweek id; 1 when there is nothing to go on
 */
export function deriveUpcomingGw(events) {
  const list    = events || [];
  const current = list.find(e => e.isCurrent) ?? null;
  const nextId  = list.find(e => e.isNext)?.id ?? null;

  if (!current) return nextId ?? 1;
  if (!(current.complete ?? current.finished)) return current.id;

  // Finished. `is_next` is null after the final gameweek of a season, and one
  // past the end is the honest answer there: every gameweek then reads as
  // played and every horizon window comes back empty, rather than the season's
  // last round being presented as still to come. Same fallback shape as
  // planner.js's `nextGw ?? currentGw + 1`.
  return nextId ?? current.id + 1;
}

/**
 * Composes the full normalised season from the two static payloads.
 * Pure — does not mutate inputs; constructs fresh objects throughout.
 * @param {object}   rawBootstrap   bootstrap-static/ response
 * @param {object[]} rawFixtures    fixtures/ response (raw array)
 * @returns {Season}  { teams, teamsById, players, playersById,
 *                      fixtures, fixturesById,
 *                      pendingFixtures, pendingFixturesByTeam,
 *                      positions, events, currentGw, nextGw, upcomingGw }
 */
export function normaliseSeason(rawBootstrap, rawFixtures) {
  if (!rawBootstrap || !Array.isArray(rawBootstrap.teams)) {
    throw new TypeError('normaliseSeason: bootstrap payload missing teams[]');
  }
  if (!Array.isArray(rawBootstrap.elements)) {
    throw new TypeError('normaliseSeason: bootstrap payload missing elements[]');
  }
  if (!Array.isArray(rawFixtures)) {
    throw new TypeError('normaliseSeason: fixtures must be an array');
  }

  const teamsRaw = rawBootstrap.teams.map(normaliseTeam);
  const players  = rawBootstrap.elements.map(normalisePlayer);
  const fixtures = rawFixtures.map(normaliseFixture);

  // Build per-team fixture id lists without mutating the inputs.
  // Fixtures sort by GW first, then kickoff, so each team's `fixtures` array
  // is in chronological order — what downstream horizon code expects.
  const sortedFixtures = fixtures.slice().sort((a, b) => {
    const gwA = a.gw ?? 999;
    const gwB = b.gw ?? 999;
    if (gwA !== gwB) return gwA - gwB;
    return (a.kickoff || '').localeCompare(b.kickoff || '');
  });

  const fixtureIdsByTeam = {};
  for (const f of sortedFixtures) {
    (fixtureIdsByTeam[f.homeTeamId] ||= []).push(f.id);
    (fixtureIdsByTeam[f.awayTeamId] ||= []).push(f.id);
  }
  const teams = teamsRaw.map(t => ({ ...t, fixtures: fixtureIdsByTeam[t.id] || [] }));

  // Postponed fixtures — no gameweek assigned yet, awaiting a rearranged date.
  //
  // A DERIVED VIEW, not a separate list: these entries stay in `fixtures` where
  // they have always been (the sort above parks them at the end via `?? 999`).
  // Removing them would be a behaviour change nothing asked for — every
  // aggregation already skips them through the `f.gw === null` guard in
  // composite.js's fixturesForTeamInWindow, so they are harmless where they sit.
  // What was missing is a way to FIND them, which is what this index provides.
  //
  // Display-only. Nothing that aggregates over a gameweek window may read this,
  // because these fixtures have no gameweek to be aggregated into.
  const pendingFixtures = sortedFixtures.filter(f => f.gw === null);

  const pendingFixturesByTeam = {};
  for (const f of pendingFixtures) {
    (pendingFixturesByTeam[f.homeTeamId] ||= []).push(f);
    (pendingFixturesByTeam[f.awayTeamId] ||= []).push(f);
  }

  const positions = (rawBootstrap.element_types || []).map(et => ({
    id:   et.id,
    code: et.singular_name_short,
    name: et.singular_name,
  }));

  const rawEvents = (rawBootstrap.events || []).map(e => ({
    id:           e.id,
    deadline:     e.deadline_time,
    // Raw FPL: true only once BONUS is confirmed, which is not full time. Read
    // `complete` below for "has this round been played". Kept because the
    // Dashboard's bonus-sensitive displays legitimately want the raw signal.
    finished:     Boolean(e.finished),
    // data_checked becomes true once FPL has processed at least one fixture's
    // live data — used by dashboard.js to distinguish "live" from "pre-deadline".
    dataChecked:  Boolean(e.data_checked),
    isCurrent:    Boolean(e.is_current),
    isNext:       Boolean(e.is_next),
    averageScore: e.average_entry_score || 0,
  }));

  // `complete` — full time by the fixtures, not by FPL's bonus clock. Stamped
  // here so every view shares one answer to "is this round over".
  const events = deriveEventCompletion(rawEvents, sortedFixtures);

  const teamsById    = Object.fromEntries(teams.map(t => [t.id, t]));
  const playersById  = Object.fromEntries(players.map(p => [p.id, p]));
  const fixturesById = Object.fromEntries(sortedFixtures.map(f => [f.id, f]));

  const currentGw = events.find(e => e.isCurrent)?.id ?? null;
  const nextGw    = events.find(e => e.isNext)?.id    ?? null;
  // "Which round is coming up" — see deriveUpcomingGw. Kept beside the two raw
  // FPL flags rather than derived at each call site so every view agrees.
  const upcomingGw = deriveUpcomingGw(events);

  return {
    teams, teamsById,
    players, playersById,
    fixtures: sortedFixtures, fixturesById,
    pendingFixtures, pendingFixturesByTeam,
    positions, events,
    currentGw, nextGw, upcomingGw,
  };
}

// ─── Understat match lineups ─────────────────────────────────────────────────
// The one place in this file that speaks a NON-FPL raw payload. It lives here
// for the same reason the rest does: a schema drift upstream should break
// exactly one file. FPL publishes no teamsheet at all — no XI, no bench, no
// formation — so this is the only route to a real lineup.

/**
 * Understat position codes, grouped into the lines a formation is written in.
 * Order matters: it is the order the numbers appear in "4-2-3-1".
 *
 * The prefixes are easy to misread — DMC is a defensive MIDFIELDER, not a
 * defender, so a naive "starts with D" test puts it in the back line and
 * turns 4-2-3-1 into 6-3-1.
 */
const FORMATION_LINES = [
  ['DR', 'DC', 'DL'],                 // defenders
  ['DMC', 'DML', 'DMR'],              // defensive midfield
  ['MC', 'ML', 'MR'],                 // midfield
  ['AMC', 'AML', 'AMR'],              // attacking midfield
  ['FW', 'FWL', 'FWR'],               // forwards
];

const GK_CODE  = 'GK';
const SUB_CODE = 'Sub';

/** Understat serves every numeric as a string; treat a missing value as 0. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Write the outfield shape as a formation string, e.g. '4-2-3-1'.
 * Empty lines are dropped, so a side with no attacking midfielders reads
 * 4-4-2 rather than 4-4-0-2.
 * @param {object[]} starters
 * @returns {string|null}  null when the shape can't be read
 */
function formationOf(starters) {
  const counts = FORMATION_LINES.map(
    codes => starters.filter(p => codes.includes(p.position)).length);
  const shape = counts.filter(n => n > 0);
  return shape.length ? shape.join('-') : null;
}

/**
 * Normalise one side's roster.
 * @param {object} roster  rosters.h or rosters.a — keyed by roster id
 * @returns {{formation: string|null, starters: object[], subs: object[]}}
 */
function normaliseSide(roster) {
  const byId = new Map(Object.entries(roster ?? {}));

  const players = [...byId.values()].map(r => ({
    rosterId:      String(r.id),
    name:          r.player,
    position:      r.position,
    positionOrder: num(r.positionOrder),
    minutes:       num(r.time),
    goals:         num(r.goals),
    ownGoals:      num(r.own_goals),
    assists:       num(r.assists),
    yellow:        num(r.yellow_card) > 0,
    red:           num(r.red_card) > 0,
    // roster_in points at the player who replaced them; roster_out at the
    // player they replaced. Either is '0' when it doesn't apply.
    cameOnForId:   num(r.roster_out) ? String(r.roster_out) : null,
    replacedById:  num(r.roster_in) ? String(r.roster_in) : null,
    replacedBy:    null,
    cameOnFor:     null,
    onAt:          null,
  }));

  const byRosterId = new Map(players.map(p => [p.rosterId, p]));

  for (const p of players) {
    if (p.replacedById) p.replacedBy = byRosterId.get(p.replacedById)?.name ?? null;
    if (p.cameOnForId) {
      const replaced = byRosterId.get(p.cameOnForId);
      p.cameOnFor = replaced?.name ?? null;
      // The minute a substitute came on is exactly the minutes the player he
      // replaced had been on for — no arithmetic against a match length that
      // stoppage time makes unreliable.
      p.onAt = replaced ? replaced.minutes : null;
    }
  }

  const starters = players
    .filter(p => p.position !== SUB_CODE)
    .sort((a, b) => a.positionOrder - b.positionOrder || a.name.localeCompare(b.name));

  const subs = players
    .filter(p => p.position === SUB_CODE)
    .sort((a, b) => (a.onAt ?? 999) - (b.onAt ?? 999) || a.name.localeCompare(b.name));

  return { formation: formationOf(starters), starters, subs };
}

/**
 * Build both teams' lineups from an Understat match payload.
 *
 * NOTE ON "BENCH": Understat lists only players who actually appeared, so
 * `subs` is the players who CAME ON, not a full bench — unused substitutes are
 * absent from the feed entirely. The UI labels it accordingly rather than
 * implying a complete teamsheet.
 *
 * @param {object} matchData  from api.js fetchMatchData() — needs `rosters`
 * @returns {{home: object, away: object}|null}  null when there is no roster
 */
export function normaliseMatchLineups(matchData) {
  const rosters = matchData?.rosters;
  if (!rosters?.h || !rosters?.a) return null;

  const home = normaliseSide(rosters.h);
  const away = normaliseSide(rosters.a);
  if (!home.starters.length && !away.starters.length) return null;

  return { home, away };
}
