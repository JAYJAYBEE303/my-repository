/**
 * tests/engine/transfers.test.js
 * Unit tests for engine/transfers.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enumerateSwaps, calcSquadFlexibility } from '../../js/engine/transfers.js';
import { FUNDS_MIN_CASH_FREED, FUTURE_WINDOW_GWS, HIT_PENALTY } from '../../js/config.js';

/**
 * A stub scoring context. enumerateSwaps calls scorePlayer, which needs a real
 * ctx, so these tests inject a scorer through opts.scorePlayerFn instead — the
 * seam that keeps this module unit-testable without a full season payload.
 */
function stubCtx() {
  return { currentGw: 10, teamsById: {}, playerSummariesById: {} };
}

function player(id, position, price, ep = 0) {
  return { id, position, price, ep, name: `P${id}`, teamId: 1, status: 'available' };
}

/**
 * Deterministic scorer. Expected points are declared on the player itself so
 * each test can state plainly who starts and who does not — deriving them from
 * the id would make the fixtures say the opposite of what the test names claim.
 */
function stubScorer(p) {
  return {
    value: 50,
    band: 'neutral',
    perGw: [],
    breakdown: { playtime: { value: 0.9 }, minutes: {}, form: {}, fixture: {}, counter: {} },
    expectedPoints: { value: p.ep ?? 0, estimated: false },
    avgPointsPerGw: { value: p.ep ?? 0, estimated: false },
    nextFixtureScore: { value: 50, estimated: false },
  };
}

/**
 * A legal 15. Given these expected points the projected XI is
 * [1, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14] and the bench is [8, 7, 15, 2] —
 * so player 8 is the weakest midfielder and sits on the bench, and player 12
 * is the squad's best player and a certain starter.
 */
function squadOf15() {
  return [
    player(1, 'GKP', 4.5, 3.0), player(2, 'GKP', 4.0, 1.0),
    player(3, 'DEF', 6.0, 5.5), player(4, 'DEF', 5.5, 5.0), player(5, 'DEF', 5.0, 4.5),
    player(6, 'DEF', 4.5, 1.5), player(7, 'DEF', 4.0, 1.0),
    player(8, 'MID', 5.0, 1.2), player(9, 'MID', 8.0, 6.0), player(10, 'MID', 7.0, 7.0),
    player(11, 'MID', 6.0, 6.5), player(12, 'MID', 12.0, 9.0),
    player(13, 'FWD', 9.0, 8.0), player(14, 'FWD', 7.0, 5.0), player(15, 'FWD', 4.5, 0.8),
  ];
}

test('enumerateSwaps only proposes same-position swaps', () => {
  const squad = squadOf15();
  const candidates = [player(100, 'MID', 7.0, 6.0), player(101, 'FWD', 7.0, 6.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  for (const swap of swaps) {
    assert.equal(swap.outPlayer.position, swap.inPlayer.position);
  }
});

test('enumerateSwaps excludes candidates that break the budget', () => {
  const squad = squadOf15();
  // 20.0m in for any midfielder in this squad breaks a 1.0m budget.
  const candidates = [player(102, 'MID', 20.0, 9.0)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 1.0, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  assert.equal(swaps.some(s => s.inId === 102), false);
});

test('a bench-for-bench swap scores near zero on the Now lane', () => {
  const squad = squadOf15();
  // Player 8 is the weakest midfielder and sits on the bench. Candidate 20 is
  // barely better and would also sit on the bench.
  const candidates = [player(20, 'MID', 5.0, 1.5)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  const benchSwap = swaps.find(s => s.outId === 8 && s.inId === 20);
  assert.ok(benchSwap, 'the bench swap is enumerated');
  assert.ok(Math.abs(benchSwap.longXiDelta) < 1.0,
    `bench churn must be near zero, got ${benchSwap.longXiDelta}`);
});

test('a swap that promotes a player into the XI beats bench churn', () => {
  const squad = squadOf15();
  const candidates = [player(20, 'MID', 5.0, 1.5), player(40, 'MID', 6.0, 7.5)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  const churn   = swaps.find(s => s.outId === 8 && s.inId === 20);
  const upgrade = swaps.find(s => s.outId === 8 && s.inId === 40);
  assert.ok(upgrade.longXiDelta > churn.longXiDelta,
    'the XI-reaching move must rank above the bench move');
});

test('enumerateSwaps flags whether the outgoing player was in the XI', () => {
  const squad = squadOf15();
  const candidates = [player(20, 'MID', 5.0, 1.5)];
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, ...candidates], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  const fromBench = swaps.find(s => s.outId === 8);
  const fromXi    = swaps.find(s => s.outId === 12);
  assert.equal(fromBench.flags.outInXi, false);
  assert.equal(fromXi.flags.outInXi, true);
});

test('enumerateSwaps returns an empty array for an incomplete squad', () => {
  const squad = squadOf15().slice(0, 10);
  const swaps = enumerateSwaps(squad.map(p => p.id), squad, stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  assert.deepEqual(swaps, []);
});

test('calcSquadFlexibility scores a price-clumped squad below a spread one', () => {
  const clumped = Array.from({ length: 15 }, (_, i) => player(i + 1, 'MID', 7.0));
  const spread  = Array.from({ length: 15 }, (_, i) => player(i + 1, 'MID', 4.0 + i * 0.7));
  const scores  = new Map(clumped.map(p => [p.id, stubScorer(p)]));
  const clumpedScore = calcSquadFlexibility(clumped, scores).value;
  const spreadScore  = calcSquadFlexibility(spread,  scores).value;
  assert.ok(spreadScore > clumpedScore,
    `spread ${spreadScore} should beat clumped ${clumpedScore}`);
});

test('calcSquadFlexibility stays within 0-100', () => {
  const squad  = squadOf15();
  const scores = new Map(squad.map(p => [p.id, stubScorer(p)]));
  const result = calcSquadFlexibility(squad, scores);
  assert.ok(result.value >= 0 && result.value <= 100, `got ${result.value}`);
});

test('the Future lane ranks by raw deferred-window value, not by swing', () => {
  // Deliberately adversarial fixture: the candidate with the WEAKER deferred
  // window has the LARGER swing. Under the old swing ranking it won; under the
  // window-total ranking it must lose. The swing assertion below is part of the
  // test — without it a fixture that stopped discriminating would pass silently.
  const squad = squadOf15();
  const bigRun   = player(32, 'MID', 7.0, 0);   // strong now, stronger later
  const bigSwing = player(33, 'MID', 7.0, 0);   // poor now, middling later
  const epFor = (id, isFar) => {
    if (id === 32) return isFar ? 9.0 : 7.0;
    if (id === 33) return isFar ? 4.0 : 0.5;
    return null;
  };
  const scorer = (p, horizon) => {
    const ep = epFor(p.id, horizon.label === 'Future');
    if (ep === null) return stubScorer(p);
    return { ...stubScorer(p), expectedPoints: { value: ep, estimated: false } };
  };
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, bigRun, bigSwing], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: scorer,
  });
  const runSwap   = swaps.find(s => s.inId === 32 && s.outId === 8);
  const swingSwap = swaps.find(s => s.inId === 33 && s.outId === 8);

  const runSwing   = runSwap.farXiDelta   - runSwap.longXiDelta;
  const swingSwing = swingSwap.farXiDelta - swingSwap.longXiDelta;
  assert.ok(swingSwing > runSwing,
    `fixture must be adversarial: swings ${swingSwing} vs ${runSwing}`);

  assert.ok(runSwap.lanes.future.value > swingSwap.lanes.future.value,
    'the stronger deferred run must win, even though it swings less');
});

test('the Future lane reports a window total over FUTURE_WINDOW_GWS gameweeks', () => {
  const squad = squadOf15();
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 6.0, 7.5)], stubCtx(), {
    horizon: { label: 'test', gws: 5 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  const swap = swaps.find(s => s.outId === 8 && s.inId === 40);
  assert.equal(swap.windowGws.far, FUTURE_WINDOW_GWS);
  assert.ok(Math.abs(swap.lanes.future.value - swap.farXiDelta * FUTURE_WINDOW_GWS) < 1e-9,
    'the Future value is its per-GW delta times the deferred window length');
});

test('the deferred window starts FUTURE_WINDOW_START gameweeks after the current one', () => {
  // The three windows are identified by the (label, gws, currentGw) triple each
  // scoring pass is handed. Asserting on them is what pins "GWs 3-5 ahead" to
  // an actual offset rather than to a comment.
  const squad = squadOf15();
  const seen = new Set();
  const scorer = (p, horizon, ctx) => {
    seen.add(`${horizon.label}:${horizon.gws}:${ctx.currentGw}`);
    return stubScorer(p);
  };
  enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 6.0, 7.5)], stubCtx(), {
    horizon: { label: 'test', gws: 5 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: scorer,
  });
  // stubCtx()'s currentGw is 10, so the deferred window runs GW12-GW14 — the
  // 3rd, 4th and 5th upcoming gameweeks.
  assert.ok(seen.has('test:5:10'),  `long window missing, saw ${[...seen]}`);
  assert.ok(seen.has('Now:1:10'),   `now window missing, saw ${[...seen]}`);
  assert.ok(seen.has('Future:3:12'), `far window missing, saw ${[...seen]}`);
});

test('Now and Long term diverge for a one-week spike', () => {
  const squad = squadOf15();
  const spike  = player(34, 'MID', 7.0, 0);  // huge next GW, poor across five
  const steady = player(35, 'MID', 7.0, 0);  // same every week
  const scorer = (p, horizon) => {
    const isNow = horizon.label === 'Now';
    if (p.id === 34) return { ...stubScorer(p), expectedPoints: { value: isNow ? 12.0 : 2.0, estimated: false } };
    if (p.id === 35) return { ...stubScorer(p), expectedPoints: { value: 7.0, estimated: false } };
    return stubScorer(p);
  };
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, spike, steady], stubCtx(), {
    horizon: { label: 'test', gws: 5 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: scorer,
  });
  const spikeSwap  = swaps.find(s => s.inId === 34 && s.outId === 8);
  const steadySwap = swaps.find(s => s.inId === 35 && s.outId === 8);

  assert.ok(spikeSwap.lanes.now.value > steadySwap.lanes.now.value,
    'the spike must win the single-gameweek board');
  assert.ok(steadySwap.lanes.longterm.value > spikeSwap.lanes.longterm.value,
    'the steady player must win the five-gameweek board');
});

test('lane values are window totals and the hit is charged once, not per gameweek', () => {
  const squad = squadOf15();
  // freeTransfers 0 makes hitCost real, which is the only state that can expose
  // a hit being scaled by the window alongside the delta.
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 6.0, 7.5)], stubCtx(), {
    horizon: { label: 'test', gws: 5 }, budget: 5, freeTransfers: 0,
    scorePlayerFn: stubScorer,
  });
  const swap = swaps.find(s => s.outId === 8 && s.inId === 40);
  assert.equal(swap.windowGws.long, 5);
  assert.equal(swap.windowGws.now, 1);

  const expectedLong = (swap.longXiDelta * 5) - HIT_PENALTY;
  const expectedNow  = (swap.now1XiDelta * 1) - HIT_PENALTY;
  assert.ok(Math.abs(swap.lanes.longterm.value - expectedLong) < 1e-9,
    `long term ${swap.lanes.longterm.value} should be ${expectedLong}`);
  assert.ok(Math.abs(swap.lanes.now.value - expectedNow) < 1e-9,
    `now ${swap.lanes.now.value} should be ${expectedNow}`);
});

// ─── Funds & Flexibility ─────────────────────────────────────────────────────

/** Enumerate against one extra candidate and return that swap out of player 12
 *  (a 12.0m certain starter, so every candidate below is a genuine downgrade in
 *  price and the lane's gate is the only thing filtering). */
function fundsSwapFor(candidate, outId = 12) {
  const squad = squadOf15();
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, candidate], stubCtx(), {
    horizon: { label: 'test', gws: 5 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  const swap = swaps.find(s => s.outId === outId && s.inId === candidate.id);
  assert.ok(swap, `the swap ${outId} -> ${candidate.id} is enumerated`);
  return swap;
}

test('the Funds lane scores zero for a same-price move, however good', () => {
  // The reported bug: a sideways move that freed nothing was topping the board.
  const swap = fundsSwapFor(player(50, 'MID', 12.0, 11.0));
  assert.equal(swap.priceDiff, 0);
  assert.ok(swap.longXiDelta > 0, 'fixture must be a genuine points upgrade');
  assert.equal(swap.lanes.funds.value, 0,
    'freeing no money means no place on the Funds board');
});

test('the Funds lane scores zero for a more expensive move', () => {
  const swap = fundsSwapFor(player(51, 'MID', 14.0, 11.0));
  assert.ok(swap.priceDiff > 0);
  assert.equal(swap.lanes.funds.value, 0);
});

test('the Funds lane scores zero for a saving below FUNDS_MIN_CASH_FREED', () => {
  const swap = fundsSwapFor(player(52, 'MID', 11.9, 11.0));
  const cashFreed = -swap.priceDiff;
  assert.ok(cashFreed > 0 && cashFreed < FUNDS_MIN_CASH_FREED,
    `fixture frees ${cashFreed}, which must sit under the floor`);
  assert.equal(swap.lanes.funds.value, 0,
    'a saving too small to plan around must not inflate the ratio');
});

test('the Funds lane ranks by points per pound, not by the size of the saving', () => {
  // Efficient: frees 1.0m for a big gain. Wasteful: frees 4.0m for a token one.
  const efficient = fundsSwapFor(player(53, 'MID', 11.0, 11.0));
  const wasteful  = fundsSwapFor(player(54, 'MID',  8.0,  9.2));
  assert.ok(-wasteful.priceDiff > -efficient.priceDiff,
    'fixture must give the WEAKER move the LARGER saving');
  assert.ok(efficient.lanes.funds.value > wasteful.lanes.funds.value,
    'the better points-per-pound move must rank first despite saving less');
});

test('the Funds lane scores a cheaper-but-worse move negative, so the board drops it', () => {
  const swap = fundsSwapFor(player(55, 'MID', 8.0, 1.0));
  assert.ok(-swap.priceDiff >= FUNDS_MIN_CASH_FREED, 'fixture clears the cash floor');
  assert.ok(swap.longXiDelta < 0, 'fixture must lose points');
  assert.ok(swap.lanes.funds.value < 0,
    'a downgrade in points must score below the board\'s value > 0 row filter');
});

test('the Funds lane still reports flexibility in components for the why-panel', () => {
  // calcSquadFlexibility no longer ranks this lane but must not have been
  // orphaned — strategy.js's cashCrunch trigger and the why-panel both read it.
  const swap = fundsSwapFor(player(56, 'MID', 11.0, 11.0));
  assert.ok(Number.isFinite(swap.lanes.funds.components.flexGain));
  assert.ok(Number.isFinite(swap.lanes.funds.components.cashFreed));
  assert.ok(Number.isFinite(swap.lanes.funds.components.pointsGained));
});

test('the Structure lane stays silent when the outgoing player is fine', () => {
  const squad = squadOf15();
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 6.0, 7.5)], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  // Every stub player is available with playtime 0.9 — nothing is broken.
  assert.ok(swaps.every(s => s.lanes.structure.value === 0),
    'a healthy squad produces no Structure Fix candidates');
});

test('the Structure lane fires for an unavailable XI player', () => {
  const squad = squadOf15();
  squad[11].status = 'injured';                      // player 12, a certain starter
  // stubScorer ignores `status`, so player 12 still projects its declared ep
  // (9.0) despite being injured — the repair only reads as a genuine gain if
  // the incoming player's ep (9.5) is HIGHER than that, giving a positive
  // longXiDelta for scoreStructureLane to scale into a window total and report.
  const swaps = enumerateSwaps(squad.map(p => p.id), [...squad, player(40, 'MID', 12.0, 9.5)], stubCtx(), {
    horizon: { label: 'test', gws: 3 }, budget: 5, freeTransfers: 1,
    scorePlayerFn: stubScorer,
  });
  const fix = swaps.find(s => s.outId === 12 && s.inId === 40);
  assert.ok(fix.lanes.structure.value > 0, 'an injured starter is a structure problem');
});
