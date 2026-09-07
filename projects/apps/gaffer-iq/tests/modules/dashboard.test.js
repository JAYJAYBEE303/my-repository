/**
 * tests/modules/dashboard.test.js
 * Pure-function tests only (CONVENTIONS §3.3) — buildFixtureContextLabel takes
 * a score and returns a string, with no DOM or store involvement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFixtureContextLabel } from '../../js/modules/dashboard.js';

test('buildFixtureContextLabel names a single fixture', () => {
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 24, opponent: 'ARS', venue: 'H', isBlank: false },
  ] });
  assert.equal(label, 'GW24 vs ARS (H)');
});

test('buildFixtureContextLabel names BOTH fixtures of a double', () => {
  // The defect: this read perGw[0] and silently dropped the second fixture, so
  // the line a user opens to sanity-check a captaincy pick told half the truth
  // on exactly the gameweek where captaincy matters most.
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 24, opponent: 'EVE', venue: 'H', isBlank: false },
    { gw: 24, opponent: 'SHU', venue: 'A', isBlank: false },
  ] });
  assert.equal(label, 'GW24 (double) vs EVE (H), SHU (A)');
});

test('buildFixtureContextLabel marks a blank gameweek', () => {
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 26, opponent: null, venue: null, isBlank: true },
  ] });
  assert.equal(label, 'GW26 — Blank');
});

test('buildFixtureContextLabel falls back when there is no fixture data', () => {
  // A team with no ctx entry — must not throw, and must not claim a gameweek
  // it does not know about.
  assert.equal(typeof buildFixtureContextLabel({ perGw: [] }), 'string');
  assert.equal(typeof buildFixtureContextLabel({}), 'string');
  assert.equal(typeof buildFixtureContextLabel(null), 'string');
});

test('buildFixtureContextLabel names the window when the horizon spans several GWs', () => {
  // Since the Dashboard came off its GW1 lock the chip beside this line reads a
  // multi-gameweek score, so naming one fixture and stopping would repeat the
  // half-truth the double-gameweek case above was fixed for.
  const label = buildFixtureContextLabel(
    { perGw: [{ gw: 4, opponent: 'COV', venue: 'H', isBlank: false }] },
    { label: 'Next 5 GWs', gws: 5 },
  );
  assert.equal(label, 'GW4 vs COV (H) · Next 5 GWs');
});

test('buildFixtureContextLabel names the window on a blank too', () => {
  // The blank is the case that most needs it: a player can now be picked to
  // start a gameweek he blanks, on the strength of the four behind it.
  const label = buildFixtureContextLabel(
    { perGw: [{ gw: 4, opponent: null, venue: null, isBlank: true }] },
    { label: 'Next 5 GWs', gws: 5 },
  );
  assert.equal(label, 'GW4 — Blank · Next 5 GWs');
});

test('buildFixtureContextLabel adds no window suffix on a one-GW horizon', () => {
  const label = buildFixtureContextLabel(
    { perGw: [{ gw: 4, opponent: 'COV', venue: 'H', isBlank: false }] },
    { label: 'This GW', gws: 1 },
  );
  assert.equal(label, 'GW4 vs COV (H)');
});
