/**
 * js/modules/fixtures.js
 * Layer: module. Owns the DOM for the Fixtures view.
 * Side effects: DOM writes; one lazy call to api.js's fetchLivePoints().
 * Reads from store; calls engine/standings.js and engine/h2h.js. No analytical
 * logic lives here — the league table is accumulated by engine/standings.js and
 * the head-to-head record by engine/h2h.js, not by this file
 * (ARCHITECTURE.md §3 hard rule 2).
 *
 * Four modes, switched by .fx-modes__btn — all four now run on live data:
 *   gameweek  — One GW's fixtures grouped by kickoff day: status, crests,
 *               score or kickoff time, and a per-fixture disclosure holding
 *               match events, both teamsheets and the pairing's H2H record.
 *   table     — The league table, accumulated from played fixtures, with an
 *               Overall/Home/Away split and European/relegation zones.
 *   team      — One club's season: its table row, its home/away split, every
 *               result so far and every fixture still to come.
 *   h2h       — Every meeting between two clubs across the seasons loaded,
 *               with the tallies, the venue split and the run of form.
 *
 * The three panes cross-link: a club name in the table or in a fixture row
 * opens By team on that club; an opponent in By team, or the H2H block inside
 * a fixture, opens Head-to-head on that pairing.
 *
 * The match-events feed comes from UNDERSTAT, not FPL. FPL publishes only
 * unordered per-fixture totals — no minute for anything, and no link between a
 * goal and its assist — so a chronological feed cannot be built from it.
 * Understat's match page carries a server-rendered timeline (every goal, card
 * and substitution with its minute) and its shots JSON ties each goal to its
 * assister. Both are fetched lazily when a fixture is opened, and the feed
 * degrades to the FPL grouping if either is unavailable.
 *
 * The teamsheet comes from the same place: Understat's match rosters carry
 * position and substitution linkage, so the panel shows a real starting XI
 * with a derived formation. FPL has no teamsheet at all. Understat lists only
 * players who APPEARED, so the second list is the substitutes used, never a
 * full bench — unused subs exist in neither feed.
 *
 * Subscriptions: data:ready, route:changed, live:updated, match:updated
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import { LEAGUE_FORM_WINDOW, H2H_MEETING_WINDOW } from '../config.js';
import { fetchLivePoints, fetchMatchTimeline, fetchMatchData, attachAssists } from '../api.js';
import {
  calcLeagueTable, attachNextFixtures, addMovement, buildTeamSchedule,
} from '../engine/standings.js';
import { buildH2hMeetings, takeRecentMeetings, summariseH2h } from '../engine/h2h.js';
import { findUnderstatMatchId } from '../engine/channel.js';
import { normaliseMatchLineups } from '../engine/normalise.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODES = ['gameweek', 'table', 'team', 'h2h'];

const FIRST_GW = 1;
const LAST_GW  = 38;

// Status chips a fixture row can carry. Drives both the legend and the rows,
// so the two can never drift apart.
const STATUS_CHIPS = [
  { key: 'ft',       label: 'FT',   hint: 'Full time — final score' },
  { key: 'live',     label: 'LIVE', hint: 'Kicked off, not yet finished' },
  { key: 'upcoming', label: 'KO',   hint: 'Upcoming — kickoff time shown' },
];

// Per-fixture stat identifiers worth showing as a match event, in feed order.
// Keys are FPL's own `explain[].stats[].identifier` values. Anything not
// listed here (minutes, bonus, bps, saves, clean sheets…) is scoring detail
// rather than a match event and belongs in the Ranker, not here.
const EVENT_IDENTIFIERS = [
  { id: 'goals_scored',     icon: '⚽', label: 'Goal' },
  { id: 'own_goals',        icon: '⚽', label: 'Own goal' },
  { id: 'assists',          icon: 'Ⓐ', label: 'Assist' },
  { id: 'penalties_saved',  icon: '✋', label: 'Penalty saved' },
  { id: 'penalties_missed', icon: '✖', label: 'Penalty missed' },
  { id: 'yellow_cards',     icon: '\u{1f7e8}', label: 'Yellow card' },
  { id: 'red_cards',        icon: '\u{1f7e5}', label: 'Red card' },
];

// Understat timeline event types -> glyph + label.
const TIMELINE_ICONS = {
  goal:     { icon: '\u26bd',     label: 'Goal' },
  own_goal: { icon: '\u26bd',     label: 'Own goal' },
  yellow:   { icon: '\u{1f7e8}',  label: 'Yellow card' },
  red:      { icon: '\u{1f7e5}',  label: 'Red card' },
  sub:      { icon: '\u21c4',     label: 'Substitution' },
};

// Reading order for a team's featured players.
const POS_ORDER = { GKP: 0, DEF: 1, MID: 2, FWD: 3 };

// League table columns, left to right. `num` cells are right-aligned mono.
const LEAGUE_COLUMNS = [
  { key: 'pos',  label: '#',    num: true  },
  { key: 'move', label: '',     num: false },
  { key: 'team', label: 'Team', num: false },
  { key: 'pl',   label: 'Pl',   num: true  },
  { key: 'w',    label: 'W',    num: true  },
  { key: 'd',    label: 'D',    num: true  },
  { key: 'l',    label: 'L',    num: true  },
  { key: 'gf',   label: 'GF',   num: true  },
  { key: 'ga',   label: 'GA',   num: true  },
  { key: 'gd',   label: 'GD',   num: true  },
  { key: 'pts',  label: 'Pts',  num: true  },
  { key: 'form', label: 'Form', num: false },
  { key: 'next', label: 'Next', num: false },
];

// Qualification / relegation zones, as inclusive position ranges. The legend
// and the per-row stripes both derive from this one list, so they cannot drift
// apart. Positions outside every range carry no zone.
const LEAGUE_ZONES = [
  { key: 'ucl',  label: 'Champions League',  from: 1,  to: 4  },
  { key: 'uel',  label: 'Europa League',     from: 5,  to: 5  },
  { key: 'uecl', label: 'Conference League', from: 6,  to: 6  },
  { key: 'rel',  label: 'Relegation',        from: 18, to: 20 },
];

// The By team header's stat strip, left to right. Keys are league-row fields
// (engine/standings.js), so the strip and the table can never disagree.
const TEAM_STATS = [
  { key: 'played',         label: 'Pl'  },
  { key: 'won',            label: 'W'   },
  { key: 'drawn',          label: 'D'   },
  { key: 'lost',           label: 'L'   },
  { key: 'goalsFor',       label: 'GF'  },
  { key: 'goalsAgainst',   label: 'GA'  },
  { key: 'goalDifference', label: 'GD', signed: true },
  { key: 'points',         label: 'Pts' },
];

// The By team home/away split table. Same fields as the strip above plus the
// position WITHIN that split, which is the only number the strip can't carry.
const SPLIT_COLUMNS = [
  { key: 'position',       label: 'Pos' },
  ...TEAM_STATS,
];

// Head-to-head meeting table, left to right. Date carries its year, so there
// is no separate Season column — which season a match fell in is a detail the
// date already answers, and two columns saying the same thing read as noise.
const H2H_COLUMNS = [
  { key: 'date',   label: 'Date'   },
  { key: 'venue',  label: 'Venue'  },
  { key: 'home',   label: 'Home'   },
  { key: 'score',  label: 'Score'  },
  { key: 'away',   label: 'Away'   },
  { key: 'result', label: 'Result' },
];

// Ordinal suffixes for league positions 1–20; anything else falls back to 'th'.
const ORDINALS = { 1: 'st', 2: 'nd', 3: 'rd', 21: 'st', 22: 'nd', 23: 'rd' };

// ─── Module-level state ───────────────────────────────────────────────────────

let _root      = null;   // [data-module="fixtures"] section
let _panesWrap = null;   // .fx-panes — stable click-delegation target
let _panes     = {};     // mode key -> .fx-pane element
let _pickers   = {};     // mode key -> .fx-picker element
let _modeBtns  = [];     // .fx-modes__btn nodes
let _mode      = 'gameweek';

let _gw    = null;         // gameweek the gameweek pane is showing
let _scope = 'overall';    // league table venue split
let _teamId = null;        // club the By team pane is showing
let _h2hA   = null;        // the two clubs the Head-to-head pane is comparing
let _h2hB   = null;

// Fixture ids whose <details> is open, so a re-render (live data landing,
// GW step) doesn't collapse what the user just opened.
let _openFixtures = new Set();

// GWs whose live payload is already in flight, so re-renders mid-fetch can't
// fire a duplicate request. Mirrors main.js's _teamXgRequested.
const _liveRequested = new Set();

// GWs whose live fetch failed. Rendered as a message instead of retrying in a
// loop — a dead upstream must not turn into a request storm.
const _liveFailed = new Set();

// Same pair of guards for the Understat timeline, keyed by fixture id.
const _timelineRequested = new Set();
const _timelineFailed    = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "1st", "2nd", "13th" — league positions, in prose. */
function ordinal(n) {
  if (!Number.isInteger(n) || n < 1) return '—';
  return `${n}${ORDINALS[n] ?? 'th'}`;
}

/** A goal difference or margin, always carrying its sign. */
function signed(n) {
  return `${n > 0 ? '+' : ''}${n}`;
}

/**
 * A team crest. Real badge when the team is known (team.badgeUrl is
 * precomputed in normalise.js), otherwise the empty ring the blueprint used.
 * onerror hides a missing badge rather than showing a broken-image icon —
 * same treatment as matchup.js's .gw-nav__badge.
 */
function crest(team, extra = '') {
  const cls = `fx-crest ${extra}`.trim();
  if (!team?.badgeUrl) return `<span class="${esc(cls)}" aria-hidden="true"></span>`;
  return `<img class="${esc(cls)}" src="${esc(team.badgeUrl)}" alt=""`
       + ` onerror="this.style.visibility='hidden'">`;
}

// ─── Date formatting ─────────────────────────────────────────────────────────
// Kickoffs arrive as ISO strings in UTC and are rendered in the viewer's local
// zone — deliberate: a personal tool should show the time you'd actually watch
// the match at. All formatting is display-only and stays in this module.

/**
 * Both feeds' date strings. FPL writes ISO-8601 with a trailing Z; Understat
 * (which reaches these formatters through the H2H meeting list) writes
 * 'YYYY-MM-DD HH:MM:SS' with a space and no zone, which only some engines
 * parse — normalising the separator makes it unambiguous everywhere.
 */
function toDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "15:00" */
function fmtTime(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'TBC';
}

/** "Saturday" */
function fmtWeekday(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { weekday: 'long' }) : 'Date TBC';
}

/** "16 August 2026" */
function fmtDateLong(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}

/** "19 Apr 2026" — short, but unambiguous across seasons. */
function fmtDateYear(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBC';
}

/** "16 Aug" */
function fmtDateShort(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'TBC';
}

/** "Fri 15 Aug, 18:30" */
function fmtDateTime(iso) {
  const d = toDate(iso);
  if (!d) return 'TBC';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
       + ', ' + fmtTime(iso);
}

/** Local calendar day, used only as a grouping key. Null kickoffs group last. */
function dayKey(iso) {
  const d = toDate(iso);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) : 'tbc';
}

// ─── Shared render pieces ─────────────────────────────────────────────────────

/**
 * Win/draw/loss pips.
 * @param {string[]} form  ['W','D','L',…] oldest → newest
 */
function pips(form) {
  if (!form?.length) return '<span class="fx-pips fx-pips--empty">—</span>';
  return `<span class="fx-pips">${form.map(r =>
    `<span class="fx-pip fx-pip--${r.toLowerCase()}" title="${esc(r)}"></span>`
  ).join('')}</span>`;
}

/** A short "nothing to show" block, styled like the rest of the pane. */
function emptyState(message) {
  return `<p class="fx-empty">${esc(message)}</p>`;
}

/**
 * A "still arriving" block — the same slot emptyState fills, but for a wait
 * rather than a verdict.
 *
 * These two states used to look identical: both rendered a line of muted text,
 * so "No meeting between these teams" and "Loading match data" read as the
 * same kind of statement, and only the wording separated a settled answer from
 * a pending one. A skeleton reads as pending at a glance and, unlike the text,
 * stops reading as pending the moment it is replaced.
 *
 * The message is kept as the block's accessible label rather than dropped: a
 * shimmer conveys nothing to a screen reader.
 *
 * @param {string} message  what is being waited for, e.g. 'Loading match data'
 * @param {number} lines    how tall the placeholder should read
 */
function loadingState(message, lines = 2) {
  const rows = Array.from(
    { length: lines },
    () => '<span class="skeleton skeleton--text"></span>',
  ).join('');
  return `<div class="skeleton-lines" role="status" aria-busy="true"
               aria-label="${esc(message)}" title="${esc(message)}">${rows}</div>`;
}

/**
 * The context object engine/h2h.js reads. Assembled here rather than held in
 * the store because it is a plain view over state the store already owns —
 * the same shape composite.js's buildScoreContext passes that engine.
 */
function h2hCtx() {
  return {
    teamsById:     store.getSeason()?.teamsById ?? {},
    fixtures:      store.getFixtures(),
    leagueXg:      store.getLeagueXg(),
    leagueXgPrev:  store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
  };
}

/**
 * How many Understat seasons are actually loaded. Reported to the user rather
 * than a hardcoded number, because each season's payload is fetched
 * independently at boot (main.js, Promise.allSettled) and any of them can fail
 * without taking the others down — "across 4 seasons" would then be a lie.
 */
function loadedSeasonCount() {
  return [store.getLeagueXg(), store.getLeagueXgPrev()].filter(Boolean).length
       + store.getLeagueXgHistory().length;
}

// ─── Gameweek pane ────────────────────────────────────────────────────────────

/**
 * @returns {'ft'|'live'|'upcoming'}  which status chip a fixture carries.
 *   `started` is set at kickoff and `finished` (→ played) at full time, so
 *   started && !played is exactly "in progress" — no clock arithmetic needed.
 */
function statusOf(fixture) {
  if (fixture.played)  return 'ft';
  if (fixture.started) return 'live';
  return 'upcoming';
}

// Result box shown beside each team once a fixture is complete.
const OUTCOMES = {
  W: { key: 'w', label: 'Won' },
  D: { key: 'd', label: 'Drawn' },
  L: { key: 'l', label: 'Lost' },
};

/**
 * Each side's outcome, or nulls while the fixture has no final score.
 * Deliberately gated on `played` rather than on `result` alone: `result` now
 * carries the RUNNING score of a live match (normalise.js), and a team leading
 * at half time has not won anything yet.
 * @returns {{home: 'W'|'D'|'L'|null, away: 'W'|'D'|'L'|null}}
 */
function outcomesFor(fixture) {
  if (!fixture.played || !fixture.result) return { home: null, away: null };
  const { homeGoals, awayGoals } = fixture.result;
  if (homeGoals > awayGoals) return { home: 'W', away: 'L' };
  if (homeGoals < awayGoals) return { home: 'L', away: 'W' };
  return { home: 'D', away: 'D' };
}

/**
 * One team's side of a fixture row. The result box sits on the inside edge of
 * each side, so the two mirror each other around the scoreline — .fx-side--away
 * is row-reverse, so the same DOM order renders mirrored on the right.
 */
function sideHtml(team, side, outcome) {
  const box = outcome
    ? `<span class="fx-result fx-result--${OUTCOMES[outcome].key}"
             title="${esc(OUTCOMES[outcome].label)}"
             aria-label="${esc(OUTCOMES[outcome].label)}">${outcome}</span>`
    : '';
  return `
    <span class="fx-side fx-side--${side}">
      ${crest(team)}
      <span class="fx-side__name" title="${esc(team?.name ?? '')}">${esc(team?.name ?? '???')}</span>
      ${box}
    </span>`;
}

/**
 * Index one gameweek's live payload down to a single fixture.
 *
 * FPL reports a player's stats for the GW as a whole in `stats`, and splits
 * them per fixture in `explain` — so in a double gameweek only `explain`
 * attributes correctly, which is why that is what this reads.
 *
 * @param {object} live      raw event/{gw}/live/ payload
 * @param {object} fixture   the fixture to extract
 * @returns {{events: {home: object[], away: object[]},
 *            featured: {home: object[], away: object[]}}}
 */
function indexFixtureLive(live, fixture) {
  const events   = { home: [], away: [] };
  const featured = { home: [], away: [] };

  for (const el of live?.elements ?? []) {
    const slice = el.explain?.find(x => x.fixture === fixture.id);
    if (!slice) continue;

    const player = store.getPlayer(el.id);
    if (!player) continue;

    const side = player.teamId === fixture.homeTeamId ? 'home'
               : player.teamId === fixture.awayTeamId ? 'away'
               : null;
    if (!side) continue;

    // explain[].stats only carries identifiers that scored (or cost) points,
    // so a missing identifier means "none", not "unknown".
    const values = {};
    for (const s of slice.stats ?? []) values[s.identifier] = s.value;

    const minutes = values.minutes ?? 0;
    if (minutes > 0) featured[side].push({ player, minutes });

    for (const kind of EVENT_IDENTIFIERS) {
      const count = values[kind.id] ?? 0;
      if (count > 0) events[side].push({ player, kind, count });
    }
  }

  for (const side of ['home', 'away']) {
    featured[side].sort((a, b) =>
      (POS_ORDER[a.player.position] ?? 9) - (POS_ORDER[b.player.position] ?? 9)
      || b.minutes - a.minutes
      || a.player.name.localeCompare(b.player.name));

    events[side].sort((a, b) =>
      EVENT_IDENTIFIERS.indexOf(a.kind) - EVENT_IDENTIFIERS.indexOf(b.kind)
      || a.player.name.localeCompare(b.player.name));
  }

  return { events, featured };
}

/** One line in a match-event feed. */
function eventHtml({ player, kind, count }) {
  return `
    <li class="fx-event">
      <span class="fx-event__icon" aria-hidden="true">${kind.icon}</span>
      <span class="fx-event__player">${esc(player.name)}</span>
      ${count > 1 ? `<span class="fx-event__count">×${count}</span>` : ''}
      <span class="fx-event__type">${esc(kind.label)}</span>
    </li>`;
}

/** One team's column of players who featured. */
function featuredHtml(list, team) {
  if (!list.length) return `<div class="fx-lineup">${emptyState('No appearances recorded.')}</div>`;
  return `
    <div class="fx-lineup">
      <p class="fx-lineup__head">
        <span class="fx-lineup__team">${esc(team?.shortName ?? '')}</span>
        <span class="fx-lineup__formation">${list.length} played</span>
      </p>
      <ul class="fx-lineup__list">
        ${list.map(({ player, minutes }) => `
          <li class="fx-lineup__row">
            <span class="fx-lineup__num">${minutes}'</span>
            <span class="fx-lineup__name">${esc(player.name)}</span>
            <span class="fx-lineup__pos">${esc(player.position)}</span>
          </li>`).join('')}
      </ul>
    </div>`;
}

/**
 * One line of the chronological match feed.
 *
 * A goal carries its assister on the SAME line: the two are one moment, and
 * Understat's shots JSON is what makes the pairing possible at all (FPL only
 * reports that someone assisted, never whose goal).
 */
function timelineEventHtml(ev) {
  const kind = TIMELINE_ICONS[ev.type] ?? TIMELINE_ICONS.goal;

  const body = ev.type === 'sub'
    ? `<span class="fx-tl__player fx-tl__player--off">${esc(ev.player)}</span>
       <span class="fx-tl__arrow" aria-hidden="true">\u2192</span>
       <span class="fx-tl__player fx-tl__player--on">${esc(ev.playerIn ?? '')}</span>`
    : `<span class="fx-tl__player">${esc(ev.player)}</span>
       ${ev.assist ? `<span class="fx-tl__assist">assist ${esc(ev.assist)}</span>` : ''}
       ${ev.score ? `<span class="fx-tl__score">${esc(ev.score)}</span>` : ''}`;

  // Home events sit left of the centre spine, away events right of it, with the
  // minute in the middle. The markup is IDENTICAL for both sides — CSS mirrors
  // the home row so its glyph ends up nearest the spine, the same technique
  // .fx-side--away uses on the fixture row. Which side an event belongs to is
  // then carried by position, so the old H/A column is gone; the label stays
  // for anyone not reading the layout.
  return `
    <li class="fx-tl__item fx-tl__item--${ev.side}">
      <span class="fx-tl__event">
        <span class="fx-tl__icon" title="${esc(kind.label)}" aria-hidden="true">${kind.icon}</span>
        <span class="fx-tl__body">${body}</span>
      </span>
      <span class="fx-tl__minute">${ev.minute}'</span>
      <span class="fx-visually-hidden">${esc(ev.side === 'home' ? 'home team' : 'away team')}</span>
    </li>`;
}

/**
 * The chronological match feed, when Understat has one. Returns null when it
 * doesn't, so the caller can fall back to the FPL event grouping rather than
 * showing an empty block.
 */
function timelineHtml(fixture) {
  const events = store.getMatchDetail(fixture.id)?.events;
  if (!events?.length) return null;

  return `
    <section class="fx-detail__block">
      <h4 class="fx-detail__title">Match events</h4>
      <ul class="fx-tl">${events.map(timelineEventHtml).join('')}</ul>
      <p class="fx-detail__note">
        In order of minute, home team left of the centre line and away team
        right of it. Timings and goal/assist pairings come from Understat —
        FPL publishes neither.
      </p>
    </section>`;
}

/**
 * Per-player marks on a lineup row: what he did, in the order a matchday
 * programme would list it. Repeats collapse to a count (a brace reads
 * "GOAL x2" rather than two identical badges).
 */
function lineupMarksHtml(p) {
  const marks = [];
  if (p.goals)    marks.push({ cls: 'goal',   glyph: '\u26bd', n: p.goals,    label: 'Goal' });
  if (p.ownGoals) marks.push({ cls: 'own',    glyph: '\u26bd', n: p.ownGoals, label: 'Own goal' });
  if (p.assists)  marks.push({ cls: 'assist', glyph: '\u24b6', n: p.assists,  label: 'Assist' });
  if (p.yellow)   marks.push({ cls: 'yellow', glyph: '\u{1f7e8}', n: 1, label: 'Yellow card' });
  if (p.red)      marks.push({ cls: 'red',    glyph: '\u{1f7e5}', n: 1, label: 'Red card' });

  return marks.map(m =>
    `<span class="fx-xi__mark fx-xi__mark--${m.cls}" title="${esc(m.label)}">${m.glyph}${
      m.n > 1 ? `<span class="fx-xi__markn">${m.n}</span>` : ''}</span>`).join('');
}

/** One player row in the XI or the substitutes list. */
function lineupRowHtml(p, isSub) {
  // A starter who was replaced, and a substitute who came on, each carry the
  // minute it happened — the same number, read from opposite ends.
  // The cell is ALWAYS emitted, empty when there was no substitution. The list
  // is one shared grid (see .fx-xi__list) and auto-placement fills it in DOM
  // order, so a row that skipped this cell would shift every later column left
  // by one and knock the whole list out of phase.
  const swapText = isSub
    ? (p.cameOnFor ? `${p.onAt}' for ${esc(p.cameOnFor)}` : '')
    : (p.replacedBy ? `${p.minutes}' \u2192 ${esc(p.replacedBy)}` : '');
  const swapClass = swapText ? ` fx-xi__swap--${isSub ? 'on' : 'off'}` : '';
  const swap = `<span class="fx-xi__swap${swapClass}">${swapText}</span>`;

  return `
    <li class="fx-xi__row">
      <span class="fx-xi__pos">${esc(isSub ? 'SUB' : p.position)}</span>
      <span class="fx-xi__name">${esc(p.name)}</span>
      <span class="fx-xi__marks">${lineupMarksHtml(p)}</span>
      ${swap}
      <span class="fx-xi__mins">${p.minutes}'</span>
    </li>`;
}

/** One team's teamsheet: formation, starting XI, then the substitutes used. */
function lineupColumnHtml(side, team) {
  return `
    <div class="fx-xi">
      <p class="fx-xi__head">
        <span class="fx-xi__team">${esc(team?.shortName ?? '')}</span>
        ${side.formation ? `<span class="fx-xi__formation">${esc(side.formation)}</span>` : ''}
      </p>
      <ol class="fx-xi__list">${side.starters.map(p => lineupRowHtml(p, false)).join('')}</ol>
      ${side.subs.length ? `
        <p class="fx-xi__subhead">Substitutes used</p>
        <ul class="fx-xi__list fx-xi__list--subs">${side.subs.map(p => lineupRowHtml(p, true)).join('')}</ul>`
        : ''}
    </div>`;
}

/**
 * The teamsheet block, when Understat has rosters for this match. Returns null
 * otherwise so the caller falls back to FPL's appearance list.
 */
function lineupsHtml(fixture, home, away) {
  const lineups = store.getMatchDetail(fixture.id)?.lineups;
  if (!lineups?.home?.starters?.length || !lineups?.away?.starters?.length) return null;

  return `
    <section class="fx-detail__block">
      <h4 class="fx-detail__title">Lineups</h4>
      <div class="fx-detail__cols">
        ${lineupColumnHtml(lineups.home, home)}
        ${lineupColumnHtml(lineups.away, away)}
      </div>
      <p class="fx-detail__note">
        Starting XI in position order, with the formation derived from those
        positions. Understat lists only players who appeared, so the second
        list is the substitutes USED — unused subs are published nowhere.
      </p>
    </section>`;
}

/**
 * The head-to-head record for one fixture's pairing, shown inside its
 * disclosure. Rendered for UPCOMING fixtures as well as played ones — the
 * record is exactly what you want before a match, not only after it.
 */
function h2hMiniHtml(fixture, home, away) {
  // Same window as the full pane — a peek that counted a different set of
  // matches from the view it links to would be worse than no peek at all.
  const meetings = takeRecentMeetings(
    buildH2hMeetings(fixture.homeTeamId, fixture.awayTeamId, h2hCtx()));
  const record   = summariseH2h(meetings);

  const open = `<button class="fx-link-btn" type="button" data-fx-open-h2h
      data-team-a="${fixture.homeTeamId}" data-team-b="${fixture.awayTeamId}"
      >Open full head-to-head →</button>`;

  if (!record.played) {
    return `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Head-to-head</h4>
        ${emptyState(loadedSeasonCount()
          ? `No meeting between ${home?.shortName ?? '???'} and ${away?.shortName ?? '???'} in the seasons loaded.`
          : 'Head-to-head history is still loading.')}
        ${open}
      </section>`;
  }

  return `
    <section class="fx-detail__block">
      <h4 class="fx-detail__title">Head-to-head</h4>
      <div class="fx-h2h-mini">
        <span class="fx-h2h-mini__tally">${record.aWins}<em>${esc(home?.shortName ?? 'home')} wins</em></span>
        <span class="fx-h2h-mini__tally">${record.draws}<em>draws</em></span>
        <span class="fx-h2h-mini__tally">${record.bWins}<em>${esc(away?.shortName ?? 'away')} wins</em></span>
        <span class="fx-h2h-mini__trend">${pips(record.trend)}</span>
      </div>
      ${open}
      <p class="fx-detail__note">
        Their last ${record.played} ${record.played === 1 ? 'meeting' : 'meetings'},
        spanning ${record.seasons} ${record.seasons === 1 ? 'season' : 'seasons'}; last met
        ${esc(fmtDateLong(record.last.date))}. Pips read from
        ${esc(home?.shortName ?? 'the home team')}’s perspective, oldest first.
      </p>
    </section>`;
}

/**
 * The match report half of a fixture's disclosure: what happened, and who was
 * on the pitch. An upcoming fixture has neither, and a played one needs the
 * GW's live payload, fetched lazily when the disclosure is first opened.
 */
/**
 * Is a match's Understat payload still on its way?
 *
 * Both blocks of the match report -- the event timeline and the lineups --
 * come from the same store.matchDetail entry, and both have an FPL-derived
 * fallback that looks nothing like the real thing: grouped totals in two
 * left-aligned lists, versus a centred minute-by-minute feed. Rendering that
 * fallback while the real payload was a second away meant opening a fixture
 * showed one layout and then visibly swapped to a different one. This lets the
 * caller say "wait" instead, so the fallback appears only when it is the final
 * answer rather than a placeholder for one.
 *
 * @param {Fixture} fixture
 * @returns {boolean}  true while the payload may still arrive
 */
function timelinePending(fixture) {
  if (_timelineFailed.has(fixture.id)) return false;
  if (store.getMatchDetail(fixture.id)) return false;
  // The fixture->match lookup is derived from Understat's league payload.
  // Until that lands ensureTimeline cannot even ask, so nothing is in flight
  // and the FPL fallback is the best available answer, not a placeholder.
  return Boolean(store.getLeagueXg());
}

function matchReportHtml(fixture, home, away) {
  const status = statusOf(fixture);

  if (status === 'upcoming') {
    return emptyState(`Not played yet — kicks off ${fmtDateTime(fixture.kickoff)}.`);
  }

  if (_liveFailed.has(fixture.gw)) {
    return emptyState(
      'Match data unavailable — the live endpoint could not be reached. Reload to retry.');
  }

  const live = store.getLive(fixture.gw);
  if (!live) {
    return loadingState('Loading match data…');
  }

  const { events, featured } = indexFixtureLive(live, fixture);
  const anyEvents = events.home.length || events.away.length;

  // Understat's chronological feed is the one we want. It only exists once
  // both its calls have landed, so until then (or if they fail) fall back to
  // FPL's grouped totals rather than showing nothing.
  const timeline = timelineHtml(fixture);
  const pending  = timelinePending(fixture);

  const eventsBlock = timeline ?? (pending ? `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Match events</h4>
        ${loadingState('Loading the minute-by-minute feed\u2026', 3)}
      </section>` : `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Match events</h4>
        ${anyEvents ? `
          <div class="fx-detail__cols">
            <ul class="fx-events">${events.home.map(eventHtml).join('')}</ul>
            <ul class="fx-events fx-events--away">${events.away.map(eventHtml).join('')}</ul>
          </div>` : emptyState('No goals, assists or cards recorded.')}
        <p class="fx-detail__note">
          Understat\u2019s timeline is unavailable for this match, so these are
          FPL\u2019s per-match totals: grouped by type, without
          minutes.${fixture.played && !fixture.bonusConfirmed
            ? ' Bonus points for this match are still provisional.' : ''}
        </p>
      </section>`);

  return `
      ${eventsBlock}

      ${lineupsHtml(fixture, home, away) ?? (pending ? `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Lineups</h4>
        ${loadingState('Loading the teamsheets\u2026', 3)}
      </section>` : `
      <section class="fx-detail__block">
        <h4 class="fx-detail__title">Who featured</h4>
        <div class="fx-detail__cols">
          ${featuredHtml(featured.home, home)}
          ${featuredHtml(featured.away, away)}
        </div>
        <p class="fx-detail__note">
          Every player with minutes, longest first within each position — FPL
          publishes no teamsheet. The real XI comes from Understat and is not
          available for this match.
        </p>
      </section>`)}`;
}

/**
 * The expandable half of a fixture row: the match report first, then the
 * pairing's head-to-head record. The second half renders whatever the first
 * can show, so an upcoming fixture still opens onto something worth reading —
 * which is exactly when the H2H record is most useful.
 */
function fixtureDetailHtml(fixture, home, away) {
  return `
    <div class="fx-detail">
      ${matchReportHtml(fixture, home, away)}
      ${h2hMiniHtml(fixture, home, away)}
    </div>`;
}

/** One fixture row: status, both sides, score or kickoff, and the disclosure. */
function fixtureHtml(fixture) {
  const home   = store.getTeam(fixture.homeTeamId);
  const away   = store.getTeam(fixture.awayTeamId);
  const status = statusOf(fixture);
  const chip   = STATUS_CHIPS.find(c => c.key === status);

  // A score is shown as soon as FPL publishes one, so a match in progress
  // carries its running score; the LIVE chip beside it is what says the score
  // is not final. Only a fixture yet to kick off falls back to its time.
  const centre = fixture.result
    ? `<span class="fx-fixture__score">${fixture.result.homeGoals}<em>–</em>${fixture.result.awayGoals}</span>`
    : `<span class="fx-fixture__score fx-fixture__score--time">${esc(fmtTime(fixture.kickoff))}</span>`;

  const outcome = outcomesFor(fixture);

  return `
    <li class="fx-item">
      <details class="fx-fixture" data-fixture-id="${fixture.id}"${_openFixtures.has(fixture.id) ? ' open' : ''}>
        <summary class="fx-fixture__summary">
          <span class="fx-status fx-status--${status}" title="${esc(chip.hint)}">${esc(chip.label)}</span>
          ${sideHtml(home, 'home', outcome.home)}
          <span class="fx-fixture__centre">
            ${centre}
            <span class="fx-fixture__ko">${esc(fmtDateShort(fixture.kickoff))}</span>
          </span>
          ${sideHtml(away, 'away', outcome.away)}
          <span class="fx-fixture__chev" aria-hidden="true">▾</span>
        </summary>
        ${fixtureDetailHtml(fixture, home, away)}
      </details>
    </li>`;
}

/** Group a GW's fixtures by local kickoff day, preserving fixture order. */
function groupByDay(fixtures) {
  const groups = [];
  const byKey  = new Map();
  for (const f of fixtures) {
    const key = dayKey(f.kickoff);
    if (!byKey.has(key)) {
      const group = { key, kickoff: f.kickoff, fixtures: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).fixtures.push(f);
  }
  return groups;
}

function renderGameweekPane() {
  if (!_panes.gameweek) return;

  if (!store.getSeason()) {
    _panes.gameweek.innerHTML = loadingState('Loading FPL data…', 3);
    return;
  }

  const gw       = _gw;
  const event    = store.getEvents().find(e => e.id === gw) ?? null;
  const fixtures = store.getFixtures().filter(f => f.gw === gw);
  const groups   = groupByDay(fixtures);

  // Every fixture rendered OPEN needs its timeline request started, not just
  // the one the user last toggled. A pane can paint with fixtures already open
  // — a repaint once live data lands, or Understat's league payload arriving
  // after the user had opened one — and matchReportHtml shows a pending
  // placeholder whenever a timeline could still arrive. Requesting here keeps
  // the invariant that nothing ever renders that placeholder without a live
  // request behind it. ensureTimeline is a no-op for anything already
  // requested, failed, or loaded, so this costs nothing on a repaint.
  for (const f of fixtures) {
    if (_openFixtures.has(f.id) && statusOf(f) !== 'upcoming') ensureTimeline(f);
  }

  const legend = STATUS_CHIPS.map(c => `
    <span class="fx-legend__item">
      <span class="fx-status fx-status--${c.key}">${esc(c.label)}</span>${esc(c.hint)}
    </span>`).join('');

  const first = fixtures[0]?.kickoff;
  const last  = fixtures[fixtures.length - 1]?.kickoff;
  const span  = first && last && dayKey(first) !== dayKey(last)
    ? `${fmtDateShort(first)} – ${fmtDateShort(last)}`
    : fmtDateLong(first);

  const tag = event?.isCurrent ? '<span class="fx-tag fx-tag--now">Current</span>'
            : event?.isNext    ? '<span class="fx-tag">Next</span>'
            : '';

  _panes.gameweek.innerHTML = `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title">Gameweek ${gw} ${tag}</h2>
        <p class="fx-pane__sub">
          ${event ? `<span>Deadline ${esc(fmtDateTime(event.deadline))}</span>` : ''}
          ${span ? `<span>${esc(span)}</span>` : ''}
          <span>${fixtures.length} ${fixtures.length === 1 ? 'fixture' : 'fixtures'}</span>
        </p>
      </div>
      <div class="fx-legend">${legend}</div>
    </header>

    ${fixtures.length ? groups.map(g => `
      <section class="fx-daygroup">
        <h3 class="fx-daygroup__title">
          <span class="fx-daygroup__day">${esc(fmtWeekday(g.kickoff))}</span>
          <span class="fx-daygroup__date">${esc(fmtDateLong(g.kickoff))}</span>
        </h3>
        <ul class="fx-list">${g.fixtures.map(fixtureHtml).join('')}</ul>
      </section>`).join('')
      : emptyState(`No fixtures scheduled for gameweek ${gw}.`)}

    ${pendingSectionHtml()}
  `;

  syncGwPicker(gw);
}

/**
 * Postponed fixtures — no gameweek assigned, awaiting a rearranged date.
 *
 * These were previously invisible everywhere in the app: they sit in the
 * fixtures array with gw === null, and every view filters by gameweek. A team
 * with a pending rearrangement simply looked like a team playing fewer games.
 *
 * Rendered once at the foot of the gameweek pane rather than inside a day
 * group, because they belong to no day and no gameweek. Returns '' when there
 * are none, which is the normal state.
 *
 * @returns {string} HTML
 */
function pendingSectionHtml() {
  const pending = store.getSeason()?.pendingFixtures ?? [];
  if (pending.length === 0) return '';

  const items = pending.map(f => {
    const h = store.getTeam(f.homeTeamId);
    const a = store.getTeam(f.awayTeamId);
    return `<li class="fx-pending__item">`
      + `<span class="fx-pending__team">${esc(h?.shortName ?? '?')}</span>`
      + `<span class="fx-pending__v">v</span>`
      + `<span class="fx-pending__team">${esc(a?.shortName ?? '?')}</span>`
      + `</li>`;
  }).join('');

  return `
    <section class="fx-daygroup fx-pending">
      <h3 class="fx-daygroup__title">
        <span class="fx-daygroup__day">Postponed</span>
        <span class="fx-daygroup__date">awaiting a date</span>
      </h3>
      <ul class="fx-list fx-pending__list">${items}</ul>
    </section>`;
}

/**
 * The gameweek this tab opens on, and the one its "now" button returns to.
 *
 * `upcomingGw` — the round still to be played — rather than FPL's `is_current`,
 * which stays pointing at a round from its own deadline until the next one
 * opens and so names a finished gameweek for most of every week. Landing on a
 * round whose last whistle blew days ago made the pane read as stale on the
 * very screen a reader opens to ask what is next. See engine/normalise.js
 * deriveUpcomingGw; the raw flags stay as fallbacks for a payload that has not
 * fully arrived.
 *
 * @returns {number}
 */
function homeGw() {
  return store.getUpcomingGw() ?? store.getCurrentGw() ?? store.getNextGw() ?? FIRST_GW;
}

/** Keep the stepper label and its bounds in step with the selected GW. */
function syncGwPicker(gw) {
  const label = _root.querySelector('#fx-gw-label');
  if (label) label.textContent = `Gameweek ${gw}`;

  const prev = _root.querySelector('[data-fx-gw="prev"]');
  const next = _root.querySelector('[data-fx-gw="next"]');
  if (prev) prev.disabled = gw <= FIRST_GW;
  if (next) next.disabled = gw >= LAST_GW;

  const now = _root.querySelector('[data-fx-gw="now"]');
  if (now) now.disabled = gw === homeGw();
}

// ─── Live payload (match events + appearances) ────────────────────────────────

/**
 * Fetch and cache one GW's live payload, once. Fire-and-forget: the pane
 * re-renders off the store's 'live:updated' event when it lands.
 *
 * Failures are swallowed to a console warning and a per-GW flag, never
 * store.setError() — match detail is an ENRICHMENT of the fixture list, so a
 * dead live endpoint must not blank the tab. Same policy as the Understat
 * fetches in main.js (ROADMAP §3A, CONVENTIONS.md §9).
 */
function ensureLive(gw) {
  if (!Number.isInteger(gw)) return;
  if (store.getLive(gw) || _liveRequested.has(gw) || _liveFailed.has(gw)) return;

  _liveRequested.add(gw);
  fetchLivePoints(gw)
    .then(raw => store.setLive(gw, raw))
    .catch(err => {
      _liveFailed.add(gw);
      console.warn(`[fixtures] live data unavailable for GW${gw}: ${err.message ?? err}`);
      if (_mode === 'gameweek') renderGameweekPane();
    });
}

/**
 * Give up on a fixture's timeline, and repaint so the UI stops waiting for it.
 *
 * The repaint is not optional. matchReportHtml now renders a "loading"
 * placeholder for as long as timelinePending() is true, and this flag is what
 * makes it false -- so a path that sets the flag without repainting leaves the
 * placeholder on screen permanently. Two of the three call sites below used to
 * do exactly that; only the .catch() repainted.
 *
 * Deferred to a microtask because the "no match id" path runs synchronously
 * inside the <details> toggle handler, and replacing the pane's markup
 * mid-dispatch would pull the element being toggled out from under the event.
 *
 * @param {number} fixtureId
 * @param {string} reason  logged, not shown -- the UI wording is fixed copy
 */
function failTimeline(fixtureId, reason) {
  _timelineFailed.add(fixtureId);
  console.warn(`[fixtures] ${reason}`);
  queueGameweekRepaint();
}

// Set while a repaint is already queued, so a gameweek where several fixtures
// have no Understat match collapses to one repaint instead of one per fixture.
let _repaintQueued = false;

/**
 * Repaint the gameweek pane once, after the current task finishes.
 *
 * Deferred rather than immediate because failTimeline's "no match id" path runs
 * synchronously inside the <details> toggle handler, and replacing the pane's
 * markup mid-dispatch would pull the element being toggled out from under the
 * event.
 */
function queueGameweekRepaint() {
  if (_repaintQueued) return;
  _repaintQueued = true;
  queueMicrotask(() => {
    _repaintQueued = false;
    if (_mode === 'gameweek') renderGameweekPane();
  });
}

/**
 * Fetch, parse and cache one fixture's Understat match timeline, once.
 *
 * Two upstream calls: the match page for the chronological feed (the only
 * source of a minute for cards) and the match JSON for goal→assist pairing.
 * The page is the backbone and the JSON a pure enrichment, so a failure of the
 * second still yields a full timeline, just without assists.
 *
 * Fire-and-forget; the pane re-renders off 'match:updated'. Failures are
 * swallowed to a console warning and a per-fixture flag, never
 * store.setError() — this is an ENRICHMENT of a feed that already renders from
 * FPL data. Same policy as the Understat fetches in main.js (CONVENTIONS.md §9).
 */
function ensureTimeline(fixture) {
  if (!fixture || _timelineRequested.has(fixture.id) || _timelineFailed.has(fixture.id)) return;
  if (store.getMatchDetail(fixture.id)) return;

  // The fixture→match mapping is derived from Understat's league payload, which
  // arrives asynchronously at boot. Opening a fixture before it lands is a
  // "not yet", NOT a failure — flagging it here would permanently deny this
  // fixture a timeline for the rest of the session.
  const leagueXg = store.getLeagueXg();
  if (!leagueXg) return;

  const matchId = findUnderstatMatchId(fixture, leagueXg, store.getSeason()?.teamsById);
  if (!matchId) {
    // League data IS loaded and still no match — Understat genuinely has no
    // record of this fixture. Flag it so the FPL fallback replaces the loading
    // placeholder instead of the placeholder sitting there for ever.
    failTimeline(fixture.id, `no Understat match found for fixture ${fixture.id}`);
    return;
  }

  _timelineRequested.add(fixture.id);

  fetchMatchTimeline(matchId)
    .then(async (events) => {
      if (!events.length) {
        failTimeline(fixture.id, `Understat returned an empty timeline for fixture ${fixture.id}`);
        return;
      }

      // One extra call gives BOTH the goal→assist pairing and the teamsheets.
      // Optional: without it the feed still renders, just without assists and
      // with the FPL appearance list in place of a lineup.
      let lineups = null;
      try {
        const matchData = await fetchMatchData(matchId);
        attachAssists(events, matchData);
        lineups = normaliseMatchLineups(matchData);
      } catch (err) {
        console.warn(`[fixtures] match data unavailable for match ${matchId}: ${err.message ?? err}`);
      }

      store.setMatchDetail(fixture.id, { events, lineups });
    })
    .catch((err) => {
      failTimeline(fixture.id,
        `Understat timeline unavailable for fixture ${fixture.id}: ${err.message ?? err}`);
    });
}

// ─── League table pane ────────────────────────────────────────────────────────

/**
 * @param {number} pos  1-based league position
 * @returns {string}    zone key, or '' for the positions that belong to none.
 */
function zoneFor(pos) {
  return LEAGUE_ZONES.find(z => pos >= z.from && pos <= z.to)?.key ?? '';
}

/** ▲ / – / ▼ for a team's movement since the previous gameweek. */
function movementHtml(movement) {
  if (movement > 0) return `<span class="fx-league__move fx-league__move--up" title="Up ${movement}">▲</span>`;
  if (movement < 0) return `<span class="fx-league__move fx-league__move--down" title="Down ${-movement}">▼</span>`;
  return '<span class="fx-league__move fx-league__move--flat" title="No change">–</span>';
}

/** The Next column: opponent crest, short name, venue and official FDR. */
function nextFixtureHtml(next) {
  if (!next) return '<span class="fx-league__none">—</span>';
  return `${crest(next.opponent, 'fx-crest--sm')}`
       + `<span title="${esc(next.opponent?.name ?? '')}">${esc(next.opponent?.shortName ?? '???')}</span>`
       + `<span class="fx-venue">(${next.isHome ? 'H' : 'A'})</span>`
       + (next.difficulty
           ? `<span class="fx-row__tag fx-fdr--${next.difficulty}" title="Official FPL difficulty">${next.difficulty}</span>`
           : '');
}

function leagueRowHtml(row) {
  const zone = zoneFor(row.position);
  return `
    <tr class="fx-league__row${zone ? ` fx-league__row--${zone}` : ''}">
      <td class="fx-league__pos">${row.position}</td>
      <td>${movementHtml(row.movement)}</td>
      <td class="fx-league__team">
        ${crest(row.team, 'fx-crest--sm')}
        <button class="fx-link-btn" type="button" data-fx-open-team
                data-team-id="${row.teamId}">${esc(row.team.name)}</button>
      </td>
      <td class="fx-league__num">${row.played}</td>
      <td class="fx-league__num">${row.won}</td>
      <td class="fx-league__num">${row.drawn}</td>
      <td class="fx-league__num">${row.lost}</td>
      <td class="fx-league__num">${row.goalsFor}</td>
      <td class="fx-league__num">${row.goalsAgainst}</td>
      <td class="fx-league__num">${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}</td>
      <td class="fx-league__num fx-league__pts">${row.points}</td>
      <td class="fx-league__form">${pips(row.form)}</td>
      <td class="fx-league__next">${nextFixtureHtml(row.nextFixture)}</td>
    </tr>`;
}

function renderTablePane() {
  if (!_panes.table) return;

  const season = store.getSeason();
  if (!season) {
    _panes.table.innerHTML = loadingState('Loading FPL data…', 3);
    return;
  }

  const fixtures = store.getFixtures();
  const teams    = store.getTeams();
  const played   = fixtures.filter(f => f.played && f.result);

  // "Completed gameweeks" is the highest GW that has any finished fixture —
  // the movement baseline is the table as it stood one GW earlier.
  const lastGw = played.reduce((max, f) => (f.gw !== null && f.gw > max ? f.gw : max), 0);

  const rows = attachNextFixtures(
    addMovement(
      calcLeagueTable(fixtures, teams, { venue: _scope }),
      calcLeagueTable(fixtures, teams, { venue: _scope, upToGw: Math.max(lastGw - 1, 0) }),
    ),
    fixtures,
    season.teamsById,
  );

  const legend = LEAGUE_ZONES.map(z => `
    <span class="fx-legend__item">
      <span class="fx-zone-key fx-zone-key--${z.key}" aria-hidden="true"></span>${esc(z.label)}
    </span>`).join('');

  const lastKickoff = played.reduce(
    (latest, f) => (f.kickoff && (!latest || f.kickoff > latest) ? f.kickoff : latest), null);

  const scopeNote = _scope === 'overall'
    ? 'All fixtures.'
    : `${_scope === 'home' ? 'Home' : 'Away'} fixtures only — positions are for this split, not the real table.`;

  _panes.table.innerHTML = `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title">League table</h2>
        <p class="fx-pane__sub">
          <span>After ${lastGw} ${lastGw === 1 ? 'gameweek' : 'gameweeks'}</span>
          ${lastKickoff ? `<span>Latest result ${esc(fmtDateShort(lastKickoff))}</span>` : ''}
          <span>${esc(scopeNote)}</span>
        </p>
      </div>
      <div class="fx-legend">${legend}</div>
    </header>

    ${played.length ? `
      <div class="fx-table-wrap">
        <table class="fx-table fx-league">
          <thead>
            <tr>
              ${LEAGUE_COLUMNS.map(c =>
                `<th scope="col"${c.num ? ' class="fx-league__num"' : ''}>${esc(c.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${rows.map(leagueRowHtml).join('')}</tbody>
        </table>
      </div>

      <p class="fx-detail__note">
        Accumulated from finished fixtures — FPL publishes no standings endpoint.
        Ordering is points, then goal difference, then goals scored; clubs level
        on all three are shown alphabetically rather than split by head-to-head.
        Form is the last ${LEAGUE_FORM_WINDOW} results, most recent last. Next shows the official
        FPL 1–5 difficulty, not the Gaffer IQ score.
      </p>`
      : emptyState('No fixtures have been played yet this season.')}
  `;
}

// ─── Team pane ────────────────────────────────────────────────────────────────

/**
 * One row in either column of the By team pane. Results and upcoming fixtures
 * share a row shape deliberately — the same six columns mean the eye reads
 * straight across the split without re-learning the layout on the right.
 *
 * Every row emits exactly six cells (.fx-row is a six-column grid), so the
 * last one falls back to an empty span rather than being omitted.
 */
function teamRowHtml(entry, teamId) {
  const opp = entry.opponent;

  // The opponent's name is the cross-link into Head-to-head for this pairing.
  const oppName = opp
    ? `<button class="fx-link-btn" type="button" data-fx-open-h2h
              data-team-a="${teamId}" data-team-b="${opp.id}"
              title="Head-to-head with ${esc(opp.name)}">${esc(opp.name)}</button>`
    : '<span class="fx-league__none">TBC</span>';

  const played = entry.outcome !== null;

  const value = played
    ? `<span class="fx-row__value">${entry.scored}<em>–</em>${entry.conceded}</span>`
    : `<span class="fx-row__value fx-row__value--time">${esc(fmtTime(entry.kickoff))}</span>`;

  // Played rows end in the result box; upcoming rows end in the official FPL
  // difficulty, which is the only forward-looking number FPL publishes here.
  const tail = played
    ? `<span class="fx-result fx-result--${OUTCOMES[entry.outcome].key}"
             title="${esc(OUTCOMES[entry.outcome].label)}"
             aria-label="${esc(OUTCOMES[entry.outcome].label)}">${entry.outcome}</span>`
    : entry.difficulty
      ? `<span class="fx-row__tag fx-fdr--${entry.difficulty}"
               title="Official FPL difficulty">${entry.difficulty}</span>`
      : '<span></span>';

  return `
    <li class="fx-item">
      <div class="fx-row">
        <span class="fx-row__gw">${entry.gw === null ? '—' : `GW${entry.gw}`}</span>
        <span class="fx-row__date">${esc(fmtDateShort(entry.kickoff))}</span>
        <span class="fx-venue" title="${entry.isHome ? 'Home' : 'Away'}">${entry.isHome ? 'H' : 'A'}</span>
        <span class="fx-row__opp">${crest(opp, 'fx-crest--sm')}${oppName}</span>
        ${value}
        ${tail}
      </div>
    </li>`;
}

/**
 * One venue's line in the By team home/away split.
 *
 * Position is blanked until the team has played at that venue: with nothing
 * to separate them every club is level, so the sort falls through to the
 * alphabetical tiebreak and "2nd away" would be a statement about the club's
 * name, not its record.
 */
function splitRowHtml(label, row) {
  const cell = (c) => {
    if (!row) return '—';
    if (c.key === 'position' && !row.played) return '—';
    return c.signed ? signed(row[c.key]) : row[c.key];
  };

  return `
    <tr>
      <th scope="row">${esc(label)}</th>
      ${SPLIT_COLUMNS.map(c => `<td class="fx-league__num">${cell(c)}</td>`).join('')}
    </tr>`;
}

function renderTeamPane() {
  if (!_panes.team) return;

  if (!store.getSeason()) {
    _panes.team.innerHTML = loadingState('Loading FPL data…', 3);
    return;
  }

  const team = _teamId === null ? null : store.getTeam(_teamId);
  if (!team) {
    _panes.team.innerHTML = emptyState(
      'Pick a team above — or click a club in the Table or a fixture — to see its season.');
    return;
  }

  const fixtures  = store.getFixtures();
  const teams     = store.getTeams();
  const teamsById = store.getSeason().teamsById;

  const rowFor  = venue => calcLeagueTable(fixtures, teams, { venue })
    .find(r => r.teamId === team.id) ?? null;
  const overall = rowFor('overall');
  const homeRow = rowFor('home');
  const awayRow = rowFor('away');

  const { results, upcoming } = buildTeamSchedule(team.id, fixtures, teamsById);
  // Results read newest-first (what just happened matters most); upcoming keeps
  // schedule order, because the next fixture is the one you care about there.
  const recent = results.slice().reverse();
  const next   = upcoming[0] ?? null;

  const nextText = next
    ? `${next.opponent?.shortName ?? 'TBC'} (${next.isHome ? 'H' : 'A'}) · ${fmtDateShort(next.kickoff)}`
    : 'Season complete';

  _panes.team.innerHTML = `
    <header class="fx-pane__head fx-pane__head--team">
      <div class="fx-teamhead">
        ${crest(team, 'fx-crest--lg')}
        <div class="fx-teamhead__text">
          <h2 class="fx-pane__title" id="fx-team-name">${esc(team.name)}</h2>
          <p class="fx-pane__sub">
            <span>${overall?.played
              ? `${esc(ordinal(overall.position))} in the table`
              : 'No fixtures played yet'}</span>
            <span>Form ${pips(overall?.form ?? [])}</span>
            <span>Next ${esc(nextText)}</span>
          </p>
        </div>
      </div>
      <ul class="fx-stat-row">
        ${TEAM_STATS.map(s => `
          <li class="fx-stat">
            <span class="fx-stat__label">${esc(s.label)}</span>
            <span class="fx-stat__value">${overall
              ? (s.signed ? signed(overall[s.key]) : overall[s.key])
              : '—'}</span>
          </li>`).join('')}
      </ul>
    </header>

    <section class="fx-vsplit">
      <h3 class="fx-col__title">
        Home / away split
        <span class="fx-col__count">position is within that split, not the real table</span>
      </h3>
      <div class="fx-table-wrap">
        <table class="fx-table">
          <thead>
            <tr>
              <th scope="col">Venue</th>
              ${SPLIT_COLUMNS.map(c => `<th scope="col" class="fx-league__num">${esc(c.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${splitRowHtml('Home', homeRow)}
            ${splitRowHtml('Away', awayRow)}
          </tbody>
        </table>
      </div>
    </section>

    <div class="fx-two-col">
      <section class="fx-col">
        <h3 class="fx-col__title">
          Results
          <span class="fx-col__count">${recent.length} played · most recent first</span>
        </h3>
        ${recent.length
          ? `<ul class="fx-list fx-list--compact">${
              recent.map(e => teamRowHtml(e, team.id)).join('')}</ul>`
          : emptyState('No fixtures completed yet this season.')}
      </section>
      <section class="fx-col">
        <h3 class="fx-col__title">
          Upcoming
          <span class="fx-col__count">${upcoming.length} to play</span>
        </h3>
        ${upcoming.length
          ? `<ul class="fx-list fx-list--compact">${
              upcoming.map(e => teamRowHtml(e, team.id)).join('')}</ul>`
          : emptyState('No fixtures left to play.')}
      </section>
    </div>

    <p class="fx-detail__note">
      Accumulated from FPL's fixture list — there is no standings endpoint to
      read this from. A fixture appears under Results only once it carries a
      final score, so one flagged finished while FPL is still processing the
      round stays on the right until its score lands. Kickoffs are shown in your
      local time; the tag on an upcoming fixture is the official FPL 1–5
      difficulty, not the Gaffer IQ score. Click any opponent for the full
      head-to-head.
    </p>
  `;
}

// ─── Head-to-head pane ────────────────────────────────────────────────────────

/** The current unbroken run, in prose, read from team A's end. */
function streakText(streak, teamA, teamB) {
  if (!streak) return '—';
  const { outcome, count } = streak;

  if (count === 1) {
    if (outcome === 'D') return 'The last meeting was drawn';
    return `${outcome === 'W' ? teamA.shortName : teamB.shortName} won the last meeting`;
  }
  if (outcome === 'D') return `The last ${count} meetings were drawn`;
  return `${outcome === 'W' ? teamA.shortName : teamB.shortName} have won the last ${count}`;
}

/** A meeting as a one-line scoreline, read from team A's end. */
function marginText(meeting) {
  if (!meeting) return null;
  return `${meeting.goalsForA}–${meeting.goalsAgainstA}`
       + ` ${meeting.aWasHome ? 'at home' : 'away'}, ${meeting.season ?? fmtDateShort(meeting.date)}`;
}

/** One meeting in the full history table. */
function h2hRowHtml(meeting, teamA, teamB) {
  const home = meeting.aWasHome ? teamA : teamB;
  const away = meeting.aWasHome ? teamB : teamA;
  const outcome = OUTCOMES[meeting.outcomeA];

  // The venue marker sits in a SPAN inside the cell, never on the <td> itself:
  // .fx-venue is inline-flex, and an inline-flex <td> drops out of the table's
  // cell flow entirely — the column then sizes and baselines independently of
  // every other one in the row.
  return `
    <tr>
      <td class="fx-h2h-date">${esc(fmtDateYear(meeting.date))}</td>
      <td><span class="fx-venue" title="${esc(teamA.shortName)} ${
        meeting.aWasHome ? 'at home' : 'away'}">${meeting.aWasHome ? 'H' : 'A'}</span></td>
      <td class="fx-h2h-club">${crest(home, 'fx-crest--sm')}${esc(home?.shortName ?? meeting.homeName)}</td>
      <td class="fx-table__score">${meeting.homeGoals}<em>–</em>${meeting.awayGoals}</td>
      <td class="fx-h2h-club">${crest(away, 'fx-crest--sm')}${esc(away?.shortName ?? meeting.awayName)}</td>
      <td><span class="fx-result fx-result--${outcome.key}"
                title="${esc(teamA.shortName)} ${esc(outcome.label.toLowerCase())}"
                aria-label="${esc(teamA.shortName)} ${esc(outcome.label.toLowerCase())}"
          >${meeting.outcomeA}</span></td>
    </tr>`;
}

/** The pane's header, shared by the real view and every empty state. */
function h2hHeadHtml(title, sub = '') {
  return `
    <header class="fx-pane__head">
      <div class="fx-pane__headline">
        <h2 class="fx-pane__title" id="fx-h2h-title">${esc(title)}</h2>
        ${sub ? `<p class="fx-pane__sub"><span>${esc(sub)}</span></p>` : ''}
      </div>
    </header>`;
}

function renderH2hPane() {
  if (!_panes.h2h) return;

  if (!store.getSeason()) {
    _panes.h2h.innerHTML = loadingState('Loading FPL data…', 3);
    return;
  }

  const teamA = _h2hA === null ? null : store.getTeam(_h2hA);
  const teamB = _h2hB === null ? null : store.getTeam(_h2hB);

  if (!teamA || !teamB) {
    _panes.h2h.innerHTML = h2hHeadHtml('Pick two teams')
      + emptyState('Choose a club on each side above, or open a fixture and follow its head-to-head link.');
    return;
  }

  if (teamA.id === teamB.id) {
    _panes.h2h.innerHTML = h2hHeadHtml('Pick two different teams')
      + emptyState(`${teamA.name} cannot play itself.`);
    return;
  }

  // The window is applied HERE, once: everything below — tiles, venue split,
  // run of form, table — then describes the same set of matches.
  const onRecord = buildH2hMeetings(teamA.id, teamB.id, h2hCtx());
  const meetings = takeRecentMeetings(onRecord);
  const record   = summariseH2h(meetings);
  const capped   = onRecord.length > meetings.length;
  const seasonsLoaded = loadedSeasonCount();

  if (!record.played) {
    return void (_panes.h2h.innerHTML = h2hHeadHtml(`${teamA.name} vs ${teamB.name}`)
      + emptyState(seasonsLoaded
          ? `No league meeting in the ${seasonsLoaded} ${seasonsLoaded === 1 ? 'season' : 'seasons'} loaded — the two have not been in this division together in that window.`
          : 'Historical results are still loading.'));
  }

  const { aHome, aAway } = record.venue;

  _panes.h2h.innerHTML = `
    ${h2hHeadHtml(`${teamA.name} vs ${teamB.name}`)}
    <p class="fx-pane__sub fx-pane__sub--standalone">
      <span>${capped
        ? `Last ${record.played} of ${onRecord.length} meetings`
        : `${record.played} ${record.played === 1 ? 'meeting' : 'meetings'} on record`}</span>
      <span>Spanning ${record.seasons} ${record.seasons === 1 ? 'season' : 'seasons'}</span>
      <span>Last met ${esc(fmtDateLong(record.last.date))}</span>
    </p>

    <div class="fx-h2h-summary">
      <div class="fx-h2h-tile fx-h2h-tile--a">
        <span class="fx-h2h-tile__value">${record.aWins}</span>
        <span class="fx-h2h-tile__label">${esc(teamA.name)} wins</span>
      </div>
      <div class="fx-h2h-tile fx-h2h-tile--d">
        <span class="fx-h2h-tile__value">${record.draws}</span>
        <span class="fx-h2h-tile__label">Draws</span>
      </div>
      <div class="fx-h2h-tile fx-h2h-tile--b">
        <span class="fx-h2h-tile__value">${record.bWins}</span>
        <span class="fx-h2h-tile__label">${esc(teamB.name)} wins</span>
      </div>
      <div class="fx-h2h-tile">
        <span class="fx-h2h-tile__value">${record.goalsA}<em>–</em>${record.goalsB}</span>
        <span class="fx-h2h-tile__label">Goals (aggregate)</span>
      </div>
      <div class="fx-h2h-tile">
        <span class="fx-h2h-tile__value">${record.avgGoals.toFixed(2)}</span>
        <span class="fx-h2h-tile__label">Avg goals / game</span>
      </div>
    </div>

    <div class="fx-h2h-trend">
      <span class="fx-h2h-trend__label">Run of results</span>
      ${pips(record.trend)}
      <span class="fx-h2h-trend__note">read from ${esc(teamA.name)}’s perspective, oldest first</span>
    </div>

    <div class="fx-two-col">
      <section class="fx-col">
        <h3 class="fx-col__title">
          Venue split
          <span class="fx-col__count">${esc(teamA.shortName)}’s record by where it was played</span>
        </h3>
        <div class="fx-table-wrap">
          <table class="fx-table">
            <thead>
              <tr>
                <th scope="col">Venue</th>
                <th scope="col" class="fx-league__num">Pl</th>
                <th scope="col" class="fx-league__num">W</th>
                <th scope="col" class="fx-league__num">D</th>
                <th scope="col" class="fx-league__num">L</th>
                <th scope="col" class="fx-league__num">GF</th>
                <th scope="col" class="fx-league__num">GA</th>
              </tr>
            </thead>
            <tbody>
              ${[['At home', aHome], ['Away', aAway]].map(([label, v]) => `
                <tr>
                  <th scope="row">${esc(label)}</th>
                  <td class="fx-league__num">${v.played}</td>
                  <td class="fx-league__num">${v.wins}</td>
                  <td class="fx-league__num">${v.draws}</td>
                  <td class="fx-league__num">${v.losses}</td>
                  <td class="fx-league__num">${v.goalsFor}</td>
                  <td class="fx-league__num">${v.goalsAgainst}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>

      <section class="fx-col">
        <h3 class="fx-col__title">Notable</h3>
        <ul class="fx-notable">
          <li class="fx-notable__item">
            <span class="fx-notable__label">Current run</span>
            <span class="fx-notable__value">${esc(streakText(record.streak, teamA, teamB))}</span>
          </li>
          <li class="fx-notable__item">
            <span class="fx-notable__label">${esc(teamA.shortName)}’s best</span>
            <span class="fx-notable__value">${esc(marginText(record.biggestA) ?? 'No win on record')}</span>
          </li>
          <li class="fx-notable__item">
            <span class="fx-notable__label">${esc(teamB.shortName)}’s best</span>
            <span class="fx-notable__value">${
              record.biggestB
                ? esc(`${record.biggestB.goalsAgainstA}–${record.biggestB.goalsForA}`
                    + ` ${record.biggestB.aWasHome ? 'away' : 'at home'},`
                    + ` ${record.biggestB.season ?? fmtDateShort(record.biggestB.date)}`)
                : 'No win on record'}</span>
          </li>
          <li class="fx-notable__item">
            <span class="fx-notable__label">League points taken</span>
            <span class="fx-notable__value">${esc(teamA.shortName)} ${record.pointsA},
              ${esc(teamB.shortName)} ${record.pointsB} <em>of ${record.played * 3} each</em></span>
          </li>
        </ul>
      </section>
    </div>

    <div class="fx-table-wrap">
      <table class="fx-table">
        <thead>
          <tr>${H2H_COLUMNS.map(c => `<th scope="col">${esc(c.label)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${meetings.slice().reverse().map(m => h2hRowHtml(m, teamA, teamB)).join('')}
        </tbody>
      </table>
    </div>

    <p class="fx-detail__note">
      ${capped
        ? `Their ${H2H_MEETING_WINDOW} most recent league meetings; ${
            onRecord.length - meetings.length} older ${
            onRecord.length - meetings.length === 1 ? 'meeting is' : 'meetings are'} on record but not shown.`
        : record.played === 1
          ? `Their only league meeting on record — the search reaches back ${seasonsLoaded} ${
              seasonsLoaded === 1 ? 'season' : 'seasons'}, and these two have not met more often in this division.`
          : `All ${record.played} league meetings these two have on record — the search reaches back ${seasonsLoaded} ${
              seasonsLoaded === 1 ? 'season' : 'seasons'}, and they have not met more often in this division.`}
      The window is a fixed count of meetings rather than a fixed number of
      seasons, so it means the same thing for every pairing and does not shrink
      each August. Sourced from Understat's full-league fixture lists, merged
      with this season's FPL results — each pairing appears once per venue per
      season, so a match carried by both feeds is counted once. Cups and
      play-offs are in neither feed. Venue, form and the run are all read from
      ${esc(teamA.name)}’s end; swap the two to mirror them.
    </p>
  `;
}

// ─── Pickers ──────────────────────────────────────────────────────────────────

/**
 * Fill all three team pickers from the real squad list. Called on every
 * data:ready rather than once at init, because the teams only exist after the
 * first fetch — and re-applies the current selection, so a re-emit (an
 * Understat payload landing) can't silently reset a picker the user has set.
 */
function populateTeamSelects() {
  const teams = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
  const options = teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');

  const selects = [
    ['fx-team-select', 'Select a team…', _teamId],
    ['fx-h2h-a',       'Team A…',        _h2hA],
    ['fx-h2h-b',       'Team B…',        _h2hB],
  ];

  for (const [id, placeholder, selected] of selects) {
    const sel = _root.querySelector(`#${id}`);
    if (!sel) continue;
    sel.innerHTML = `<option value="">${esc(placeholder)}</option>${options}`;
    sel.value = selected === null ? '' : String(selected);
  }
}

/** The single mutation point for the By team selection. */
function selectTeam(teamId) {
  _teamId = Number.isInteger(teamId) ? teamId : null;
  const sel = _root.querySelector('#fx-team-select');
  if (sel) sel.value = _teamId === null ? '' : String(_teamId);
  renderTeamPane();
}

/** The single mutation point for the Head-to-head pairing. */
function selectH2h(teamAId, teamBId) {
  _h2hA = Number.isInteger(teamAId) ? teamAId : null;
  _h2hB = Number.isInteger(teamBId) ? teamBId : null;

  const selA = _root.querySelector('#fx-h2h-a');
  const selB = _root.querySelector('#fx-h2h-b');
  if (selA) selA.value = _h2hA === null ? '' : String(_h2hA);
  if (selB) selB.value = _h2hB === null ? '' : String(_h2hB);

  renderH2hPane();
}

/** '' (the placeholder option) means "no selection", not team 0. */
function selectedId(id) {
  const value = _root.querySelector(`#${id}`)?.value ?? '';
  return value === '' ? null : Number(value);
}

/**
 * Seed both panes so they open onto something real rather than a prompt.
 *
 * The first fixture of the current gameweek supplies all three selections —
 * one rule, both panes, and it is always available the moment data lands. Runs
 * once: a later re-emit must not yank the user back off a club they chose.
 */
function seedSelections() {
  if (_teamId !== null && _h2hA !== null) return;

  const gw = homeGw();
  const fixtures = store.getFixtures();
  const first = fixtures.find(f => f.gw === gw) ?? fixtures[0] ?? null;
  if (!first) return;

  if (_teamId === null) _teamId = first.homeTeamId;
  if (_h2hA === null) {
    _h2hA = first.homeTeamId;
    _h2hB = first.awayTeamId;
  }
}

// ─── Mode switching ───────────────────────────────────────────────────────────

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  _mode = mode;

  for (const key of MODES) {
    _panes[key]?.classList.toggle('is-active', key === mode);
    // `hidden` wins over any display rule — see the [hidden] rule in base.css.
    if (_pickers[key]) _pickers[key].hidden = key !== mode;
  }

  _modeBtns.forEach(btn => {
    const active = btn.dataset.fxMode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onModeClick(e) {
  const btn = e.target.closest('.fx-modes__btn');
  if (btn) setMode(btn.dataset.fxMode);
}

/**
 * Cross-links between the panes, delegated on _panesWrap (stable across
 * renders) rather than per-element — every row and disclosure is rebuilt on
 * each render.
 *
 * A link carries its target selection in data attributes, so following one
 * lands on the pairing or club you clicked rather than on whatever the pane
 * happened to be showing. A link WITHOUT them just switches pane.
 */
function onPanesClick(e) {
  const toH2h = e.target.closest('[data-fx-open-h2h]');
  if (toH2h) {
    const a = Number(toH2h.dataset.teamA);
    const b = Number(toH2h.dataset.teamB);
    if (Number.isInteger(a) && Number.isInteger(b)) selectH2h(a, b);
    setMode('h2h');
    return;
  }

  const toTeam = e.target.closest('[data-fx-open-team]');
  if (toTeam) {
    const id = Number(toTeam.dataset.teamId);
    if (Number.isInteger(id)) selectTeam(id);
    setMode('team');
  }
}

/**
 * Opening a fixture is what triggers its GW's live fetch — the payload is
 * needed by nothing else, so nothing pays for it until a user asks.
 */
function onPanesToggle(e) {
  const details = e.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('fx-fixture')) return;

  const id = Number(details.dataset.fixtureId);
  if (details.open) _openFixtures.add(id); else _openFixtures.delete(id);

  const fixture = store.getFixture(id);
  if (details.open && fixture && statusOf(fixture) !== 'upcoming') {
    ensureLive(fixture.gw);
    ensureTimeline(fixture);
  }
}

function onGwStep(e) {
  const btn = e.target.closest('[data-fx-gw]');
  if (!btn || btn.disabled) return;

  const home = homeGw();
  const next = btn.dataset.fxGw === 'prev' ? _gw - 1
             : btn.dataset.fxGw === 'next' ? _gw + 1
             : home;

  const clamped = Math.min(LAST_GW, Math.max(FIRST_GW, next));
  if (clamped === _gw) return;

  _gw = clamped;
  _openFixtures.clear();   // ids don't carry across gameweeks
  renderGameweekPane();
}

/** The whole H2H view is read from team A's end, so swapping mirrors it. */
function onSwapClick() {
  selectH2h(_h2hB, _h2hA);
}

function onTeamSelectChange() {
  selectTeam(selectedId('fx-team-select'));
}

function onH2hSelectChange() {
  selectH2h(selectedId('fx-h2h-a'), selectedId('fx-h2h-b'));
}

function onScopeClick(e) {
  const btn = e.target.closest('.fx-scope__btn');
  if (!btn) return;

  _root.querySelectorAll('.fx-scope__btn').forEach(b => {
    const active = b === btn;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });

  _scope = btn.dataset.fxScope;
  renderTablePane();
}

/**
 * Season data has landed, or been re-emitted as an enrichment arrives (main.js
 * re-fires data:ready when each Understat payload lands, which is what brings
 * the cross-season half of the H2H record into view).
 *
 * The opening gameweek and the seeded selections are picked the FIRST TIME
 * only, so a re-emit can't yank the user back off a GW they stepped to or a
 * club they chose.
 */
/**
 * Set when data changed while Fixtures was off screen, so activation knows it
 * owes a render. See onRouteChanged.
 */
let _pendingRender = false;

function onDataReady() {
  if (_gw === null) _gw = homeGw();
  seedSelections();
  populateTeamSelects();

  // Seeding above is cheap and leaves the selects correct for whenever this
  // tab is next opened. The four panes below each rebuild real markup — the
  // H2H pane alone walks several seasons of meetings — so skip them while
  // hidden. See store.js's activeModule note.
  if (store.getActiveModule() !== 'fixtures') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;

  renderGameweekPane();
  renderTablePane();
  renderTeamPane();
  renderH2hPane();
}

/** Flush a render deferred while off screen, once Fixtures is shown. */
function onRouteChanged(module) {
  if (module !== 'fixtures' || !_pendingRender) return;
  _pendingRender = false;
  renderGameweekPane();
  renderTablePane();
  renderTeamPane();
  renderH2hPane();
}

/** A GW's live payload landed — only the gameweek pane reads it. */
function onLiveUpdated() {
  renderGameweekPane();
}

/** One fixture's Understat match detail landed (events + lineups). */
function onMatchUpdated() {
  renderGameweekPane();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initFixtures() {
  _root = document.querySelector('[data-module="fixtures"]');
  if (!_root) return;

  _panesWrap = _root.querySelector('.fx-panes');
  _modeBtns  = Array.from(_root.querySelectorAll('.fx-modes__btn'));

  for (const key of MODES) {
    _panes[key]   = _root.querySelector(`[data-fx-pane="${key}"]`);
    _pickers[key] = _root.querySelector(`[data-fx-picker="${key}"]`);
  }

  // Every pane now waits on data, so the only thing to draw before it lands is
  // each pane's loading state — onDataReady rebuilds all four.
  renderTeamPane();
  renderH2hPane();

  store.subscribe('data:ready',   onDataReady);
  store.subscribe('route:changed', onRouteChanged);
  store.subscribe('live:updated', onLiveUpdated);
  store.subscribe('match:updated', onMatchUpdated);

  _root.querySelector('.fx-modes')?.addEventListener('click', onModeClick);
  _root.querySelector('.fx-controls')?.addEventListener('click', onGwStep);
  _root.querySelector('.fx-scope')?.addEventListener('click', onScopeClick);

  _panesWrap?.addEventListener('click', onPanesClick);
  // `toggle` doesn't bubble, so delegation needs the capture phase.
  _panesWrap?.addEventListener('toggle', onPanesToggle, true);

  _root.querySelector('#fx-team-select')?.addEventListener('change', onTeamSelectChange);
  _root.querySelector('#fx-h2h-a')?.addEventListener('change', onH2hSelectChange);
  _root.querySelector('#fx-h2h-b')?.addEventListener('change', onH2hSelectChange);
  _root.querySelector('#fx-h2h-swap')?.addEventListener('click', onSwapClick);

  setMode('gameweek');

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
