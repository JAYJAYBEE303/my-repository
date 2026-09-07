# Planner: horizon split and a value-ranked Funds board

Date: 2026-09-07
Status: implemented 2026-09-07; §11.2 open for a decision
Supersedes parts of `2026-08-30-planner-multi-lens-transfers-design.md` (§7.1
lane definitions for `now`, `future` and `funds`; §8 lane normalisation).

## 1. Problem

Two faults in the Transfer Planner's lens boards, reported from live use.

**Funds & Flexibility recommends moves that free no money.** The lane ranks by
`flexGain / (pointsGiven + 1)`, where `flexGain` is the change in
`calcSquadFlexibility` — a 0–100 measure of *price clumping and headroom*, not
of cash. A same-price sideways move that happens to spread the squad's price
bands therefore scores 4.0 and outranks a genuine downgrade-in-price,
upgrade-in-output move. Observed on live data: the board's top three rows were
all `+£0.0m`, while a real available move (Le Fée → Jantos, −£0.9m and a clear
gain in projected output) did not appear at all.

Two independent causes:

- the lane never filters on `priceDiff`, so a dearer or same-price move is
  eligible;
- `pointsGiven = Math.max(0, -swap.nearXiDelta)` floors at zero, so a move that
  *gains* points earns no more credit than one that breaks even. Points gained
  are invisible to the ranking.

**"Now" is not now.** `opts.horizon` comes from `store.getActiveHorizon()`,
fixed at `GW5` since the horizon switcher was removed (ARCHITECTURE.md §9). The
Now lane therefore scores a five-gameweek window while presenting itself as the
immediate move, and there is no board answering "what is the best transfer for
the next five gameweeks" as distinct from "for this Saturday" — the two are the
same computation today.

A related mislabelling falls out of the same reading. `expectedPoints` is a
**per-gameweek** figure: `avgPointsPerGw × fixtureMultiplier × minutesMultiplier`.
The horizon feeds only the fixture multiplier. So the Now board's
`unit: 'projected XI points over the horizon'` describes a quantity the number
is not — it is a per-GW rate whose fixture term is averaged over five weeks.

## 2. Goals

- Funds & Flexibility ranks genuine value: cheaper *and* better, ordered by how
  much output each freed pound buys.
- Separate boards for the immediate gameweek and the five-gameweek window.
- Board numbers mean what their unit labels say.

## 3. Non-goals

- Ceiling is unchanged: it keeps its five-gameweek peak-week window and its
  haul-rate blend, and stays on a single-gameweek points scale because "peak
  week" is inherently one week and its board label says so.
- Structure Fix keeps its detection rules (flagged / low playtime / bottom
  percentile) and its window unchanged. Its *scale* had to move — see §11.
- `calcSquadFlexibility` is not deleted or reweighted.
- The horizon switcher is not reinstated.
- The six pre-existing test failures in `channel.test.js` and
  `composite.test.js` are out of scope and stay failing.

## 4. Board set

Six boards, in render order:

| Board | Ranks by | Window |
|---|---|---|
| Now | XI points gained | next 1 GW |
| Long term | XI points gained | next 5 GWs |
| Future Prep | XI points gained | 3rd–5th upcoming GWs |
| Funds & Flexibility | XI points gained per £m freed | next 5 GWs |
| Ceiling | peak-week blend | next 5 GWs, reported as a 1-GW peak (unchanged) |
| Structure Fix | XI points restored | next 5 GWs (detection unchanged, now a window total — §11.1) |

## 5. Scoring windows

`enumerateSwaps` runs a third memoised pass, on the pattern the existing
`farCtx` already establishes — a window is expressed by shifting
`ctx.currentGw` and setting `horizon.gws`.

| Cache | Start offset | `gws` | Consumed by |
|---|---|---|---|
| `now1` | +0 | `NOW_WINDOW_GWS` (1) | Now |
| `long5` | +0 | `opts.horizon.gws` (5) | Long term, Funds |
| `far35` | `FUTURE_WINDOW_START` (+2) | `FUTURE_WINDOW_GWS` (3) | Future Prep |

`long5` is the existing `near` cache renamed. `far35` is the existing `far`
cache with `FUTURE_WINDOW_GWS` narrowed from 5 to 3. `now1` is new.

**Why three passes rather than deriving sub-windows from one `perGw` strip.**
Only `horizonResult` and `counterEdge` vary between windows inside
`scorePlayer`; form, minutes and season average do not. A cheaper design would
read the five-gameweek `perGw` array and slice it, as `scoreCeilingLane`
already does. Rejected: slicing gives the correct per-gameweek *fixture*
values but leaves the *counter edge* averaged over all five weeks, so a 1-GW
"Now" would carry a five-week counter matchup. Shifting `currentGw` and
re-scoring is exactly the fudge-avoidance the `farCtx` pattern was written for,
and consistency with it is worth the cost.

**Cost.** Roughly 175 players scored (15 squad + 4 positions ×
`CANDIDATE_POOL_PER_POS`) × 3 windows, against ×2 today: a 50% increase on
first render, then cached. `_scoreCaches` in `planner.js` grows from two maps
to three and is still cleared together on `rescore`.

**Why `FUTURE_WINDOW_START = 2` means the 3rd upcoming gameweek.**
`scorePlayer` builds its window as `startGw + i` for `i` in `0..gws-1` with
`startGw = ctx.currentGw`, so offset +0 is the first upcoming gameweek. The
3rd–5th upcoming are offsets +2, +3, +4 — start 2, length 3.

## 6. Points scale

Lane values are **window totals**, not per-gameweek rates: a lane's XI delta is
multiplied by its window length in gameweeks.

- Now: `× 1` (the rate and the total coincide)
- Long term: `× opts.horizon.gws` (5)
- Future Prep: `× FUTURE_WINDOW_GWS` (3)

`hitCost` is a one-off penalty and is subtracted **after** the multiply, never
scaled by the window.

Reading `horizon.gws` rather than a literal 5 keeps the design correct if the
horizon switcher returns.

**Accepted inaccuracy.** The multiplier counts calendar gameweeks in the
window, not gameweeks the player's team actually plays. A blank inside the
window inflates the total. Correcting it means threading `perGw`'s `isBlank`
flags into `calcXiExpectedPoints`, which currently ignores them, and that is a
change to the shared XI aggregate used by every lane and by the Dashboard. Out
of scope here; recorded so a later reader knows it was seen and deferred.

**Consequence: the three horizon boards are no longer comparable by raw
number.** A Long term row will read roughly five times a Now row for the same
move. This is correct — they measure different spans — and each board's `unit`
label states its span. The verdict banner compares them only after
normalisation (§8).

## 7. Lane definitions

### 7.1 Now

```
value = (now1XiDelta * NOW_WINDOW_GWS) - hitCost
```

Unit: *projected XI points, next GW*.

### 7.2 Long term (new lane id `longterm`)

```
value = (long5XiDelta * horizon.gws) - hitCost
```

Unit: *projected XI points, next 5 GWs*.

### 7.3 Future Prep

Ranked by **raw projected points in the late window**, no longer by swing:

```
value = (far35XiDelta * FUTURE_WINDOW_GWS)   if above FUTURE_MIN_FAR_GAIN, else 0
```

Unit: *projected XI points, GWs 3–5*.

`FUTURE_MIN_FAR_GAIN` rises `0.5 → 1.5`. It previously gated a per-gameweek
delta; it now gates a three-gameweek total, and 1.5 holds the same real bar.

**MODEL change, deliberate.** The lane previously ranked by *swing*
(`farXiDelta − nearXiDelta`) specifically so it could not re-list the Now
board, on the reasoning that a genuinely good player is good in every window.
That reasoning still holds, and the consequence is accepted: Future Prep will
often repeat Long term's top rows, because GWs 3–5 are the tail of Long term's
own 1–5 window. The user chose raw points over swing on the grounds that
"strongest run over GWs 3–5" is the question they actually want answered, and a
swing figure does not answer it. A future reader restoring swing should treat
this paragraph as the record of a decision, not an oversight.

### 7.4 Funds & Flexibility

Rewritten. Gated, then ranked by output per pound freed:

```
cashFreed = -priceDiff
if (cashFreed < FUNDS_MIN_CASH_FREED) -> value = 0
value = (long5XiDelta * horizon.gws) / cashFreed
```

Unit: *XI points gained per £m freed, next 5 GWs*.

Four properties, each answering one half of the reported fault:

- **Cheaper only.** `cashFreed < FUNDS_MIN_CASH_FREED` returns 0, and a
  same-price or dearer move has `cashFreed <= 0`, so it is caught by the same
  branch. No separate `priceDiff < 0` test is needed.
- **Better only.** A cheaper-but-worse move has a negative `long5XiDelta` and
  so a negative value; `renderBoard`'s existing `s.lanes[board.id].value > 0`
  filter drops it. The board self-restricts to cheaper *and* better without a
  new filter.
- **Judged over five gameweeks**, not one. Freeing cash is a medium-term
  decision — the point of the freed money is the upgrade it funds in a week or
  two — so the one-gameweek window would misjudge it.
- **`FUNDS_MIN_CASH_FREED = 0.2`.** Without a floor, a −£0.1m move dividing
  into the ratio inflates tenfold, and £0.1m is price-change noise rather than
  a saving worth planning around.

**`calcSquadFlexibility` survives.** It stops being the ranker but keeps two
live consumers: `strategy.js`'s `cashCrunch` trigger and `planner.js`'s
`squadState.flexibility`. `flexGain` stays in the lane's `components` so the
why-panel can still report it. Deleting it would silently remove the cash
crunch trigger.

**Trigger wording.** `cashCrunch` still promotes the `funds` lane, which
remains roughly right advice — a clumped squad does want the cheaper-and-better
move. But its message names squad flexibility, which the board no longer
measures, so the message is reworded to point at what the board now shows.

### 7.5 Ceiling, Structure Fix

Unchanged.

## 8. Lane normalisation

`LANE_SCALES` in `strategy.js` maps each lane's natural unit onto 0–100 for the
verdict's margin language. Every horizon lane's magnitude changes under §6, so
every divisor must move.

Measured on live data at GW3 (15-man squad, GW5 horizon, £2.0m budget, 575
enumerated swaps) — the same procedure as the original GW2 calibration. Each
divisor is the lane's observed maximum ÷ ~0.95, so the best real move lands at
90–100.

| Constant | Was | Now | Observed max | Normalises to |
|---|---|---|---|---|
| `LANE_SCALE_NOW` | 10 | 10 | 8.8 | 88 |
| `LANE_SCALE_LONGTERM` | — | 42 | 39.7 | 94 |
| `LANE_SCALE_FUTURE` | 0.7 | 25 | 24.0 | 96 |
| `LANE_SCALE_FUNDS` | 5 | 90 | 88.5 | 98 |
| `LANE_SCALE_CEILING` | 8 | 8 | 6.2 | 78 |
| `LANE_SCALE_STRUCTURE` | 10 | 33 | 31.5 | 95 |

Two of these would have been serious bugs left at their pre-measurement
guesses. `LANE_SCALE_FUTURE` was `0.7` because it divided a *swing*; against a
3-GW raw total it pins the lane at 100 and Future Prep hijacks the verdict every
week. `LANE_SCALE_FUNDS` was guessed at 10 against an observed max of 88.5 —
a points-per-£m ratio is scale-free and runs an order of magnitude above every
points lane, because the divisor is routinely a fraction of a pound.

These remain calibration targets, not truths — the first thing to tune against
realised results per ROADMAP.md Phase 3B.

## 9. Files

| File | Change |
|---|---|
| `js/config.js` | Add `NOW_WINDOW_GWS`, `LONGTERM_*` scale, `FUNDS_MIN_CASH_FREED`. Change `FUTURE_WINDOW_GWS` 5→3, `FUTURE_MIN_FAR_GAIN` 0.5→1.5, `LANE_SCALE_FUTURE`, `LANE_SCALE_FUNDS`. |
| `js/engine/transfers.js` | Third scoring pass and cache. `now1XiDelta` / `long5XiDelta` / `far35XiDelta` on the swap. Rewrite `scoreNowLane` inline block, `scoreFutureLane`, `scoreFundsLane`. Add `scoreLongTermLane`. Update reasoning strings and MODEL comments. |
| `js/engine/strategy.js` | `longterm` in `LANE_SCALES` and `LANE_LABELS`. Reword `cashCrunch` message. |
| `js/modules/planner-boards.js` | Sixth `LANE_BOARDS` entry, new blurbs and units for now/future/funds, `LANE_DIRECTIONS.longterm`, new funds `emptyMessage`. |
| `js/modules/planner.js` | `_scoreCaches` gains a third map (2 sites). `computeBestTwoSwap` ranks by `lanes.longterm.value`, not `lanes.now.value` (2 sites). |
| `tests/engine/transfers.test.js` | New cases per §10. |

**No CSS change.** `.planner-board-grid` is
`repeat(auto-fit, minmax(20rem, 1fr))` and reflows to six cards unaided.

**`computeBestTwoSwap`.** It currently ranks two-transfer combinations by
`lanes.now.value`. With Now narrowed to one gameweek, a two-transfer plan —
which costs a −4 hit and is inherently a medium-term commitment — would be
optimised for a single Saturday. It moves to `lanes.longterm.value`.

## 10. Verification

**Unit tests** (`tests/engine/transfers.test.js`):

1. Funds scores 0 for a same-price move.
2. Funds scores 0 for a dearer move.
3. Funds scores 0 for a saving below `FUNDS_MIN_CASH_FREED`.
4. Funds ranks a small-saving-big-gain above a big-saving-small-gain
   (the ratio is doing the work, not the raw saving).
5. Funds value is negative — and so filtered off the board — for a
   cheaper-but-worse move.
6. Now and Long term diverge for a player with one strong week and four weak
   ones.
7. Long term's value is its per-GW delta times `horizon.gws`, with `hitCost`
   subtracted once rather than five times.
8. Future Prep's window covers the 3rd–5th upcoming gameweeks.

Regression baseline: 196 passing, 6 failing (`channel.test.js` ×5,
`composite.test.js` ×1) before this work. The 196 must still pass and the 6
must not grow.

**Live check.** `preview_start {name: 'gaffer-iq'}` (`.claude/devserver.py`,
serves static plus a real `/api/fpl` proxy), then `#planner`. Confirm on real
data: every Funds row shows a negative price delta; Now and Long term rows
differ; Future Prep's numbers sit on a three-gameweek scale. Read the raw lane
values through `javascript_tool` to set the §8 divisors, and correct them
before declaring done.

## 11. Found during implementation

Two things the design did not anticipate. Both are recorded here rather than
absorbed silently.

### 11.1 Structure Fix had to become a window total (resolved)

§3 listed Structure Fix as untouched. It reads the same delta the Long term
lane does, so leaving it per-gameweek would have printed the same swap as
"+4.7" on Structure Fix and "+23.5" on Long term, on one grid, with no visible
reason for the difference. That inconsistency would have been created by this
change, not inherited, so the lane now multiplies by the long window like its
neighbours and `LANE_SCALE_STRUCTURE` moved 10 → 33 to match. Its detection
rules are untouched.

### 11.2 The Funds ratio is dominated by micro-savings (open)

The points-per-£m ranking was chosen deliberately over "points gained, cheaper
only", with the risk stated at the time: a small saving with a big gain
outranks a large saving with a decent one. Live data at GW3 shows the effect is
not marginal — it decides the whole board.

Every qualifying row at the top freed £0.2–0.4m:

| Move | Freed | Gain (5 GW) | Ratio | Rank |
|---|---|---|---|---|
| Gravenberch → M.Sangaré | £0.2m | 17.7 | 88.5 | 1 |
| Rodon → Giles | £0.4m | 32.8 | 81.9 | 2 |
| Gravenberch → Lewis-Potter | £0.4m | 24.0 | 60.1 | 3 |
| **Cherki → Janelt** | **£2.8m** | **5.5** | **1.9** | **29** |
| Cherki → Scott | £1.8m | 7.6 | 4.2 | 27 |

A ratio is scale-free: dividing by 0.2 will beat dividing by 2.8 unless the
larger saving also carries ~14x the gain, which essentially never happens. So
the £2.8m-freeing move that also gains points ranks 29th and never reaches the
three-row board.

This matters because the motivating example was a **£0.9m** saving — squarely
in the range the ratio buries. The board is correct on its own terms (every row
IS cheaper and better, which is what was broken before) but it answers
"cheapest possible sidestep" more than "best value downgrade".

`FUNDS_MIN_CASH_FREED` does not fix this: raising it to £0.5m still leaves a
£0.5m move at ratio ~40 against a £2.8m move at ~1.9.

Three ways out, if the behaviour is unwanted:

1. **Rank by points gained, cheaper only** (the option not taken). Cherki →
   Janelt's 5.5 would rank on merit; the saving becomes a qualifier, not a
   ranker. Simplest, and matches "in order of value" most literally.
2. **Damp the divisor** — `pointsGained / sqrt(cashFreed)`, or
   `/ (cashFreed + k)`. Keeps some efficiency pressure without letting £0.2m
   dominate. Costs the clean "per £m" unit label.
3. **Raise the floor a lot** — `FUNDS_MIN_CASH_FREED` around £1.0m, making the
   board explicitly about meaningful war-chest moves. Narrows it sharply: only
   a handful of swaps qualified at that level in the GW3 sample.

Left as specified pending a decision.
