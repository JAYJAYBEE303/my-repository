/**
 * js/engine/transfers.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * Enumerates every legal transfer for a squad and scores each one on six
 * independent lanes. One enumeration pass, not six: the lanes must be
 * comparable for engine/strategy.js to state a margin between them, and a
 * single pass over a shared spine is what makes that honest.
 *
 * The spine is engine/lineup.js. A swap's worth is the change in the squad's
 * projected XI expected points — which is why bench-for-bench churn scores
 * near zero here however large the composite gap between the two players is.
 *
 * THREE WINDOWS, not one. `calcXiExpectedPoints` returns a PER-GAMEWEEK figure
 * (composite.js's expectedPoints is per-gameweek; a horizon only ever fed its
 * fixture multiplier), so each lane multiplies its own window's delta by that
 * window's length to report a WINDOW TOTAL. Lane values are therefore NOT
 * comparable across boards as raw numbers — a Long term value is ~5x a Now
 * value for the same move — and each board's `unit` label names its span.
 * engine/strategy.js compares them only after normalising by LANE_SCALE_*,
 * whose divisors carry the same window factor.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md
 * and docs/superpowers/specs/2026-09-07-planner-horizon-split-and-value-funds-design.md,
 * which supersedes its §7.1 lane definitions for now/future/funds and its §8.
 */

import { scorePlayer as defaultScorePlayer, applyDgwUplift, calcExpectedPoints }
  from './composite.js';
import { pickStartingXI, calcXiExpectedPoints } from './lineup.js';
import { groupPerGwSlots } from './fixtures.js';
import { calcPriceChangeRisk } from './prices.js';
import { clamp } from '../util.js';
import {
  SQUAD_TOTAL, BENCH_SIZE, HIT_PENALTY, CANDIDATE_POOL_PER_POS,
  NOW_WINDOW_GWS, FUTURE_WINDOW_START, FUTURE_WINDOW_GWS, FUTURE_MIN_FAR_GAIN,
  FUNDS_MIN_CASH_FREED,
  FLEX_W_SPREAD, FLEX_W_HEADROOM, FLEX_CLUMP_BAND, FLEX_HEADROOM_TARGET,
  CEILING_W_PEAK, CEILING_W_HAUL, HAUL_POINTS_THRESHOLD,
  STRUCTURE_PLAYTIME_FLOOR,
} from '../config.js';

/**
 * Memoised scoring. The Planner re-renders on every budget keystroke, and a
 * naive implementation re-scores ~2,000 players each time; two windows would
 * double that. The cache is created per enumerateSwaps call and handed back to
 * the caller so it can survive across renders (see spec §11).
 */
function memoScore(cache, player, horizon, ctx, scoreFn) {
  const cached = cache.get(player.id);
  if (cached) return cached;
  let score;
  try {
    score = scoreFn(player, horizon, ctx);
  } catch (err) {
    // Not re-thrown: one unscoreable player must not fail the whole
    // enumeration (CONVENTIONS.md §9 requires this catch do SOMETHING,
    // not swallow silently — logging is that something). The caller-side
    // consequence is real, though: if this is a SQUAD member, longEntries
    // falls below SQUAD_TOTAL and enumerateSwaps returns [], which
    // upstream must not present as "no legal transfers" — see
    // modules/planner.js's renderBoards, which distinguishes that case
    // from a genuine empty enumeration using this warning as its signal.
    console.warn('[engine/transfers] scoreFn failed for player', player?.id, err?.message ?? err);
    return null;
  }
  cache.set(player.id, score);
  return score;
}

/**
 * Cheap, no-scoring proxy used only to SELECT which players are worth a full
 * composite score, never to rank them against each other for real. A rough
 * season-points-per-gameweek approximation — NOT the same computation as
 * `calcAvgPointsPerGw`, which prefers real per-GW summary history when it is
 * loaded and otherwise divides by `ctx.playedFixtures`, not `ctx.elapsedGws`.
 * This proxy is deliberately cruder: it exists purely to avoid a `scorePlayer`
 * call before the pool is narrowed, not to match the real average.
 *
 * MODEL: candidate SELECTION uses this cheap historical proxy; candidate
 * RANKING within every lane still runs the full composite via `scoreLong` /
 * `scoreFar`. A mis-ranked pre-filter therefore costs breadth (a good player
 * with a slow start might be excluded from the pool) rather than correctness
 * (nothing that DOES make the pool is ever ordered by this proxy).
 *
 * @param {Player} player
 * @param {object} ctx  from buildScoreContext(); reads ctx.elapsedGws
 * @returns {number}  points-per-gw scale, higher = better; falls back to raw
 *   season points (not a rate) when ctx.elapsedGws is unavailable
 */
function candidateProxyScore(player, ctx) {
  const points = player?.totals?.points ?? 0;
  const elapsedGws = ctx?.elapsedGws;
  if (typeof elapsedGws === 'number' && elapsedGws > 0) {
    return points / Math.max(1, elapsedGws);
  }
  // Fallback: elapsedGws not on this ctx (e.g. a stub in tests). Raw season
  // points is not a rate, but it is still a defensible relative ordering and
  // keeps the pre-filter functioning rather than throwing.
  return points;
}

/**
 * The top CANDIDATE_POOL_PER_POS players per position, excluding anyone
 * already in the squad.
 *
 * Selection is two-staged to stay affordable: first a cheap proxy
 * (`candidateProxyScore`, season points per elapsed gameweek — no
 * `scorePlayer` call) narrows ~626 players down to CANDIDATE_POOL_PER_POS per
 * position, THEN only that narrowed set is scored through the caller's
 * memoised `scoreLong` closure. Scoring the full pool first (as an earlier
 * version of this function did, via rankPlayers) was exactly the cost
 * CANDIDATE_POOL_PER_POS exists to avoid — see spec rationale below.
 *
 * MODEL: bounding the pool by rank rather than scoring all ~700 players is what
 * keeps the enumeration affordable. A transfer target outside the top 40 of its
 * position is not a recommendation this tool would ever make, so nothing of
 * value is lost — but the bound is config, not a hard-coded assumption.
 *
 * @param {Player[]} allPlayers   the full player pool
 * @param {number[]} squadIds     the user's 15 player ids, excluded from pools
 * @param {object}   ctx          from buildScoreContext(); read for elapsedGws
 * @param {(player: Player) => (object|null)} scoreLong  memoised long-window
 *   scorer; returns null (and the player is skipped) if scoring fails
 * @returns {Object<string, Player[]>}  keyed by position, each sorted by
 *   score.value descending
 */
function buildCandidatePools(allPlayers, squadIds, ctx, scoreLong) {
  const squadSet = new Set(squadIds);
  const pools = { GKP: [], DEF: [], MID: [], FWD: [] };
  const shortlisted = { GKP: [], DEF: [], MID: [], FWD: [] };

  for (const player of allPlayers) {
    const bucket = shortlisted[player?.position];
    if (!bucket || squadSet.has(player.id)) continue;
    bucket.push(player);
  }

  for (const pos of Object.keys(shortlisted)) {
    // Cheap proxy narrows the field first; price-descending breaks ties (a
    // pricier player at the same points rate is the stronger transfer target).
    shortlisted[pos].sort((a, b) => {
      const proxyDiff = candidateProxyScore(b, ctx) - candidateProxyScore(a, ctx);
      if (proxyDiff !== 0) return proxyDiff;
      return (b.price ?? 0) - (a.price ?? 0);
    });
    const shortlist = shortlisted[pos].slice(0, CANDIDATE_POOL_PER_POS);

    const scored = [];
    for (const player of shortlist) {
      const score = scoreLong(player);
      if (!score) continue;
      scored.push({ player, score });
    }
    scored.sort((a, b) => b.score.value - a.score.value);
    pools[pos] = scored.map(row => row.player);
  }
  return pools;
}

/** Replace one entry in a scored squad, returning a new array. */
function withSwap(entries, outId, inEntry) {
  return entries.map(e => (e.player.id === outId ? inEntry : e));
}

/**
 * Enumerate every legal single transfer and score it.
 *
 * @param {number[]} squadIds        the user's 15 player ids
 * @param {Player[]} allPlayers      the full player pool
 * @param {object}   ctx             from buildScoreContext()
 * @param {object}   opts            { horizon, budget, freeTransfers,
 *                                     scorePlayerFn?, caches?,
 *                                     rankTierByPlayerId? }
 * @param {{label: string, gws: number}} opts.horizon  the LONG window — the
 *   spine of the enumeration and the window the Long term, Funds, Ceiling and
 *   Structure lanes are measured over. Its `gws` is also the multiplier those
 *   lanes use, so a horizon change stays consistent end to end.
 * @param {{long?: Map, now1?: Map, far?: Map}} [opts.caches]  one memo cache
 *   per scoring window, created by the caller (modules/planner.js) so they
 *   survive across re-renders. Missing maps are created per call. `long` was
 *   named `near` before the horizon split; the rename is deliberate so stale
 *   callers get a fresh empty cache rather than silently reusing a cache built
 *   for a different window.
 * @param {Map<number, string|null>} [opts.rankTierByPlayerId]  playerId ->
 *   rank tier ('positionElite'|'positionStrong'|'topPercentile'|
 *   'midPercentile'|'bottomPercentile'|null), from
 *   attachRankTiers(rankPlayers(...)) over the FULL player pool. Computed by
 *   the caller (modules/planner.js caches it) because ranking the whole pool
 *   is expensive and this function must not recompute it. Optional — when
 *   absent, the Structure lane's bottomPercentile condition simply never
 *   fires; nothing throws.
 * @returns {Array<Swap>}  unsorted; callers sort by whichever lane they render
 */
export function enumerateSwaps(squadIds, allPlayers, ctx, opts = {}) {
  const {
    horizon, budget = 0, freeTransfers = 1,
    scorePlayerFn = defaultScorePlayer, caches = null, rankTierByPlayerId = null,
  } = opts;

  if (!Array.isArray(squadIds) || squadIds.length < SQUAD_TOTAL) return [];
  if (!horizon || !ctx) return [];

  // Three windows, three caches. `long` is the caller's active horizon and is
  // the spine every other lane is measured against; `now1` is this gameweek
  // alone; `far` is the deferred run. See config.js's "Planner scoring windows"
  // block for the offsets and the spec §5 for why these are three real scoring
  // passes rather than slices of one window's perGw strip.
  const longCache = caches?.long ?? new Map();
  const now1Cache = caches?.now1 ?? new Map();
  const farCache  = caches?.far  ?? new Map();

  // A shifted window moves the START of the fixture window, not the whole
  // model. MODEL: form terms stay measured from today because future form is
  // not knowable; only the fixtures being scored move forward.
  const farCtx = { ...ctx, currentGw: (ctx.currentGw ?? 1) + FUTURE_WINDOW_START };
  const farHorizon  = { label: 'Future', gws: FUTURE_WINDOW_GWS };
  const now1Horizon = { label: 'Now',    gws: NOW_WINDOW_GWS };

  // Window lengths in gameweeks. Lane values are WINDOW TOTALS — a per-GW
  // expected-points delta multiplied by the weeks it applies to — because
  // `expectedPoints` is a per-gameweek figure and the horizon only ever fed its
  // fixture multiplier. Read off the horizon rather than hard-coded so the
  // design survives the horizon switcher returning (ARCHITECTURE.md §9).
  const longGws = Math.max(1, horizon.gws ?? 1);
  const now1Gws = NOW_WINDOW_GWS;
  const farGws  = FUTURE_WINDOW_GWS;

  const byId = new Map(allPlayers.map(p => [p.id, p]));
  const scoreLong = p => memoScore(longCache, p, horizon, ctx, scorePlayerFn);
  const scoreNow1 = p => memoScore(now1Cache, p, now1Horizon, ctx, scorePlayerFn);
  const scoreFar  = p => memoScore(farCache, p, farHorizon, farCtx, scorePlayerFn);

  // Baseline: the squad as it stands, in all three windows.
  const longEntries = [];
  const now1Entries = [];
  const farEntries  = [];
  for (const id of squadIds) {
    const player = byId.get(id);
    if (!player) continue;
    const long = scoreLong(player);
    const now1 = scoreNow1(player);
    const far  = scoreFar(player);
    if (!long || !now1 || !far) continue;
    longEntries.push({ player, score: long });
    now1Entries.push({ player, score: now1 });
    farEntries.push({ player, score: far });
  }
  if (longEntries.length < SQUAD_TOTAL) return [];

  const baseLong = calcXiExpectedPoints(longEntries);
  const baseNow1 = calcXiExpectedPoints(now1Entries);
  const baseFar  = calcXiExpectedPoints(farEntries);
  const baseXiIds = new Set(pickStartingXI(longEntries).xi.map(e => e.player.id));

  // Candidate SELECTION uses the long window: it is the widest view of a
  // player's worth, and narrowing the pool on a single gameweek would let one
  // bad fixture hide a player the other two windows would have wanted.
  const pools = buildCandidatePools(allPlayers, squadIds, ctx, scoreLong);
  // A single transfer is free whenever at least one FT is available. The hit
  // only ever applies to a SECOND move, which computeBestTwoSwap models — so a
  // single swap carries a cost of 0 in every normal state of this page.
  const hitCost = freeTransfers >= 1 ? 0 : HIT_PENALTY;
  const swaps = [];

  const squadPlayers = longEntries.map(e => e.player);
  const scoresById   = new Map(longEntries.map(e => [e.player.id, e.score]));
  const flexBefore   = calcSquadFlexibility(squadPlayers, scoresById);

  for (const outEntry of longEntries) {
    const outPlayer = outEntry.player;
    for (const inPlayer of pools[outPlayer.position] ?? []) {
      const priceDiff = (inPlayer.price ?? 0) - (outPlayer.price ?? 0);
      if (priceDiff > budget) continue;

      const inLong = scoreLong(inPlayer);
      const inNow1 = scoreNow1(inPlayer);
      const inFar  = scoreFar(inPlayer);
      if (!inLong || !inNow1 || !inFar) continue;

      const longAfter = withSwap(longEntries, outPlayer.id, { player: inPlayer, score: inLong });
      const now1After = withSwap(now1Entries, outPlayer.id, { player: inPlayer, score: inNow1 });
      const farAfter  = withSwap(farEntries,  outPlayer.id, { player: inPlayer, score: inFar });

      // Keep the full { value, estimated } shape rather than just .value — the
      // aggregate already accounts for every XI/bench member's own estimated
      // flag, and throwing it away under-reports how much of the swap's score
      // rests on estimated data (see lanes.now.estimated below).
      const longAfterXi = calcXiExpectedPoints(longAfter);
      const now1AfterXi = calcXiExpectedPoints(now1After);
      const farAfterXi  = calcXiExpectedPoints(farAfter);
      // Per-gameweek deltas. Every lane below turns its own into a window total
      // by multiplying by that window's length — see the longGws/now1Gws/farGws
      // note above.
      const longXiDelta = longAfterXi.value - baseLong.value;
      const now1XiDelta = now1AfterXi.value - baseNow1.value;
      const farXiDelta  = farAfterXi.value  - baseFar.value;

      const afterXiIds = new Set(pickStartingXI(longAfter).xi.map(e => e.player.id));

      const afterPlayers = squadPlayers.map(p => (p.id === outPlayer.id ? inPlayer : p));
      const afterScores  = new Map(scoresById);
      afterScores.delete(outPlayer.id);
      afterScores.set(inPlayer.id, inLong);
      const flexAfter = calcSquadFlexibility(afterPlayers, afterScores);
      const priceRisk = calcPriceChangeRisk(inPlayer);

      // Window totals. hitCost is a ONE-OFF penalty and is subtracted after the
      // multiply — scaling it by the window would charge the same −4 five times.
      const nowTotal  = (now1XiDelta * now1Gws) - hitCost;
      const longTotal = (longXiDelta * longGws) - hitCost;

      const swap = {
        outId: outPlayer.id,
        inId:  inPlayer.id,
        outPlayer,
        inPlayer,
        outScore: outEntry.score,
        inScore:  inLong,
        outFarScore: farEntries.find(e => e.player.id === outPlayer.id)?.score ?? null,
        inFarScore:  inFar,
        priceDiff,
        // Per-gameweek deltas, one per window. `longXiDelta` is what
        // `nearXiDelta` used to be; the old name is gone rather than aliased,
        // so nothing can read "near" and silently get the five-week window.
        longXiDelta,
        now1XiDelta,
        farXiDelta,
        // Window lengths travel with the swap so lane scorers below (and any
        // caller reconstructing a total) never re-derive them from config and
        // drift from the window actually scored.
        windowGws: { now: now1Gws, long: longGws, far: farGws },
        // Aggregated far-window estimated flag, exposed for the Future lane to
        // consume without re-running calcXiExpectedPoints(farAfter).
        farEstimated: Boolean(farAfterXi.estimated || inFar.expectedPoints?.estimated),
        lanes: {
          now: {
            value: nowTotal,
            components: { now1XiDelta, gws: now1Gws, hitCost },
            // True if EITHER the aggregated after-XI estimate is estimated
            // (any XI/bench member, not just the incoming player) OR the
            // incoming player's own expected points are — under-reporting
            // this bit would let the weekly verdict overstate its confidence
            // when the win rests on estimated data.
            estimated: Boolean(now1AfterXi.estimated || inNow1.expectedPoints?.estimated),
            reasoning: buildNowReasoning(outPlayer, inPlayer, nowTotal, hitCost),
          },
          longterm: {
            value: longTotal,
            components: { longXiDelta, gws: longGws, hitCost },
            estimated: Boolean(longAfterXi.estimated || inLong.expectedPoints?.estimated),
            reasoning: buildLongTermReasoning(outPlayer, inPlayer, longTotal, longGws, hitCost),
          },
          future:    null,   // filled below
          funds:     null,   // filled below
          ceiling:   null,   // filled below
          structure: null,   // filled below
        },
        flags: {
          outInXi:      baseXiIds.has(outPlayer.id),
          inEntersXi:   afterXiIds.has(inPlayer.id),
          outUnavailable: outPlayer.status !== 'available',
        },
      };

      swap.lanes.future    = scoreFutureLane(swap);
      swap.lanes.funds     = scoreFundsLane(swap, flexBefore, flexAfter, priceRisk);
      swap.lanes.ceiling   = scoreCeilingLane(swap, ctx);
      swap.lanes.structure = scoreStructureLane(swap, rankTierByPlayerId);
      swaps.push(swap);
    }
  }

  return swaps;
}

/**
 * Plain-language explanation of a Now-lane score. Built in the engine so the
 * module only renders it — the same contract engine/chips.js already follows.
 *
 * @returns {string}
 */
function buildNowReasoning(outPlayer, inPlayer, nowTotal, hitCost) {
  const gain = nowTotal.toFixed(1);
  const hit  = hitCost > 0 ? ` after a −${hitCost}pt hit` : '';
  if (Math.abs(nowTotal) < 0.2) {
    return `${inPlayer.name} for ${outPlayer.name} barely changes your XI — `
         + 'both would be substitutes, so the projected points are almost identical.';
  }
  return `${inPlayer.name} for ${outPlayer.name} is worth ${gain} points to your `
       + `starting XI in the next gameweek${hit}.`;
}

/**
 * Plain-language explanation of a Long term-lane score.
 *
 * Names the window explicitly. Without it the sentence reads identically to the
 * Now lane's while quoting a number roughly five times larger, which is exactly
 * the confusion splitting the two boards exists to remove.
 *
 * @returns {string}
 */
function buildLongTermReasoning(outPlayer, inPlayer, longTotal, gws, hitCost) {
  const gain = longTotal.toFixed(1);
  const hit  = hitCost > 0 ? ` after a −${hitCost}pt hit` : '';
  if (Math.abs(longTotal) < 0.2) {
    return `${inPlayer.name} for ${outPlayer.name} barely changes your XI over `
         + `the next ${gws} gameweeks.`;
  }
  return `${inPlayer.name} for ${outPlayer.name} is worth ${gain} points to your `
       + `starting XI across the next ${gws} gameweeks${hit}.`;
}

/**
 * How freely a squad can be restructured, 0–100, higher = more flexible.
 *
 * Two components, weighted by config:
 *
 *  • SPREAD — how much of the squad sits clumped inside one narrow price band.
 *    A squad with six players between 7.0m and 7.6m cannot upgrade any of them
 *    without selling two, which is exactly the trap this measures.
 *  • HEADROOM — how much cash the four most disposable outfield players would
 *    raise, as a fraction of FLEX_HEADROOM_TARGET.
 *
 * MODEL: both components are kept because the constraint has two readings and
 * live use has not settled which dominates. See spec §7.1 — resolving it is a
 * weight change in config.js, not a rewrite here.
 *
 * @param {Player[]} squadPlayers
 * @param {Map<number, object>} scoresById  scorePlayer results, for disposability
 * @returns {{ value: number, components: {spread: number, headroom: number},
 *             estimated: boolean }}
 */
export function calcSquadFlexibility(squadPlayers, scoresById) {
  const players = (squadPlayers ?? []).filter(p => typeof p?.price === 'number');
  if (players.length < 2) {
    return { value: 50, components: { spread: 50, headroom: 50 }, estimated: true };
  }

  // Spread: the average share of the squad sitting within FLEX_CLUMP_BAND of
  // each player. All-identical prices → clumpiness 1 → spread 0.
  let clumpTotal = 0;
  for (const a of players) {
    const near = players.filter(b =>
      b.id !== a.id && Math.abs((b.price ?? 0) - (a.price ?? 0)) <= FLEX_CLUMP_BAND);
    clumpTotal += near.length / (players.length - 1);
  }
  const clumpiness = clumpTotal / players.length;
  const spread = clamp(0, 100, (1 - clumpiness) * 100);

  // Headroom: cash raisable from the four most disposable outfield players,
  // "disposable" being lowest expected points.
  const outfield = players
    .filter(p => p.position !== 'GKP')
    .sort((a, b) =>
      (scoresById?.get(a.id)?.expectedPoints?.value ?? 0)
      - (scoresById?.get(b.id)?.expectedPoints?.value ?? 0));
  const raisable = outfield.slice(0, BENCH_SIZE)
    .reduce((sum, p) => sum + (p.price ?? 0), 0);
  const headroom = clamp(0, 100, (raisable / FLEX_HEADROOM_TARGET) * 100);

  return {
    value: clamp(0, 100, (FLEX_W_SPREAD * spread) + (FLEX_W_HEADROOM * headroom)),
    components: { spread, headroom },
    estimated: !scoresById || scoresById.size === 0,
  };
}

/**
 * Future Prep — the strongest run over the DEFERRED window: the 3rd, 4th and
 * 5th upcoming gameweeks (FUTURE_WINDOW_START/FUTURE_WINDOW_GWS). Ranked by
 * raw projected XI points in that window, as a window total.
 *
 * MODEL: this lane previously ranked by SWING (far minus near) precisely so it
 * could not re-list the Now board, on the reasoning that a genuinely good
 * player is good in every window. That reasoning still holds, and its
 * consequence is now accepted deliberately: because the deferred window is the
 * TAIL of the long window, Future Prep will often repeat Long term's top rows.
 * The trade was made because "which players have the strongest run over
 * gameweeks 3–5" is the question the board is actually asked, and a swing
 * figure does not answer it — it answers "who improves most relative to now",
 * which is a different question that happened to be cheaper to keep distinct.
 * Restoring swing is a deliberate reversal, not a bug fix. See spec §7.3.
 *
 * @param {object} swap  a swap object from enumerateSwaps (near-complete; read
 *   before .lanes.future is assigned)
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value in projected XI points over the
 *   deferred window, higher = stronger run
 */
function scoreFutureLane(swap) {
  const gws       = swap.windowGws?.far ?? FUTURE_WINDOW_GWS;
  const farTotal  = swap.farXiDelta * gws;
  const qualifies = farTotal > FUTURE_MIN_FAR_GAIN;
  return {
    value: qualifies ? farTotal : 0,
    components: { farTotal, farXiDelta: swap.farXiDelta, gws },
    // True if EITHER the aggregated after-XI far estimate is estimated (see
    // swap.farEstimated, exposed by enumerateSwaps for exactly this) OR the
    // incoming player's own far-window expected points are — mirrors the Now
    // lane's pattern above so this lane cannot understate estimated inputs.
    estimated: Boolean(swap.farEstimated || swap.inFarScore?.expectedPoints?.estimated),
    reasoning: qualifies
      ? `${swap.inPlayer.name} projects ${farTotal.toFixed(1)} points to your XI `
        + `across the deferred window — the ${gws} gameweeks starting `
        + `${FUTURE_WINDOW_START} after this one.`
      : `${swap.inPlayer.name} does not project a strong enough deferred run to `
        + 'be a future-prep buy.',
  };
}

/**
 * Funds & Flexibility — XI points gained per £m freed, over the long window.
 *
 * The board answers one question: which downgrades in PRICE are upgrades in
 * OUTPUT, and which of those buys the most output per pound released.
 *
 * MODEL: this lane used to rank by flexibility gained per point given up, where
 * "flexibility" is calcSquadFlexibility's 0–100 price-clumping measure — not
 * cash. Two faults followed and both are fixed here. It never filtered on
 * price, so a same-price sideways move that happened to spread the squad's
 * price bands outranked a real saving; and `pointsGiven` floored at zero, so a
 * move that GAINED points earned no more credit than one that broke even,
 * making output invisible to the ranking.
 *
 * Three properties fall out of the arithmetic rather than needing their own
 * filters:
 *
 *  • CHEAPER ONLY — a same-price or dearer swap frees ≤ 0, which fails the
 *    FUNDS_MIN_CASH_FREED comparison and scores 0.
 *  • BETTER ONLY — a cheaper-but-worse swap has a negative delta and so a
 *    negative value, which the board's own `value > 0` row filter drops.
 *  • NO NOISE MOVES — FUNDS_MIN_CASH_FREED also stops a £0.1m saving inflating
 *    the ratio tenfold against a £1.0m one.
 *
 * The LONG window, not the immediate one: the point of freed cash is the
 * upgrade it funds in a week or two, so judging it on a single gameweek would
 * misprice it.
 *
 * calcSquadFlexibility no longer ranks this lane but is deliberately still
 * computed and reported — engine/strategy.js's cashCrunch trigger and the
 * why-panel both read it, and `flexGain` stays in components for them.
 *
 * @param {object} swap
 * @param {{value: number, estimated: boolean}} flexBefore  calcSquadFlexibility on the current squad
 * @param {{value: number, estimated: boolean}} flexAfter   calcSquadFlexibility after this swap
 * @param {{direction: string, confidence: number, reasoning: string}} priceRisk
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value = XI points gained over the long
 *   window per £m freed; 0 when the swap frees no meaningful cash
 */
function scoreFundsLane(swap, flexBefore, flexAfter, priceRisk) {
  const flexGain  = flexAfter.value - flexBefore.value;
  const cashFreed = -swap.priceDiff;
  const gws       = swap.windowGws?.long ?? 1;
  const pointsGained = swap.longXiDelta * gws;

  const components = {
    flexGain, cashFreed, pointsGained, gws,
    priceRisk: priceRisk?.direction ?? 'stable',
    // Exposed alongside the direction so consumers (engine/strategy.js's
    // priceDeadline trigger) can gate on how confident the signal is rather
    // than firing on any net-positive transfer flow, however thin.
    priceRiskConfidence: priceRisk?.confidence ?? 0,
  };

  if (cashFreed < FUNDS_MIN_CASH_FREED) {
    return {
      value: 0,
      components,
      estimated: flexBefore.estimated || flexAfter.estimated,
      reasoning: cashFreed <= 0
        ? `${swap.inPlayer.name} costs the same or more than ${swap.outPlayer.name}, `
          + 'so this move frees no money.'
        : `Frees only £${cashFreed.toFixed(1)}m — below the £`
          + `${FUNDS_MIN_CASH_FREED.toFixed(1)}m worth planning around.`,
    };
  }

  const value = pointsGained / cashFreed;
  return {
    value,
    components,
    estimated: Boolean(swap.lanes?.longterm?.estimated)
            || flexBefore.estimated || flexAfter.estimated,
    reasoning: pointsGained >= 0
      ? `Frees £${cashFreed.toFixed(1)}m AND gains ${pointsGained.toFixed(1)} points `
        + `over the next ${gws} gameweeks — ${value.toFixed(1)} points per £m released.`
      : `Frees £${cashFreed.toFixed(1)}m but costs ${Math.abs(pointsGained).toFixed(1)} `
        + `points over the next ${gws} gameweeks.`,
  };
}

/**
 * Ceiling — the best SINGLE gameweek in the window, blended with how often the
 * player has actually hauled.
 *
 * MODEL: FPL exposes no variance data. Haul rate from per-GW history is a
 * backward-looking proxy, thin for players with few starts, and summaries load
 * lazily so it is often absent entirely. This lane flags itself estimated
 * whenever the summary is missing and must never present as being as solid as
 * the Now lane. See spec §7.1.
 *
 * @param {object} swap
 * @param {object} ctx  from buildScoreContext(); reads ctx.playerSummariesById
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value on the same points scale as a
 *   single-gameweek projection, higher = higher ceiling
 */
function scoreCeilingLane(swap, ctx) {
  const score   = swap.inScore;
  const summary = ctx?.playerSummariesById?.[swap.inId] ?? null;

  // A blank slot is scored BLANK_GW_VALUE by groupPerGwSlots/fixtures.js, which
  // is high enough to beat a genuinely hard fixture in a naive max() — the
  // team does not play that week, so it can never be the "peak" week. Blanks
  // are excluded before taking the max; if every slot in the window is blank
  // there is no week to peak in at all, and the lane reports 0 while flagging
  // itself estimated rather than a confident zero.
  const slots = groupPerGwSlots(score?.perGw ?? []);
  const playableSlots = slots.filter(slot => !slot.isBlank);
  const allBlank = playableSlots.length === 0;
  let peakGwValue = 0;
  for (const slot of playableSlots) {
    const raw = slot.fixtures.reduce((s, f) => s + (f.value ?? 0), 0)
              / Math.max(1, slot.fixtures.length);
    peakGwValue = Math.max(peakGwValue, applyDgwUplift(raw, slot.fixtures.length));
  }

  const peak = allBlank
    ? { value: 0, estimated: true }
    : calcExpectedPoints(
        score?.avgPointsPerGw ?? { value: 0, estimated: true },
        { value: peakGwValue },
        score?.breakdown?.minutes ?? { value: 50, estimated: true },
        1,
      );

  const history = summary?.history ?? [];
  const played  = history.filter(h => (h.minutes ?? 0) > 0);
  const hauls   = played.filter(h => (h.points ?? 0) >= HAUL_POINTS_THRESHOLD);
  const haulRate = played.length > 0 ? hauls.length / played.length : 0;

  const value = (CEILING_W_PEAK * peak.value) + (CEILING_W_HAUL * haulRate * peak.value);

  return {
    value,
    components: { peak: peak.value, haulRate, hauls: hauls.length, played: played.length },
    estimated: played.length === 0 || peak.estimated,
    reasoning: allBlank
      ? `${swap.inPlayer.name} has no fixture in this window, so no ceiling can `
        + 'be projected.'
      : played.length === 0
        ? `${swap.inPlayer.name}'s peak week projects at ${peak.value.toFixed(1)} points, `
          + 'but no gameweek history has loaded yet — treat this as a rough estimate.'
        : `${swap.inPlayer.name} has hauled in ${hauls.length} of ${played.length} `
          + `appearances, with a peak week projecting ${peak.value.toFixed(1)} points.`,
  };
}

/**
 * Structure Fix — repairs a broken slot in the STARTING XI. Silent otherwise:
 * a swap involving a healthy bench player is not a structure problem, and the
 * board says "nothing broken" rather than padding itself.
 *
 * Spec §7.1 defines three independent conditions that mark the OUT player as
 * structurally broken (any one is sufficient):
 *   (a) status !== 'available'
 *   (b) breakdown.playtime.value below STRUCTURE_PLAYTIME_FLOOR
 *   (c) rank tier 'bottomPercentile'
 *
 * MODEL: (c) exists because a player can be fit and nailed — (a) and (b) both
 * stay silent — while his underlying output has collapsed relative to the
 * WHOLE player pool: a nailed starter quietly posting bottom-decile numbers
 * is still costing the user every week, and this is the only one of the
 * three conditions that would ever catch him. Rank tier is intentionally not
 * computed in here — it depends on a full-pool ranking the caller has
 * already paid for (see rankTierByPlayerId in enumerateSwaps' JSDoc) — so
 * this condition degrades to "never fires" rather than recomputing it.
 *
 * @param {object} swap
 * @param {Map<number, string|null>|null} [rankTierByPlayerId]  playerId ->
 *   rank tier, from the caller's cached attachRankTiers(rankPlayers(...))
 *   pass. Optional; when absent condition (c) never fires.
 * @returns {{ value: number, components: object, estimated: boolean,
 *             reasoning: string }}  value in projected XI points restored over
 *   the long window (a WINDOW TOTAL, matching the Long term board it sits
 *   beside — the repair goes on paying every week it stands, and reporting a
 *   per-gameweek figure alongside five-gameweek totals would make the same
 *   swap read as two different sizes on one grid), 0 when there is nothing to
 *   repair, higher = more urgent fix
 */
function scoreStructureLane(swap, rankTierByPlayerId = null) {
  if (!swap.flags.outInXi) {
    return {
      value: 0, components: {}, estimated: false,
      reasoning: `${swap.outPlayer.name} is not in your projected XI, so this is `
               + 'not a structural repair.',
    };
  }

  const unavailable = swap.outPlayer.status !== 'available';
  // composite.js's no-team fallback branch omits `breakdown.playtime` entirely
  // (see scorePlayer). The `?? 1` below keeps this function total rather than
  // throwing, but that fallback must not be silent — playtimeMissing feeds
  // into `estimated` below in both return branches.
  const playtimeMissing = !swap.outScore?.breakdown?.playtime;
  const playtime    = swap.outScore?.breakdown?.playtime?.value ?? 1;
  const lowPlaytime = playtime < STRUCTURE_PLAYTIME_FLOOR;
  const rankTier    = rankTierByPlayerId?.get(swap.outId) ?? null;
  const bottomTier  = rankTier === 'bottomPercentile';

  if (!unavailable && !lowPlaytime && !bottomTier) {
    return {
      value: 0, components: { playtime, rankTier }, estimated: playtimeMissing,
      reasoning: `${swap.outPlayer.name} is fit and starting — nothing to repair.`,
    };
  }

  const cause = unavailable
    ? `${swap.outPlayer.name} is flagged ${swap.outPlayer.status}`
    : lowPlaytime
      ? `${swap.outPlayer.name} is barely starting (playtime ${(playtime * 100).toFixed(0)}%)`
      : `${swap.outPlayer.name} is fit and starting but now rates in the bottom `
        + 'band of the whole player pool';

  const gws      = swap.windowGws?.long ?? 1;
  const restored = Math.max(0, swap.longXiDelta * gws);

  return {
    value: restored,
    components: { playtime, unavailable, rankTier, gws },
    estimated: Boolean(swap.outScore?.breakdown?.playtime?.estimated) || playtimeMissing,
    reasoning: `${cause}. Replacing him with ${swap.inPlayer.name} restores `
             + `${restored.toFixed(1)} points to your XI over the next ${gws} gameweeks.`,
  };
}
