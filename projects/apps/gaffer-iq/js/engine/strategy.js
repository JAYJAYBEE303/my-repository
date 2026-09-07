/**
 * js/engine/strategy.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * Turns the six lane scores from engine/transfers.js into one weekly verdict:
 * which lane to act on, how far ahead of the runner-up it is, and which hard
 * conditions — an injured starter, a chip window, a cash crunch — override the
 * arithmetic.
 *
 * "Roll the transfer" is a lane here, not a fallback. A planner that always
 * recommends something is the failure this module exists to prevent.
 *
 * See docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md §8.
 */

import { clamp } from '../util.js';
import {
  LANE_SCALE_NOW, LANE_SCALE_LONGTERM, LANE_SCALE_FUTURE, LANE_SCALE_FUNDS,
  LANE_SCALE_CEILING, LANE_SCALE_STRUCTURE,
  VERDICT_ACT_THRESHOLD, VERDICT_MARGIN_CLEAR, VERDICT_MARGIN_DOMINANT,
  CHIP_WINDOW_GWS, FLEX_FLOOR, PRICE_BUY_NOW_CONFIDENCE, CHIP_LABELS,
} from '../config.js';

// Tie-break priority when more than one chip's recommended GW is equally near —
// the sharper, more time-critical chips win. See detectTriggers' MODEL note.
const CHIP_TRIGGER_PRIORITY = ['triplecaptain', 'benchboost', 'freehit', 'wildcard'];

/** Lane id → the config divisor that maps its natural unit onto 0–100. */
const LANE_SCALES = {
  now:       LANE_SCALE_NOW,
  longterm:  LANE_SCALE_LONGTERM,
  future:    LANE_SCALE_FUTURE,
  funds:     LANE_SCALE_FUNDS,
  ceiling:   LANE_SCALE_CEILING,
  structure: LANE_SCALE_STRUCTURE,
};

/** Human labels, used in the reasoning strings this module builds. */
const LANE_LABELS = {
  now:       'Now',
  longterm:  'Long term',
  future:    'Future Prep',
  funds:     'Funds & Flexibility',
  ceiling:   'Ceiling',
  structure: 'Structure Fix',
  roll:      'Roll the transfer',
};

/**
 * Map a lane's natural unit onto 0–100.
 *
 * MODEL: this is the load-bearing and most arbitrary step in the design.
 * Without a shared scale, "a swing of +6" and "frees £0.5m" have no common
 * language and the margin below is meaningless. The divisors are calibration
 * targets, not truths — the first thing to tune against realised results per
 * ROADMAP.md Phase 3B.
 *
 * @returns {number}  0–100, higher = a stronger case for acting on this lane
 */
function normaliseLaneValue(laneId, value) {
  const scale = LANE_SCALES[laneId] ?? 1;
  return clamp(0, 100, (value / scale) * 100);
}

/** The best swap on each lane, with its normalised score, ranked highest first. */
function rankLanes(swaps) {
  const rows = [];
  for (const laneId of Object.keys(LANE_SCALES)) {
    let best = null;
    for (const swap of swaps) {
      const lane = swap.lanes?.[laneId];
      if (!lane || !Number.isFinite(lane.value)) continue;
      if (!best || lane.value > best.lanes[laneId].value) best = swap;
    }
    if (!best) continue;
    rows.push({
      laneId,
      swap: best,
      score: normaliseLaneValue(laneId, best.lanes[laneId].value),
      estimated: Boolean(best.lanes[laneId].estimated),
    });
  }
  return rows.sort((a, b) => b.score - a.score);
}

/**
 * Hard conditions that may promote a lane past the arithmetic. Each carries its
 * own headline reason and is always reported — detecting a trigger never by
 * itself reorders anything; buildVerdict decides whether it actually promotes.
 *
 * @returns {Array<{id: string, laneId: string, message: string}>}
 */
function detectTriggers(swaps, squadState, ctx) {
  const triggers = [];

  const brokenStarter = swaps.find(s => s.flags?.outInXi && s.flags?.outUnavailable);
  if (brokenStarter) {
    triggers.push({
      id: 'xiPlayerUnavailable',
      laneId: 'structure',
      message: `${brokenStarter.outPlayer.name} is in your projected XI and is `
             + `flagged ${brokenStarter.outPlayer.status}.`,
    });
  }

  const flexibility = squadState?.flexibility?.value ?? 100;
  if (flexibility < FLEX_FLOOR) {
    triggers.push({
      id: 'cashCrunch',
      laneId: 'funds',
      // Flexibility is what DETECTS the crunch; it is no longer what the Funds
      // board ranks by (that is points gained per £m freed — see
      // engine/transfers.js's scoreFundsLane). The message therefore names the
      // symptom and then points at what the board will actually show, rather
      // than promising a flexibility ranking the board no longer provides.
      message: `Squad flexibility is ${flexibility.toFixed(0)} — your money is `
             + 'clumped tightly enough that upgrading anyone is getting hard. '
             + 'Funds & Flexibility lists the cheaper players who still improve '
             + 'your XI.',
    });
  }

  // MODEL: chips.js always recommends a best gameweek for every chip — there is
  // no "no recommendation" state — so without a cap this trigger would fire for
  // several chips most weeks (wildcard, free hit and bench boost all landing in
  // the same nearby window is the common case, not the exception) and drown out
  // the genuinely sharp signals the other triggers carry. At most one chip
  // trigger fires: the chip whose recommended GW is nearest, ties broken by
  // CHIP_TRIGGER_PRIORITY (the sharper, more time-critical chips win a tie).
  // ctx.currentGw is the gameweek being PLANNED, which is not necessarily the
  // one on the scoreboard: once a round has kicked off its deadline has gone
  // and modules/planner.js advances the context to the next one. Distances
  // below are therefore measured from the first gameweek the user can still
  // act in — the only frame in which "plan transfers around it" means anything.
  const currentGw = ctx?.currentGw ?? 0;
  let nearestChip = null;
  for (const [chipId, rec] of Object.entries(squadState?.chipRecs ?? {})) {
    const gw = rec?.gw;
    if (typeof gw !== 'number') continue;
    if (gw - currentGw > CHIP_WINDOW_GWS || gw < currentGw) continue;
    const distance = gw - currentGw;
    if (!nearestChip
      || distance < nearestChip.distance
      || (distance === nearestChip.distance
          && CHIP_TRIGGER_PRIORITY.indexOf(chipId) < CHIP_TRIGGER_PRIORITY.indexOf(nearestChip.chipId))) {
      nearestChip = { chipId, gw, distance };
    }
  }
  if (nearestChip) {
    const { chipId, gw, distance } = nearestChip;
    // "this gameweek" would be a lie whenever the live round has already
    // started — the nearest actionable gameweek is the one being planned, not
    // the one being played.
    const distancePhrase = distance === 0 ? 'the gameweek you are planning'
      : `${distance} ${distance === 1 ? 'gameweek' : 'gameweeks'} away`;
    triggers.push({
      id: 'chipWindow',
      laneId: chipId === 'triplecaptain' ? 'ceiling' : 'future',
      message: `${CHIP_LABELS[chipId] ?? chipId} looks strongest in GW${gw}, `
             + `${distancePhrase} — plan transfers around it.`,
    });
  }

  // Gated on confidence, not just direction: calcPriceChangeRisk (engine/prices.js)
  // reports direction:'rise' for any net-positive transfer flow above its activity
  // floor, including thin, noisy signals. PRICE_BUY_NOW_CONFIDENCE is the same bar
  // the planner's own "Buy now" badge uses — reusing it keeps this trigger no more
  // trigger-happy than that UI already is.
  const risingTarget = swaps.find(s =>
    s.lanes?.funds?.components?.priceRisk === 'rise'
    && (s.lanes?.funds?.components?.priceRiskConfidence ?? 0) >= PRICE_BUY_NOW_CONFIDENCE
    && s.lanes?.now?.value > 0);
  if (risingTarget) {
    triggers.push({
      id: 'priceDeadline',
      laneId: 'funds',
      message: `${risingTarget.inPlayer.name} is trending towards a price rise — `
             + 'buying later costs more.',
    });
  }

  return triggers;
}

/**
 * Build the week's verdict: which lane to act on (or whether to roll), how
 * confident that call is, and what — if anything — overrode the arithmetic.
 *
 * Selection has two stages. First, the six lanes are ranked by their best
 * swap's normalised score (0–100, see normaliseLaneValue); the top-ranked lane
 * is the "arithmetic leader" and only wins outright if its score clears
 * VERDICT_ACT_THRESHOLD — otherwise the verdict rolls. Second, any lane with a
 * fired trigger (see detectTriggers) that ALSO clears VERDICT_ACT_THRESHOLD is a
 * promotion candidate; the highest-scoring such lane, if it differs from the
 * arithmetic leader, is promoted to be the verdict's lane instead — even when
 * the arithmetic leader itself didn't clear the threshold. A promotion always
 * reports confidence 'clear' (a hard condition is not a close call) before the
 * estimated-data downgrade below is applied. This is spec §8.3's "hard triggers
 * can jump the queue and say so".
 *
 * `margin` always means the arithmetic leader's normalised score minus the
 * runner-up's (never negative) — it describes how the lanes actually compare
 * and keeps that meaning whether or not a promotion changed which lane won.
 *
 * Honesty rule (spec §8.4): a winning lane whose swap is itself flagged
 * `estimated` never reports the same confidence a measured winner would —
 * 'dominant' is downgraded to 'clear', and 'clear' (including a fresh
 * promotion) is downgraded to 'close'.
 *
 * @param {Array<object>} swaps        Swap[] from enumerateSwaps() — each with
 *   `lanes.{now,future,funds,ceiling,structure}` as
 *   `{ value: number, components: object, estimated: boolean, reasoning: string }`,
 *   plus `flags.{outInXi, inEntersXi, outUnavailable}`, `outPlayer`, `inPlayer`.
 * @param {{ flexibility: { value: number, components: object, estimated: boolean },
 *           freeTransfers: number,
 *           chipRecs: Object<string, { gw: number, reasoning: string }> }} squadState
 * @param {{ currentGw: number }} ctx   from buildScoreContext(). `currentGw` is
 *   the gameweek being PLANNED — see modules/planner.js getPlanningTiming(),
 *   which advances it past a round that has already kicked off.
 * @returns {{
 *   lane: 'now'|'future'|'funds'|'ceiling'|'structure'|'roll',
 *   laneScore: number,        // 0–100, the winning lane's normalised score (0 if rolled)
 *   margin: number,           // 0–100, arithmetic leader's score minus the runner-up's
 *   confidence: 'dominant'|'clear'|'close',
 *   bestSwap: object|null,    // the winning lane's Swap, or null when rolled
 *   alternatives: Array<{ lane: string, label: string, score: number }>,
 *   triggers: Array<{ id: string, laneId: string, message: string }>,
 *   promotedBy: string|null,  // the trigger id that promoted this lane, or null
 *   estimated: boolean,       // true if the winning lane's swap is itself estimated
 *   reasoning: string,
 * }}
 */
export function buildVerdict(swaps, squadState, ctx) {
  const triggers = detectTriggers(swaps ?? [], squadState ?? {}, ctx ?? {});
  const ranked   = rankLanes(swaps ?? []);
  const leader   = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;
  const margin   = leader ? (runnerUp ? leader.score - runnerUp.score : leader.score) : 0;

  // Promotion: the highest-scoring triggered lane that clears the threshold, if
  // it differs from the arithmetic leader. ranked is sorted descending, so the
  // first qualifying row is the highest-scoring one.
  const triggeredLaneIds = new Set(triggers.map(t => t.laneId));
  let promoted = ranked.find(row =>
    triggeredLaneIds.has(row.laneId) && row.score >= VERDICT_ACT_THRESHOLD) ?? null;
  if (promoted && leader && promoted.laneId === leader.laneId) promoted = null;
  const promotedBy = promoted
    ? (triggers.find(t => t.laneId === promoted.laneId)?.id ?? null)
    : null;

  const winner = promoted ?? leader;

  if (!promoted && (!winner || winner.score < VERDICT_ACT_THRESHOLD)) {
    // No triggerNote here: the structured `triggers` list this verdict already
    // carries is rendered as its own bulleted list by the module (with the `!`
    // marker) — repeating the same sentences in prose read as broken, not
    // thorough. See spec revision in the multi-lens transfers task-8 review.
    const estimatedNote = winner?.estimated
      ? ' Some of the inputs behind this are estimated, so treat it as a lean rather '
        + 'than a certainty.'
      : '';
    const headline = winner
      ? `${LANE_LABELS.roll} — the best move, ${LANE_LABELS[winner.laneId]}, scores `
        + `${winner.score.toFixed(0)} against a threshold of ${VERDICT_ACT_THRESHOLD}.`
      : `${LANE_LABELS.roll} — no legal transfers are available within your budget.`;
    return {
      lane: 'roll',
      laneScore: winner?.score ?? 0,
      margin,
      confidence: 'clear',
      bestSwap: null,
      alternatives: [],
      triggers,
      promotedBy: null,
      estimated: Boolean(winner?.estimated),
      reasoning: `${headline}${estimatedNote}`,
    };
  }

  let confidence;
  if (promoted) {
    confidence = 'clear';
  } else {
    confidence = 'close';
    if (margin >= VERDICT_MARGIN_DOMINANT)   confidence = 'dominant';
    else if (margin >= VERDICT_MARGIN_CLEAR) confidence = 'clear';
  }

  // Honesty rule: an estimated winner never speaks with the same certainty as a
  // measured one. See spec §8.4.
  const estimated = winner.estimated;
  if (estimated && confidence === 'dominant') confidence = 'clear';
  else if (estimated && confidence === 'clear') confidence = 'close';

  const alternatives = ranked
    .filter(row => row.laneId !== winner.laneId && winner.score - row.score < VERDICT_MARGIN_CLEAR)
    .map(row => ({ lane: row.laneId, label: LANE_LABELS[row.laneId], score: row.score }));

  const winnerLabel = LANE_LABELS[winner.laneId];
  let headline;

  // No triggerNote appended below: the structured `triggers` list is rendered
  // as its own bulleted list by the module, so repeating trigger messages in
  // prose here would duplicate it. The one exception is the promotion
  // headline just below, which must keep stating the promoting trigger's
  // message — that sentence is what explains why a lower-scoring lane won.
  if (promoted) {
    const leadTrigger = triggers.find(t => t.id === promotedBy);
    const leaderLabel = LANE_LABELS[leader.laneId];
    headline = `${leadTrigger.message} This promotes ${winnerLabel} ahead of `
             + `${leaderLabel} (${leader.score.toFixed(0)} points), which would `
             + 'otherwise have topped the board this week.';
  } else {
    // `confidence` can read 'close' with an EMPTY `alternatives` list: the
    // estimated-data downgrade above can drop 'clear'/'dominant' to 'close'
    // on a margin that was already ≥ VERDICT_MARGIN_CLEAR, but `alternatives`
    // is filtered on that same margin and was computed before the downgrade
    // — it has nothing within range to name. That disagreement is intentional
    // (the downgrade is about honesty re: estimated data, not about how far
    // apart the lanes actually are), so only the SENTENCE falls back here;
    // `confidence` itself is left as 'close' for the banner's badge/CSS.
    const canNameAlternatives = confidence === 'close' && alternatives.length > 0;
    const altNames = alternatives.map(a => a.label).join(' and ');
    headline =
        confidence === 'dominant' ? `${winnerLabel} is in a different league this week.`
      : canNameAlternatives
        ? `Close call — ${winnerLabel}, but ${altNames} `
          + `${alternatives.length === 1 ? 'is' : 'are'} within ${VERDICT_MARGIN_CLEAR} points.`
        : `${winnerLabel}, clearly.`;
  }

  const estimatedNote = estimated
    ? ' Some of the inputs behind this are estimated, so treat it as a lean rather '
      + 'than a certainty.'
    : '';

  return {
    lane: winner.laneId,
    laneScore: winner.score,
    margin,
    confidence,
    bestSwap: winner.swap,
    alternatives,
    triggers,
    promotedBy,
    estimated,
    reasoning: `${headline} ${winner.swap.lanes[winner.laneId].reasoning}${estimatedNote}`,
  };
}
