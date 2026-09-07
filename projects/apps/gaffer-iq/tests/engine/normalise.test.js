/**
 * tests/engine/normalise.test.js
 * Unit tests for engine/normalise.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseFixture, deriveUpcomingGw, deriveEventCompletion,
} from '../../js/engine/normalise.js';

test('normaliseFixture flags a provisional kickoff time', () => {
  // FPL sets provisional_start_time while a kickoff is unconfirmed — often the
  // precursor to a postponement, so it must survive normalisation.
  const f = normaliseFixture({
    id: 1, event: 24, team_h: 1, team_a: 2, provisional_start_time: true,
  });
  assert.equal(f.provisionalKickoff, true);
});

test('normaliseFixture treats a missing provisional flag as confirmed', () => {
  // Absent means confirmed, not unknown — FPL only sets the field when the
  // kickoff is actually in doubt.
  const f = normaliseFixture({ id: 1, event: 24, team_h: 1, team_a: 2 });
  assert.equal(f.provisionalKickoff, false);
});

test('normaliseFixture keeps a null event as a null gw', () => {
  // A postponed fixture awaiting a rearranged date. normaliseSeason routes
  // these into pendingFixtures; the guard that keeps them out of aggregation
  // keys off exactly this null.
  const f = normaliseFixture({ id: 1, event: null, team_h: 1, team_a: 2 });
  assert.equal(f.gw, null);
});

// ─── deriveUpcomingGw ─────────────────────────────────────────────────────────

test('deriveUpcomingGw moves past a current gameweek that has finished', () => {
  // THE DEFECT. FPL keeps is_current on a round from its own deadline until
  // the NEXT round's deadline, so for the days between a Sunday full-time and
  // the following Friday, is_current names a gameweek in which every match has
  // been played. Forward-looking views anchored on it (Ranker horizon, Full
  // Season strip) therefore offered a finished round as the next matchup.
  const events = [
    { id: 1, finished: true,  isCurrent: false, isNext: false },
    { id: 2, finished: true,  isCurrent: true,  isNext: false },
    { id: 3, finished: false, isCurrent: false, isNext: true  },
  ];
  assert.equal(deriveUpcomingGw(events), 3);
});

test('deriveUpcomingGw stays on a current gameweek still being played', () => {
  // Mid-round the current gameweek IS the upcoming one — there is football
  // left in it, and its remaining fixtures still belong in a horizon.
  const events = [
    { id: 2, finished: false, isCurrent: true, isNext: false },
    { id: 3, finished: false, isCurrent: false, isNext: true },
  ];
  assert.equal(deriveUpcomingGw(events), 2);
});

test('deriveUpcomingGw uses the next gameweek before the season starts', () => {
  // Pre-season: FPL flags no current round at all.
  const events = [
    { id: 1, finished: false, isCurrent: false, isNext: true },
  ];
  assert.equal(deriveUpcomingGw(events), 1);
});

test('deriveUpcomingGw steps past the last finished gameweek of the season', () => {
  // After GW38 is_next is null, and answering 38 would present a completed
  // season as still to come. One past the end is the honest answer: every
  // gameweek reads as played and every horizon comes back empty.
  const events = [
    { id: 38, finished: true, isCurrent: true, isNext: false },
  ];
  assert.equal(deriveUpcomingGw(events), 39);
});

test('deriveUpcomingGw falls back to gameweek 1 with no events at all', () => {
  assert.equal(deriveUpcomingGw([]), 1);
});

// ─── deriveEventCompletion ────────────────────────────────────────────────────

test('deriveEventCompletion marks a round complete once every match has been played', () => {
  // THE DEFECT. FPL's event.finished waits for BONUS CONFIRMATION, not full
  // time — on 2026-09-07 all ten GW3 matches read finished_provisional with
  // event 3 still finished:false. The rails, which read fixture-level `played`,
  // had already moved to GW4 while the Full Season strip and the Outlook
  // window, anchored on the event flag, were still offering GW3.
  const events   = [{ id: 3, finished: false, isCurrent: true, isNext: false }];
  const fixtures = [
    { id: 1, gw: 3, played: true },
    { id: 2, gw: 3, played: true },
  ];
  assert.deepEqual(deriveEventCompletion(events, fixtures), [
    { id: 3, finished: false, isCurrent: true, isNext: false, complete: true },
  ]);
});

test('deriveEventCompletion leaves a round with football still to come incomplete', () => {
  const events   = [{ id: 3, finished: false, isCurrent: true, isNext: false }];
  const fixtures = [
    { id: 1, gw: 3, played: true },
    { id: 2, gw: 3, played: false },
  ];
  assert.equal(deriveEventCompletion(events, fixtures)[0].complete, false);
});

test('deriveEventCompletion ignores postponed fixtures with no gameweek', () => {
  // gw === null is a fixture awaiting a rearranged date. It is not a pending
  // result for any round, so it must not hold one open.
  const events   = [{ id: 3, finished: false, isCurrent: true, isNext: false }];
  const fixtures = [
    { id: 1, gw: 3,    played: true },
    { id: 2, gw: null, played: false },
  ];
  assert.equal(deriveEventCompletion(events, fixtures)[0].complete, true);
});

test('deriveEventCompletion falls back to the raw flag for a round with no fixtures', () => {
  // An empty every() is true, which would report a round nobody has played as
  // finished — e.g. before the fixtures payload lands.
  const events = [
    { id: 3, finished: false, isCurrent: true,  isNext: false },
    { id: 2, finished: true,  isCurrent: false, isNext: false },
  ];
  const done = deriveEventCompletion(events, []);
  assert.equal(done[0].complete, false);
  assert.equal(done[1].complete, true);
});

test('deriveUpcomingGw moves past a current gameweek whose matches are all played', () => {
  // The event flag says otherwise; the fixtures are the authority.
  const events = deriveEventCompletion(
    [
      { id: 3, finished: false, isCurrent: true,  isNext: false },
      { id: 4, finished: false, isCurrent: false, isNext: true  },
    ],
    [{ id: 1, gw: 3, played: true }, { id: 2, gw: 4, played: false }],
  );
  assert.equal(deriveUpcomingGw(events), 4);
});
