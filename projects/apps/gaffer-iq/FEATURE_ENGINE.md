# FEATURE_ENGINE.md

> **The analytical brain of Gaffer IQ.** This is the most important document in the project. It specifies every metric, every formula, every weight, and how they combine into the composite matchup score that the entire app is built on.
>
> Everything here is implemented as **pure functions** under `js/engine/` (see `ARCHITECTURE.md` §3, §8 and `CONVENTIONS.md` §3.3). Every tunable number named in this document lives in `js/config.js` — the formulas reference constants, never literals.
>
> **Reading order:** §1 conventions → §2–§7 individual metrics → §8 the composite → §9 horizon aggregation → §10 outputs → §11 how each module consumes it.

---

## 1. Universal conventions for all metrics

These rules make the metrics composable. Violating any of them silently corrupts the composite.

1. **Scale.** Every metric is normalised to **0–100**.
2. **Direction.** **Higher is always better *for the team being scored*.** A fixture score of 90 = a great fixture for *this* team; 10 = brutal. Team form 80 = in great form. Counter-matchup 75 = this team's attack is well-matched against the opponent's defence. Never let a metric default to "higher = harder"; if a raw input is naturally inverted (e.g. opponent strength), invert it during normalisation and leave a `// MODEL:` comment.
   - **One documented exception: `baseDifficulty` (§2).** It is stored as the opponent's strength (higher = harder) because the UI surfaces that number directly, and `engine/composite.js` inverts it at the weighting step. This is the *only* metric permitted to break this rule, and it is inverted exactly once, at that one boundary. Do not add another.
3. **Neutral point = 50.** Missing/blank inputs fall back to 50 (genuinely neutral), never 0. Absence of information is not evidence of a hard fixture.
4. **Perspective.** Almost everything is computed *from one team's point of view against a specific opponent in a specific fixture*. A fixture produces **two** scores — one per side — which are not simply complements of each other (home/away, form, and counter-matchups are asymmetric).
5. **Explainability.** Every metric returns enough to populate `CompositeScore.breakdown`. If a value used a fallback, flag `estimated: true`.
6. **Normalisation method.** Unless stated otherwise, raw values are normalised across the **current league population** using min–max with clamping to [0,100], then optionally re-centred. Use league-relative normalisation (not absolute thresholds) so the model self-calibrates as the season's data shifts. Min–max bounds are computed over all 20 teams (for team metrics) or all players in a position (for player metrics).

```
normaliseLinear(x, min, max) = clamp(0, 100, ((x - min) / (max - min)) * 100)
invert(score)               = 100 - score
```

---

## 2. Base fixture difficulty (`engine/fixtures.js → calcBaseDifficulty`)

**Purpose:** Anchor every fixture to FPL's own 1–5 fixture difficulty, on the engine's 0–100 scale, *before* form/counter/venue adjustments. This is the model's dependable floor: always published, never estimated.

**Input:** the fixture's own `team_h_difficulty` / `team_a_difficulty`, picked per side by the caller. Nothing else.

**MODEL (revised — this used to be a derivation).** It previously computed a strength read of its own: a 50/50 blend of the opponent's `strength_attack_*` and `strength_defence_*`, normalised across a hardcoded 1000–1400 band, then reduced by the §2.1 tenure curve, consulting FPL's FDR only as a fallback when those strength fields came back unpublished. It is now a straight lookup through `FDR_DIFFICULTY_VALUES`. Two reasons:

  1. **Honesty.** The row is labelled *Base FPL Difficulty* and sits on a card that also prints the raw FDR beside it. A 2/5 fixture reading 29 rather than 30 invites the reasonable question of what the number actually is, and the honest answer — "FPL's rating, plus a strength blend, minus a tenure curve, normalised against a hardcoded band" — was not what the label promised. Every 2/5 fixture now reads exactly 30 on every card.
  2. **The derivation added less than it looked.** Its inputs were FPL's own strength priors, seeded preseason and slow to move, so it was largely a re-expression of the same club prior the FDR already encodes. What genuinely corrects a stale prior in-season is `teamForm` — which is why that metric took a third of this change's freed weight (§8.1).

**Cost, stated plainly.** The output is now five discrete values, so every 3/5 fixture reads exactly 50 regardless of opponent, and §2.1's promoted-team tenure penalty no longer applies here. The second matters less than it sounds: FPL's FDR already rates promoted sides as easy fixtures, which is what the penalty existed to force. `calcTenurePenalty` remains exported (it is on `main.js`'s debug surface) but feeds no score.

> **⚠ DIRECTION EXCEPTION — read this before touching the formula.**
> Base difficulty is the **one** metric in the engine stored as **higher = HARDER for the team being scored**, contrary to §1 rule 2. It is stored that way because the Matchup Analyser surfaces it directly as "how tough is this opponent", and that is the reading the project owner wants on screen.
> `engine/composite.js` therefore applies `invert()` to this value before weighting it, so the composite still consumes a higher-is-better number. **Removing that `invert()` would make facing Man City raise a team's score.** Every other sub-metric follows §1 rule 2 unchanged.
>
> **This exception has a second consequence, found by Phase-2 audit: rendering must invert it too, separately from scoring.** `modules/matchup.js`'s breakdown row colours every metric by feeding its stored value into `bandFromValue()`, which assumes higher = better. For five of six rows that's correct as stored. For `baseDifficulty` it is **not** — a brutal fixture (strong opponent, high stored value) would band as `'great'` (green) if rendered raw. `buildBreakdownRows()` therefore calls `bandFromValue(invert(m.value))` for this one row only, while the **displayed number stays uninverted** (the opponent-strength reading is what's meant to be shown). Any future consumer of `breakdown.baseDifficulty.value` for colouring/banding — not just for display — must invert first. Consumers that only read the top-level composite `score.value`/`score.band` (ranker, dashboard, planner) are unaffected; they already receive the correctly-inverted composite.

**Model:** base difficulty is an **absolute read of the opponent**, not a relative edge between the two sides. A strong club posts the same high number in whoever's box it appears in — Man City are a hard fixture for Wolves and for Arsenal alike (~80 either way). Two weak sides meeting produces a low number on both sides of the tie; two strong sides produce a high number on both.

**Formula (scoring TEAM A at home vs TEAM B):**
```
fdr = fixture.team_h_difficulty            # team_a_difficulty when scoring the away side
baseDifficulty = FDR_DIFFICULTY_VALUES[fdr]
# 0-100, higher = HARDER for A
```

| FDR | Base difficulty |
|---|---|
| 1 | 10 |
| 2 | 30 |
| 3 | 50 |
| 4 | 70 |
| 5 | 90 |

- Evenly spaced on the midpoint of each fifth of the range. The endpoints stop short of 0 and 100 because FPL's scale has no "impossible" or "free" fixture, and an inverted 0 would read as a certainty the composite has no business expressing.
- Venue is already baked in: FPL publishes a separate rating per side, and the caller picks the one matching the team being scored. §3 layers a separate, data-driven home/away adjustment on top.
- A fixture FPL has not rated falls back to `FDR_MISSING_VALUE` (**50**) and is **still not flagged estimated** — this metric always being present is what guarantees §8.3's confidence denominator is never zero.

**Fallback (bugfix, confirmed live 2026/27 preseason):** the strengths are *usually* always present, but FPL has been observed leaving `strength_attack_home/away` and `strength_defence_home/away` at **0 for every team** before it has calculated the granular attack/defence breakdown for a new season — while `strength_overall_home/away` and the fixture's own FDR (`team_h_difficulty`/`team_a_difficulty`) are already published. A real strength int never reads 0 (the scale runs ~1000–1400), so `calcBaseDifficulty` treats "both fields exactly 0" as a reliable "not yet published" signal and substitutes the **team's own FPL FDR for that fixture** via a fixed lookup (`config.js → FDR_FALLBACK_VALUES`):
```
FDR 1 → 10   FDR 2 → 30   FDR 3 → 50   FDR 4 → 70   FDR 5 → 90
```
Same direction as the granular calc (higher = HARDER). This is real FPL data, not a guess, so it keeps `estimated: false` — same reasoning as the tenure penalty in §2.1. The breakdown extra `usedFdrFallback` records when this path fired, for auditability. Once FPL publishes real attack/defence values, the granular calc resumes automatically (the `=== 0` check simply stops matching).

---

## 2.1 Premier League tenure (`engine/fixtures.js → calcTenurePenalty`)

**Purpose:** FPL's `strength_*` priors systematically over-rate newly promoted sides — the numbers are seeded, not earned, so a club with no top-flight history can arrive rated close to an established mid-table side. Tenure corrects that, so a promoted opponent reads as the soft fixture it usually is.

**Inputs:** `PL_SEASONS` in `config.js` — a static table of which clubs contested each of the last `PL_TENURE_LOOKBACK` (default **15**) seasons, newest first.

**Join:** by club **name**, falling back to **short name**, resolved through `TEAM_NAME_ALIASES`. Both sides are normalised (lowercased, non-alphanumerics stripped) so `Nott'm Forest`, `nottm forest` and `NFO` all reach the same entry.
- **MODEL:** never join by FPL team id. Ids are reassigned each season as clubs go up and down, so an id join silently mismatches exactly the promoted and relegated clubs this metric exists to measure.

**Formula:**
```
seasonsAgo    = 0 for the most recent season in the table, 1 for the one before, …
recencyWeight = TENURE_RECENCY_DECAY ^ seasonsAgo          # default 0.85
tenureRatio   = Σ(present(s) * recencyWeight(s)) / Σ recencyWeight(s)    # 0–1
deficit       = 1 - tenureRatio
tenurePenalty = TENURE_MAX_PENALTY * (deficit ^ TENURE_CURVE)            # 0–40
```
- **MODEL:** presence is **recency-weighted, not counted**. A relegation last season says far more about a squad's current level than an absence eight years ago — at the default decay the newest season carries ~4.5× the weight of one eight seasons back.
- **MODEL:** `TENURE_CURVE` (default **2.0**) makes the punishment *curve* rather than ramp, so this stays a promoted-team rule instead of a tax on anyone who was ever in the Championship. Measured effect: Crystal Palace (13/15 seasons) **0.05 pts**, Brentford (5/15, all consecutive and recent) **6.10 pts**, a club never in the PL **40 pts**. A linear deficit gave Brentford ~12, which was wrong — five straight seasons up is established in practice.
- `TENURE_MAX_PENALTY` (default **40**) with `TENURE_FLOOR` (default **20**): a club with no recent top-flight history at all bottoms out at 20, not a token nudge. The `min()` in §2 guarantees the floor can never *raise* a club FPL already rates below it.
- An ever-present club scores `tenureRatio = 1` → penalty **0**. Established sides are therefore provably unaffected by this rule: the deduction is exactly zero, not merely small.
- A club absent from every season in the table scores 0 — the correct reading for a genuine newcomer, and the same reading a join failure would produce, so the two need not be distinguished.

**Direction of effect:** tenure is a **pure punishment on the opponent's reading**. It lowers the number shown in the *other* team's box — Coventry's thin history makes Arsenal's box read low (easy fixture), while Coventry's own box still shows Arsenal's full strength (hard fixture). The established side's own numbers are never touched.

**Estimated flag:** a low tenure reading is a **known fact, not missing data**, so `calcBaseDifficulty` keeps `estimated: false` throughout and confidence is unaffected. Only genuinely absent inputs set `estimated` (§8.3).

---

## 3. Home/away split performance (`engine/fixtures.js → calcHomeAwaySplit`, `calcVenueEffect`)

**Purpose:** Capture that teams perform very differently by venue, beyond FPL's static home/away strength integers. A team may be a fortress at home and feeble away in *actual results* this season.

### 3.1 Venue sensitivity — one team, standalone (`calcHomeAwaySplit(team, ctx)`)

**Inputs (Phase 3B — real cross-season data, replacing the earlier current-season-only design):** a rolling window of each team's most recent `VENUE_ROLLING_GAMES` matches (default **38** — one full PL season), sourced from real Understat match history via `buildRollingVenueStatsByTeamId` — spans the current season and, once that runs low, last season's tail, so the window reads as "roughly a full season" all year instead of resetting to nothing every August (the original complaint this phase fixes: the metric read flat/constant through preseason and early season). Falls back to the current-season-only FPL-fixtures reading (`ctx.playedFixtures`, same scope §4's H2H uses) for any team the rolling window doesn't cover — a genuine top-flight newcomer, or an Understat outage.
```
homePPG = points won per home game in the window       # 3 win / 1 draw / 0 loss
awayPPG = points won per away game in the window
```

**Data source and the three bugs this phase fixed** (all confirmed live, 2026-07-31, not hypothetical):
1. **The proxy was broken.** `api/fpl.js`'s Understat handler scraped `var teamsData = JSON.parse('...')` blocks out of Understat's page HTML — a scraping approach Understat's site no longer supports; that data now loads via the page's own internal `getLeagueData`/`getTeamData` XHR endpoints, confirmed by inspecting `document.scripts` (zero embedded JSON) against the network log (a `200 OK` XHR carrying the real payload). Every Understat call was returning `{"error":"parse_failed", detail:"No JSON.parse blocks found..."}`, silently, since some point after Phase 3A shipped — **independent of season**, so Style Clash's Understat axes had never received real data either. Fixed: the proxy now calls the real endpoints directly (`getLeagueData/EPL/{season}`, requires an `X-Requested-With: XMLHttpRequest` header and an explicit season — confirmed live, both endpoints 404 without one), and renames their `{teams, players, dates}` response to the client's existing `{teamsData, playersData, datesData}` contract, so no client code needed to change for this fix alone.
2. **Team matching was id-keyed.** The old `UNDERSTAT_TEAM_SLUGS` table mapped FPL's numeric `team.id → Understat slug` — but FPL ids are **reassigned every season** as clubs are promoted/relegated (`engine/normalise.js buildPlTenure`'s doc block already states this, correctly, for the tenure system — the Understat table simply didn't follow its own codebase's rule). Fixed: Understat teams are now matched by **name** via `canonicalClubKey` (`engine/normalise.js`, exported and shared with `buildPlTenure`), reusing the existing `TEAM_NAME_ALIASES` table (one addition: Understat's short form `'Tottenham'`, not FPL's `'Spurs'`). Verified live against all 20 real 2025/26 Understat team titles and all 20 real current-season FPL teams — 17/20 matched (the 3 misses were genuine promoted newcomers with no prior top-flight Understat history, not a matching failure).
3. **A stale `config.js` comment** claimed a blend with the FPL-strength prior below `MIN_VENUE_GAMES` — no such blend exists anywhere in this file; corrected to describe the actual hard cutoff.

**Formula:**
```
rawSplit = homePPG − awayPPG                          # SIGNED: negative = stronger away
baseSensitivity = normaliseLinear(|rawSplit|, across all teams' |rawSplit| values)
sign = sign(rawSplit)                                  # -1, 0, +1 — stored for transparency only
```
`baseSensitivity` (returned as `value`) answers "how much does venue matter for this team, either direction" — a team that is a fortress at home and one that is a fortress away score identically here; only `sign`, which nothing downstream consumes, tells them apart.

**MODEL:** below `MIN_VENUE_GAMES` (default 4) at **either** venue, in EITHER source tried (rolling, then fallback) → neutral 50, `estimated: false`. Deliberately the **one exception** to this engine's usual thin-sample guard (`calcTeamForm`, `calcFixtureHistory` both flag `estimated: true` below their thresholds): home advantage is treated as a standing structural fact about football, not a per-team read that can go missing — a team with no usable split simply reads as no additional edge over the baseline, rather than "unreliable, discard". This matters concretely under §8.3's confidence-based renormalisation: flagging it estimated would silently drop Home Advantage out of every promoted side's score, which is the behaviour this exception exists to avoid.

**MODEL — mixed-source normalisation pool:** the league-relative normalisation above may compare a team resolved from the 38-game rolling window against one on the thinner current-season fallback. Both report the same unit (points-per-game delta), just over different sample depths, so a fallback team reads slightly noisier against the pool, not wrongly-scaled — a deliberate simplification rather than maintaining two separate normalisation pools.

### 3.2 Venue effect — the fixture (`calcVenueEffect(homeTeam, awayTeam, ctx)`)

**Purpose:** venue sensitivity is a property of a team, but its *effect* is a property of a fixture — it takes both sides' sensitivity to say how much a home/away swing should matter here.

```
homeBase = calcHomeAwaySplit(homeTeam, ctx)
awayBase = calcHomeAwaySplit(awayTeam, ctx)
combinedMagnitude = (homeBase.value + awayBase.value) / 2
homeBoost   =  combinedMagnitude * W_VENUE_EFFECT
awayPenalty = -homeBoost
```
- `combinedMagnitude` is a **plain average of the two `baseSensitivity` values, regardless of whether their signs agree**. A team with a huge split paired with a perfectly neutral opponent still produces a real, non-zero effect — averaging with 0 halves it, it doesn't cancel it.
- **CONFIRMED SIMPLIFICATION — magnitude-only, sign is ignored:** a team that is actually *stronger away than home* (`sign = -1`) still contributes its full `baseSensitivity` to the **home** side's boost when it happens to be playing at home, exactly as a traditionally home-strong team would. The model reads as "large home/away splits amplify the standard structural home advantage", not "which way does each team's split point". `homeBase.sign` / `awayBase.sign` remain on the return value for transparency and future refinement, but `calcVenueEffect` does not read them.
- `W_VENUE_EFFECT` (default **0.5** in `config.js`, doubled from an original 0.25) caps the swing at ±50 composite-scale points when both teams are maximally venue-sensitive (`combinedMagnitude = 100`) — i.e. the full 0-100 range is reachable. Raised because in practice `combinedMagnitude` rarely nears its own ceiling, so observed values clustered in ~50-75 (home) / ~25-50 (away) at the old 0.25 — a linear rescale around the neutral 50 (an old reading of 68 becomes 86) stretches that into the full range without changing what drives it. `homeAway` is still only `WEIGHTS.homeAway` (0.10) of the composite, so this only changes how clearly the metric reads, not how much it can move the final score.
- **MODEL:** `calcVenueEffect.estimated = homeBase.estimated || awayBase.estimated` — always `false` in practice, since `calcHomeAwaySplit` never flags `estimated` (see above). Kept as an OR rather than hardcoded so this stays correct automatically if that policy ever changes.

**Composite wiring** (`engine/composite.js → computeRawFixtureScore`): for the team being scored,
```
venue.value = clamp(0, 100, 50 + (isHome ? homeBoost : awayPenalty))
```
so the two sides of one fixture are always symmetric around 50 — a large venue effect reads as roughly-but-not-exactly `x` / `100−x` (exact symmetry around 50, not a hard 100-sum like §7.2/§8.7's mirrored pairings, since this is an additive adjustment to a shared neutral point rather than a derived relative read). The "Home Advantage" / "Away Disadvantage" UI labels (`matchup.js`) are unchanged — they now read this recombined value instead of the old single-team, single-venue, league-relative-normalised number.

---

## 4. Fixture history / head-to-head (`engine/fixtures.js → calcFixtureHistory`)

**Purpose:** A small, deliberately low-weight nudge for persistent matchup patterns ("Team A always struggles at Team B").

**Inputs:** cross-season Understat fixture lists — `ctx.leagueXg.datesData` (this season), `ctx.leagueXgPrev.datesData` (last season), and every payload in `ctx.leagueXgHistory` (the seasons before those, newest first — `UNDERSTAT_HISTORY_SEASONS`, config.js; **six seasons in total** at time of writing) — each the FULL league schedule for that season (`{h:{title}, a:{title}, goals:{h,a}, isResult, datetime}` per match), not a per-team payload. Meetings between the two teams are pulled out by matching `h.title`/`a.title` against each team's name/shortName via `canonicalClubKey` (same resolver as §3.1's venue matching — never by Understat's own numeric ids). Falls back to `ctx.playedFixtures` (this-season-only FPL fixtures) when Understat has no name match for either team (promoted side, outage).

**Where the collection lives:** `engine/h2h.js → collectUnderstatMeetings()`. `calcFixtureHistory` narrows its rich records (date, season, venue, both scorelines, source) down to the three fields this formula needs. The Fixtures tab's Head-to-head view reads the SAME collector and keeps the records whole — one implementation of "which matches are meetings between these two clubs", two consumers, so the scorer and the view can never disagree about what a meeting is. `engine/h2h.js` additionally merges this season's FPL results over the Understat list for the view (de-duplicated per pairing per venue per season); `calcFixtureHistory` does not use that merge — its FPL fallback stays all-or-nothing, exactly as described above, so this metric's behaviour is unchanged.

**Formula:**
```
meetings = last N_H2H meetings across the 4 fetched seasons (default 8), oldest→newest
           falls back to this-season FPL fixtures if Understat found none
A_points = points A took across those meetings (3/1/0)
historyScore = (A_points / (3 * meetings.length)) * 100
```
- **NOT mirrored/zero-sum** (unlike §3.2's venue effect or §6.2's style clash) — each side's value is independently "% of available league points taken," so A and B's values do not need to sum to 100. Example: across 10 meetings where A won once and the other 9 were draws, A took 12/30 points → **40**, B took 9/30 → **30**. Both true simultaneously; nothing to balance.
- Two teams meet twice a season, so the six-season window puts ~12 meetings within reach for an ever-present pairing. `N_H2H=8` is therefore a REAL cap now, not just a description of the data's ceiling — it used never to bind, because four seasons topped out at 8 anyway. It is kept at 8 deliberately, and deliberately decoupled from the Fixtures tab's `H2H_MEETING_WINDOW` (10): that view is a record you read, this is a predictive nudge you weight, and a meeting five years old is a different squad, a different manager and often a different division — worth showing, not worth scoring on.
- **MODEL:** if fewer than 2 prior meetings exist (promoted teams, thin cross-season overlap, etc.), return **50** and flag `estimated: true`. This is also the sole confidence gate: composite confidence (§8.3) zeroes this metric's weight share whenever `estimated`, so a sub-2-meeting H2H never inflates prediction confidence. This factor has the lowest weight in §8 precisely because football H2H is weakly predictive even with real data.

---

## 5. Team form (`engine/form.js → calcTeamForm`)

**Purpose:** Recent trajectory, independent of FPL's player-level `form` field (which we do not use for team form).

**Inputs:** last `FORM_WINDOW_GWS` (default **5**) results for the team: win/draw/loss, goals for/against, and — critically — **opponent quality** so that beating strong teams counts more than beating weak ones.

**Formula:**
```
For each of the last FORM_WINDOW_GWS matches g:
  resultPoints(g) = 3 win / 1 draw / 0 loss
  oppAdj(g)       = opponent.strength_overall / LEAGUE_AVG_STRENGTH   # >1 if strong opp
  weightedPoints(g) = resultPoints(g) * oppAdj(g)
  recencyWeight(g)  = RECENCY_DECAY ^ (gwsAgo)        # default RECENCY_DECAY = 0.85

rawForm = Σ(weightedPoints(g) * recencyWeight(g)) / Σ(recencyWeight(g))
teamForm = normaliseLinear(rawForm, across all teams)
```
- `RECENCY_DECAY` (default **0.85**) makes the most recent match matter most. A decay of 1.0 = flat average; tune toward 0.7 to react faster to hot/cold streaks.
- The remaining weight, `W_FORM_PERFORMANCE` (default **0.2**), is an underlying-performance overlay blended into `rawForm` — xG-difference for that match where Understat has it, else that match's actual goal difference. Results are noisy over a 5-game window (one deflection or red card can dominate it); xG is the standard way to get a less noisy read without discarding actual results, which still carry the other 80%.
  - Opponent-adjustment on this term is **symmetric**, unlike the points term above: points floor at 0, so `oppAdj` there only ever amplifies credit for beating a strong side — a loss is 0 regardless of opponent. The performance overlay can go negative, so a good performance is still scaled up against a strong opponent, but a **bad** one is scaled by the *reciprocal* of `oppAdj` instead — pulled further negative against a weak opponent, pulled toward zero against a strong one. Losing badly to a relegation side is a worse signal about a team's own quality than losing the same way to a title contender; applying `oppAdj` unchanged to a negative value would have said the opposite.
  - Matched to a specific fixture by club name (`canonicalClubKey`, `engine/form.js` → `buildXgIndex`), the same convention `h2h.js`/`channel.js` use — never by either feed's numeric team id. Falls back to actual goal difference **per match**, not for the whole team, when Understat lacks that fixture or is unavailable entirely; a `null` xG reading on one match never discards the other four.
- Returns `{ value, trend, estimated, games, maturity }`. `trend` = sign/magnitude of the slope across the window (improving vs declining), used for UI arrows and as a tiebreaker, not in the composite.

**Maturity ramp (a thin window scales, it does not gate).** `maturity = games / FORM_WINDOW_GWS`, and `engine/composite.js` multiplies this metric's weight by it — so at the current `WEIGHTS.teamForm = 0.20`, one match played carries **1/5 of 20% = 4%** of the composite, three carry 12%, and five or more carry the full 20%. `estimated` is now reserved for its literal meaning, **no games at all**; from one game up the reading is real and the ramp expresses how much of it there is.

This replaced an all-or-nothing gate (`estimated: true` below `ceil(FORM_WINDOW_GWS / 2)`), which §8.3 reads as "discard entirely". Under that rule a team's first two matches counted for **nothing** and the third abruptly counted for the metric's full weight — a cliff, on the metric most worth having early. Same mechanism `engine/channel.js` already used for the counter-matchup, and the same reasoning: see `CHANNEL_MATURITY_FULL_MATCHES` in config.js. Mid-season behaviour is unchanged (five games in, maturity is 1).

The Matchup Analyser surfaces the ramp as an `n/N` counter beside the row — see §8.8.

---

## 6. Team style profiling & style clash score (`engine/style.js`)

> **⚠ `styleClash` IS NO LONGER IN THE COMPOSITE.** Its weight was removed and
> redistributed — see §8.1 for the three reasons. `engine/style.js` is untouched and
> `calcStyleClash` still works; it is simply not called by `engine/composite.js`, and
> `buildXgProfilesByTeamId` in the same file is still used (by §7 and the UI). This
> section is kept as the record of what the metric did, so restoring it is a matter of
> uncommenting rather than rebuilding.

**Purpose:** Some fixtures are "easy on paper" but stylistically dangerous (e.g. a possession-light counter-attacking side hosting a high line). This metric models *how two teams' styles interact*, not just how strong they are.

### 6.1 Style profile (`calcStyleProfile(team)`)

The profile carries two distinct groups of axes, and the distinction is the whole point of the metric.

**Quality axes** (xG-derived, Phase 3A). Retained for display and for pre-3B callers. **`STYLE_RULES` no longer consume these.**
```
attackDirectness  = normalise(xG per game,  league min–max)
defensiveHeight   = invert(normalise(xGA per game, league min–max))
tempo             = normalise((xG + xGA) per game, league min–max)
```

**Style axes** (Phase 3B — PPDA and deep completions from the same Understat `league/EPL` payload already fetched for xG). These are what the clash is computed from. Each 0–100, `null` when unavailable:
```
pressIntensity       = invert(normalise(PPDA))              # low PPDA = presses hard and high
buildUpControl       = normalise(PPDA-allowed)              # high = opponents can't disrupt our build-up
territorialThreat    = normalise(deep completions / game)   # sustained entries within ~20m of goal
defensiveCompactness = invert(normalise(deep conceded/game))# low conceded = compact block
transitionDirectness = normalise(npxG per deep completion)  # threat per entry: high = direct/transition
```

**Why the split exists.** The quality axes measure how *good* a team is, and team quality already enters the composite twice — `baseDifficulty` (0.30) and `teamForm` (0.16). A "style" verdict derived from them was largely restating who the better side is, at 0.10 weight, under a different name. Every 3B axis is deliberately **quality-neutral**: a mid-table side can press as hard as a title contender, and `transitionDirectness` is a *ratio*, so being good at football lifts numerator and denominator together.

Aggregation notes:
- PPDA is a ratio of two counts, so numerators and denominators are summed across the season and divided **once**. A mean of per-match ratios would let one low-possession match dominate.
- `npxG` (penalties stripped) feeds the style axes — a penalty is a restart, not evidence about open-field method.
- Understat publishes `ppda` as `{att, def}`; `readPpdaPair` also accepts a pre-divided number so a payload shape change degrades instead of silently zeroing a team.

**Availability is all-or-nothing per team** (`hasStyleAxes`). Every axis needs `ppda`, `ppda_allowed`, `deep` and `deep_allowed`, plus at least two teams in the league with usable inputs (no spread, no normalisation). When unavailable the axes are `null`, never `50` — a neutral-looking number is indistinguishable from a genuine mid-table reading, and the rules would happily multiply it into a confident-looking zero. **The FPL-proxy profile has no style axes at all**: goals and clean sheets describe outcomes, not method.

### 6.2 Style clash score (`calcStyleClash(teamA, teamB)`)
**Purpose:** translate the interaction of two profiles into an advantage for A. Style clash is about *mismatches*, so it is computed as directional matchups, not similarity.

**Signed products, not co-activation.** Each rule contributes:
```
aDev = (A[axisA] − 50) / 50        # −1..+1
bDev = (B[axisB] − 50) / 50        # −1..+1
term = ruleSign * ruleMagnitude * aDev * bDev
```
All four quadrants are meaningful, because a style is an *exposure*, not a switch. The pre-3B version used `max(0, aDev) * max(0, bDev)`, which could only ever express "both teams high on their axis" and discarded every mismatch — the only situations a style clash exists to find. It also documented an interaction (a high-tempo B dragging a low-tempo A into a game it dislikes) that the co-activation formula made **mathematically unreachable**.

The three rules in `config.js → STYLE_RULES`, with the reading in every quadrant:

| Rule | Quadrant | Reading |
|---|---|---|
| `pressIntensity` × `buildUpControl`, sign −1, mag 12 | A presses / B poor under pressure | turnovers in dangerous areas → **+** |
| | A presses / B press-resistant | the press is played through → **−** |
| | A sits off / B press-resistant | the standard way to smother a possession side → **+** |
| | A sits off / B poor under pressure | A declines the obvious route to hurt them → **−** |
| `transitionDirectness` × `pressIntensity`, sign +1, mag 10 | A direct / B high press | ball in behind the high line → **+** |
| | A direct / B deep block | direct balls into a packed box → **−** |
| | A patient / B high press | A gets pinned trying to play out → **−** |
| | A patient / B deep block | no press to beat, A builds freely → **+** |
| `territorialThreat` × `defensiveCompactness`, sign −1, mag 8 | A territorial / B compact | possession without penetration → **−** |
| | A territorial / B open | repeatedly played through → **+** |
| | A not territorial / B compact | B's main defensive strength is idle → **+** |
| | A not territorial / B open | A can't exploit the openness → **−** |

A high press is mechanically a high line — you cannot press the ball 60 yards from your own goal with a deep block — which is what licenses `pressIntensity` standing in for "space in behind" in rule 2.

**Mirroring (the two sides total exactly 100).** Running the rules once from A's side gives an absolute read that cannot be compared across a fixture: A's rules ask "does A's press trouble B's build-up?", B's rules ask a different question about different axes, so two awkward-to-play-against sides both score well and the fixture looks good for everyone. Same fix as §7.2's mirrored pairings and §8.7's relative composite — *derive, don't independently compute*:
```
deltaOwn = rules applied A-against-B
deltaOpp = rules applied B-against-A
edge     = deltaOwn − deltaOpp
styleClash = clamp(0, 100, 50 + edge / 2)
```
Halving the gap is what puts the pair on a shared 100. `calcStyleClash(B, A)` computes the identical pair in swapped order, so it always returns `50 − edge/2`, and `clamp(0,100,v) + clamp(0,100,100−v) ≡ 100` for every real `v` — **exact, including at the rails**. Worked example: raw reads of 50 and 80 become 35 and 65 — the 30-point gap survives intact, it is only re-centred on 50.

**Range in practice.** Theoretical cap is 50 ± 30 (Σ magnitudes). Against 20 teams with independent axes the observed spread is roughly p10 45 → p90 55, tails to ~35/65. At 0.10 weight that is typically ±0.5 composite points and at most ~±1.5 — a genuine tiebreaker on a 50/50 fixture, never a driver.

- Rules and magnitudes live in `config.js` as a declarative table (`STYLE_RULES`), editable without touching logic.
- **MODEL:** the score is a flagged neutral 50 unless **both** sides have real style axes *and* enough matches (`>= MIN_VENUE_GAMES`). On an Understat outage every fixture returns 50 rather than a style verdict inferred from goals — absence of information is not evidence (§1 rule 3). A flagged 50 costs nothing downstream: §8.6 skips estimated metrics entirely and §8.3 drops confidence to match.
- `calcStyleClash` returns `terms` and `opponentTerms` (per-rule `aDev`, `bDev`, `contribution`) so the matchup UI can name *which* stylistic factors moved the number rather than just printing it (`ARCHITECTURE.md` §12 rule 6).

---

## 7. Player-level metrics

### 7.1 Player form (`engine/form.js → calcPlayerForm`)
**Purpose:** A truer read than FPL's `form` field (which is just average points over ~30 days and ignores minutes risk and per-90 efficiency).

**Inputs:** player `history[]` (per-GW points, minutes, goals, assists, xG, xA where present).
```
window = last PLAYER_FORM_GWS gameweeks (default 5)

per90Output = points over window / (minutes over window / 90)     # efficiency
minutesSecurity = minutes over window / (90 * gamesAvailable)      # 0–1, nailed-on starter?
xgOverlay = (xG+xA over window) per90    # underlying-numbers sanity check vs actual returns

rawPlayerForm = (W_RETURNS * per90Output_norm)
              + (W_MINUTES * minutesSecurity * 100)
              + (W_UNDERLYING * xgOverlay_norm)
playerForm = clamp(0,100, rawPlayerForm)
```
- Defaults in `config.js`: `W_RETURNS = 0.5`, `W_MINUTES = 0.3`, `W_UNDERLYING = 0.2`.
- **MODEL:** `minutesSecurity` is weighted heavily on purpose — an explosive player who doesn't start is near-useless in FPL. A player flagged injured/suspended (`status != available`) is multiplied by an availability factor (`AVAIL_PENALTY`, default 0.4) and flagged.
- `xgOverlay` lets the ranker spot players over/under-performing their underlying numbers (regression candidates). Returned in the breakdown for the UI.
- Normalisation for `per90Output` and `xgOverlay` is **position-relative** (a FWD's per-90 points distribution differs from a DEF's).

> Note: `W_MINUTES` here is **not** the whole of the model's minutes handling. It makes minutes-security part of the *form* read; §7.3 additionally makes playing likelihood a first-class term in the player projection (§10). The double-counting is deliberate — see §10.

### 7.2 Position counter-matchup score (`engine/counter.js → calcCounterMatchup`)
**Purpose:** The signature Gaffer IQ metric. Asks: *given the positions involved, how does one team's attacking unit match up against the specific defensive unit it will face?* Phase 1 is **position-based only** (per project scope), not individual player-vs-player tracking.

**Position pairings modelled (Phase 1):**
```
ATTACKER GROUP (of team A)        vs   DEFENSIVE GROUP (of team B)
  FWDs (strikers)                       CBs (central defenders)
  wide MIDs / wingers                   FBs (full-backs)
  central attacking MIDs                CBs + defensive MIDs (shielding)
```
Position grouping is tiered by evidence quality: an Understat chain signature
(`buildupShare = xGBuildup/xGChain`, `createBias = xA90/(xA90+npxG90)`) where
the player is name-matched and clears `ROLE_SIGNATURE_MIN_MINUTES`; FPL ICT
component shares otherwise; raw `element_type` when neither has signal.
`buildupShare` measures positional depth and is quality-neutral
(`corr(buildupShare, xGChain/90) = +0.008` across 102 regular 2025 defenders,
vs `corr(buildupShare, xA/90) = −0.654`), which ICT `threat` share is not.
`createBias` prevents set-piece centre-backs being misfiled as fullbacks.
See the design spec `docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md` §4.

Role grouping degrades **per player**, not per team: Phase 3C's fail-closed
90% coverage bar is replaced by `ROLE_CHAIN_COVERAGE_MIN` (0.75 of outfield
MINUTES). Below that share the roles are still used but the metric is flagged
`estimated`, rather than the whole squad collapsing to `element_type`.

**Formula (counter-matchup for A's attack vs B's defence):**
```
For each modelled pairing p (e.g. A.FWDs vs B.CBs):
  attackUnitForm(p)  = minutes-weighted mean playerForm of A's players in the attacking group
  defenceUnitForm(p) = minutes-weighted mean playerForm of B's players in the defensive group
  # If A's in-form strikers face B's out-of-form CBs → big advantage for A.
  pairingEdge(p) = attackUnitForm(p) - defenceUnitForm(p)        # signed
  pairingScore(p) = clamp(0,100, 50 + pairingEdge(p) * COUNTER_SENSITIVITY)

counterMatchup = Σ (pairingScore(p) * PAIRING_WEIGHT(p)) / Σ PAIRING_WEIGHT(p)
```

`attackUnitForm` prefers the **chain** read — the minutes-weighted mean of
`xGChain/90` across the unit, normalised through `CHAIN_UNIT_ANCHORS` — and
falls back to the minutes-weighted `calcPlayerForm` mean when Understat has no
match. Each pairing reports which was used as `attackSource: 'chain'|'form'`.
`defenceUnitForm` is unchanged: Understat publishes no per-player defensive
data, so there is nothing to replace `calcPlayerForm` with on that side.

**Channel tier (`engine/channel.js → calcChannelCounter`).** When both teams'
Understat `statistics` payloads are cached, the counter is scored on three
independent axes instead of position pairings:

```
axisEdge(a)  = attackShare_A(a) − concedeShare_B(a)
axisScore(a) = clamp(0,100, 50 + (axisEdge(a) / CHANNEL_AXIS_POOLED_SD[a]) * CHANNEL_SENSITIVITY)
value        = Σ axisScore(a) * CHANNEL_WEIGHTS[a] / Σ CHANNEL_WEIGHTS[a]
```

Axes: `setPieceThreat` (dead-ball share of non-penalty xG, weight 0.50),
`wideTransition` (Fast share of attack-speed xG, 0.30), `boxThreat` (in-box
share of shot-zone xG, 0.20). No open-play axis exists — `openPlayShare` is
identically `1 − setPieceShare`. The league baseline cancels out of every edge
because each team's xG-for in an axis is another team's xG-against, so no
league-wide sweep is needed to centre the scores. The mirrored Defending
Counters stay arithmetic (`100 − attacking`), preserving the identity above.

**Channel is the only tier (revised 2026-08-21).** The `role` and `element`
position-pairing ladders are retired — commented out in place in
`engine/counter.js`, not deleted, with a re-enable note. `calcCounterMatchup`
always returns the channel read. When Understat has published nothing for a
team, it returns a blank shell: the three rows still render (as `—`), `value`
is `null`, and `maturity` is 0, so the metric contributes nothing at all rather
than falling back to a different model. `classifyRole`, `buildRoleSignature`,
`classifyRoleFromSignature` and the `ROLE_*` groups remain LIVE — channel
personnel weighting and `duelsForPairing` depend on them.

**Maturity ramp.** A shot threshold (`CHANNEL_MATURITY_FULL_SHOTS`, 120) was
originally a gate: below it a team had no profile and the metric fell back until
roughly GW10, costing a quarter of the season on the one signal this tier exists
to provide. It became the top of a ramp, and the ramp now counts **matches**:

```
maturity(team)    = clamp(0, 1, matchesPlayed / CHANNEL_MATURITY_FULL_MATCHES)
maturity(pairing) = min(maturity(A), maturity(B))
effectiveWeight   = WEIGHTS.counterMatchup * maturity(pairing)
```

`matchesPlayed` is counted from the team's own Understat `datesData` (rows with
`isResult`). Absent or empty leaves it at 0, so the profile is built but carries
no weight — abstaining on an unknown depth rather than claiming a confidence
that cannot be evidenced.

**Why matches and not shots.** Shots were the statistically tighter reading:
what makes a share stable is the number of events in its thinnest bucket
(set pieces, ~25% of shots), and shot volume varies by roughly **67%** across the
league. Measured on a completed season:

| Team | Shots/match | Matches to 120 shots |
|---|---|---|
| Man City | 15.6 | 7.7 |
| Liverpool | 15.4 | 7.8 |
| Arsenal | 14.6 | 8.2 |
| Everton | 11.1 | 10.8 |
| Sunderland | 10.4 | 11.6 |
| Burnley | 9.3 | 12.8 |

It was dropped anyway, deliberately. The correction is small exactly where it
matters — a point or two of a 0.25-weight metric, well under half a composite
point, invisible on the card. What it cost was legibility, which is not small: a
shot-driven counter ticks 0, 1 or 2 in a given week and needs a "matches' WORTH
of shot data, not matches played" caveat to be read correctly at all. A metric
nobody can read is worse than one that is slightly loose about when a
low-volume side reaches full confidence.

The consequence to keep in mind: **Burnley and Man City now reach full weight at
the same point**, on profiles that differ in event count by about two-thirds.

Effective weight is now exactly linear in matches played, and identical for
every club — `0.025 → 0.05 → 0.10 → 0.15 → 0.225 → 0.25` across
1/2/4/6/9/10+ matches, against `WEIGHTS.counterMatchup` of 0.25. (Under the old
shot-driven ramp the same series was club-dependent and read roughly
`0.02 → 0.043 → 0.085 → 0.128 → 0.192 → 0.20` for an average-volume side.)
A thin profile still scores and is still displayed; it simply cannot swing a
fixture.

**`maturity` is not `estimated`.** `estimated` means "this reading is a
fallback, don't use it" and always wins. `maturity` means "this reading is
real, but built on N% of the evidence it eventually will be". A channel profile
is never `estimated` while it has axes, however thin — conflating the two would
collapse the ramp back into the gate it replaced.

`attackShare` is scaled by `channelPersonnelFactor` — the availability-weighted
share of the axis unit's season xGChain that is fit this week, clamped to
0.80–1.20. Self-normalising against the same unit, so a fully fit team scores
exactly 1.0 regardless of quality. This is what lets a season aggregate react
to an injury.
- `PAIRING_WEIGHT` lets the FWD-vs-CB pairing matter more than winger-vs-FB by default (`config.js`). `COUNTER_SENSITIVITY` (default scaled so a 20-point form gap moves the pairing ~±20) controls responsiveness.
- "Defence unit form" uses the **defensive** read of `calcPlayerForm` for defenders (clean sheets, goals conceded while on pitch, defensive contribution) rather than attacking returns. Document this dual-mode in `counter.js`.
- **MODEL:** uses minutes-weighting so likely starters drive the score, not fringe squad players. If a unit can't be assembled (missing data), fall back to team-level `strength_attack`/`strength_defence` and flag `estimated: true`.
- This metric is **asymmetric**: A's attack vs B's defence is a different number from B's attack vs A's defence. Each team's composite uses *its own* attacking counter-matchup.

**Defending Counters (`calcCounterMatchupMirrored`) — UI-explanatory only, Phase 4:**
The Matchup Analyser shows two labelled sections per team card: **Attacking Counters** (`calcCounterMatchup`, above — this team's attack vs the opponent's defence) and **Defending Counters** — the same interaction, re-read from the defending side, so a viewer can see "my defence vs their attack" without mentally inverting the other team's card.

`calcCounterMatchupMirrored(attackingResult)` takes an *already-computed* `calcCounterMatchup` result (the opponent's attack against this team's defence) and derives each mirrored pairing as:
```
mirroredPairing(p).value = 100 - attackingPairing(p).value
```

**Every other field is carried across by spread**, not by an explicit list. This matters: the function originally enumerated the fields to copy (`attackForm`, `defenceForm`, `attackerCount`, `defenderCount`), and when the channel tier replaced the position tier (2026-08-21) that list was never updated. Each mirrored pairing then copied four fields that no longer existed and dropped the three the active tier actually produces (`attackShare`, `concedeShare`, `personnel`). The Matchup Analyser decides how to format a pairing by testing `attackShare !== undefined`, so every **Defending Counters** row fell through to the retired tier's formatter and rendered `Def — / Atk —`: correct scores, blank detail line, for as long as the channel tier had been live. Spreading keeps whatever the active tier emits and cannot go stale again if the position tier is switched back on.
This is **not** a second independent `50 + edge * SENSITIVITY` calculation — it is arithmetically derived from the same computed edge, so `attackingValue + mirroredValue === 100` **exactly**, by construction, **for every pairing**. The identity holds even through `clamp(0,100,...)`: for any real `y`, `100 - clamp(0,100,y) === clamp(0,100,100-y)` (trivial by cases: `y<0` → `100-0=100` and `clamp(100-y)=clamp(>100)=100`; `y>100` → `100-100=0` and `clamp(100-y)=clamp(<0)=0`; `0≤y≤100` → both sides equal `100-y`). Verified numerically against real (non-synthetic-formula) pairing data: `stVsCb (67.590909) + cbVsSt (32.409091) = 100.0000000000`, `wmVsFb (54.216756) + fbVsWm (45.783244) = 100.0000000000`, `cmVsCbDm (56.703717) + cbDmVsCm (43.296283) = 100.0000000000`, aggregate `61.177534 + 38.822466 = 100.0000000000`.

**Precision caveat (aggregate only).** The per-pairing identity is exact in
IEEE-754 as well as in real arithmetic — `v` and `100 - v` cancel bit-for-bit.
The **aggregate** is a different object: `attackingValue` and `mirroredValue`
are two independently accumulated weighted means, each carrying its own
rounding, so `Σ(100−vᵢ)wᵢ/Σwᵢ + Σvᵢwᵢ/Σwᵢ` is exactly 100 in real arithmetic
but can land 1 ulp away in floating point. Measured over 200,000 random pairing
triples: ~21% miss by 1 ulp on `ROLE_PAIRING_WEIGHTS` (1.0/0.6/0.5), ~6% on
`PAIRING_WEIGHTS` and on `CHANNEL_WEIGHTS`. This is a property of summing in
floating point, not of the derivation, and it long predates the channel tier.
Assert the aggregate with an epsilon — `window.__verify.zeroSum` and
`tests/engine/counter.test.js` both use `1e-6`, eight orders of magnitude
looser than the worst observed deviation (~1.4e-14). Assert per-pairing sums
strictly.

Pairing key mirrors (`cbVsSt`, `fbVsWm`, `cbDmVsCm` for role-mode; `cbVsFwd`, `fbVsWideMid`, `cbMidVsCam` for the element-type fallback) live in `engine/counter.js`'s `MIRRORED_PAIRING_KEYS`.

**Composite score: now blended (`engine/counter.js → calcCombinedCounterMatchup`).** Originally the mirrored pairings above were display-only — `scoreFixture`'s `WEIGHTS.counterMatchup` consumed only `calcCounterMatchup`'s attacking `value`, so a team's own defensive quality against this opponent's attack earned no direct credit on its own composite (only an indirect, heavily-diluted one via the opponent's raw score in the §8.7 relative step — see the worked Man City/Bournemouth example below). A team with an elite defence but a "mid" attack had that defensive strength essentially invisible to its own card.

`computeRawFixtureScore` (`engine/composite.js`) now computes both directions and blends them:
```
attackingCounter = calcCounterMatchup(team, opponent, ctx)                          # team's attack vs opponent's defence
defendingCounter = calcCounterMatchupMirrored(calcCounterMatchup(opponent, team, ctx)) # team's defence vs opponent's attack
counter = calcCombinedCounterMatchup(attackingCounter, defendingCounter)
        = clamp(0, 100, COUNTER_ATTACK_WEIGHT * attackingCounter.value + COUNTER_DEFENCE_WEIGHT * defendingCounter.value)
```
`COUNTER_ATTACK_WEIGHT = COUNTER_DEFENCE_WEIGHT = 0.5` (`config.js`) — an even split; neither pairing is a more "primary" read than the other. `counter.pairings` stays the unblended **attacking** pairings (so the Matchup Analyser's Attacking Counters rows and its `calcCounterMatchupMirrored` call for Defending Counters keep reading pure attacking data, preserving the sum-to-100 identity above). The unblended inputs are exposed as `breakdown.counterMatchup.attackingValue`/`.defendingValue` so the blend stays explainable (ARCHITECTURE.md §12 rule 6) — the Matchup Analyser's Score Breakdown row shows both in a tooltip.

**MODEL — a subtlety worth stating plainly:** because `defendingCounter` is *entirely derived* from the opponent's own `attackingCounter` (`100 - opponentAttackingValue`), blending it into a team's raw composite at the SAME total `WEIGHTS.counterMatchup` would be a no-op for the final §8.7 relative score's linear term — the algebra collapses back to exactly `WEIGHTS.counterMatchup * (attackingA - attackingB)` regardless of the attack/defence split chosen, since the two teams' raw composites both end up encoding the identical `attackingA`/`attackingB` pair either way. Blending alone only changes what's *displayed* per side (now honest about both pairings) and slightly perturbs the nonlinear §8.6 stacking penalty (which reads the raw `counter.value`, not the linear edge). To make defensive strength genuinely move the final predicted score — not just the breakdown display — `WEIGHTS.counterMatchup` itself was raised (§8.1) so the now-doubled underlying signal carries proportionally more real weight in the composite.

**Pairing → named players (`duelsForPairing`).** Each pairing row in the Matchup Analyser carries an info disclosure listing the actual players behind its score. `duelsForPairing(duels, pairingKey)` is a pure filter over an existing `calcIndividualDuels` result (§7.4) — it deliberately does **not** re-identify players, so a pairing's named players can never disagree with the duel scores they were derived from. A `PAIRING_ROLE_ALIAS` table collapses all three key families (role-mode `stVsCb…`, element-fallback `fwdVsCb…`, defending mirrors `cbVsSt…`) onto the canonical role-mode key, then filters duels whose `attacker.role` and `defender.role` both fall in that pairing's `ROLE_ATTACK_GROUPS`/`ROLE_DEFENCE_GROUPS`. For a **defending** pairing the relevant duels are the **opponent's** attacking duels, since a defending pairing is their attack against this team's defence. Returns `[]` when duels are unavailable (no summaries / no ICT data) — the common case, since duels need lazily-fetched player summaries — and the UI then omits the player list entirely. It deliberately does not announce the absence: the pairing score is computed from team-level shot data and does not use duels at all, so a notice there would read as a warning about a score that is in fact complete.

---

## 7.3 Playing likelihood (`engine/form.js → calcPlayingLikelihood`)

**Purpose:** answer "will this player actually be on the pitch next gameweek?" as a standalone 0–100 metric, so the player projection (§10) can weight it directly rather than relying on it leaking through the form term.

**Inputs — two independent necessary conditions:**
```
startShare   = minutesSecurity * 100          # backward: has he been starting?
availability = chance_of_playing_next_round   # forward: is he fit and permitted?
               ?? STATUS_PLAY_CHANCE[status]  # fallback when FPL gives null

playingLikelihood = min(startShare, availability)      # 0–100, higher = better
```
- **MODEL: `min()`, not a weighted blend.** Either condition alone can rule a player out, so the binding constraint is what matters. A nailed starter who is injured cannot play (→ ~0). A fully fit squad player still won't start (→ his low start share). Averaging the two would wrongly rescue *both* cases — which was precisely the Ranker failure this metric exists to fix: fringe players carrying scores they had no route to delivering.
- **`availability` prefers FPL's own `chance_of_playing_next_round`** — a real percentage FPL publishes from press-conference news, not a proxy. Normalised onto `Player.chanceOfPlayingNext` (see `ARCHITECTURE.md` §8). It is `null` for the majority of players because FPL populates it **only when there is news**, so `null` means *"no doubt reported"*, never *"no data"* — hence the status fallback rather than an `estimated` flag.
- **`STATUS_PLAY_CHANCE`** (`config.js`) maps the internal status string when FPL gives no number: `available: 100`, `doubtful: 50`, `injured / suspended / unavailable: 0`. Doubtful sits at the midpoint because FPL's own scale for a flagged player is 25/50/75; when it declines to give a number, halfway is the honest read.
- **`estimated`** is inherited from the `calcPlayerForm` result passed in: without per-GW history, `minutesSecurity` is the crude season-minutes proxy, so `startShare` is only as good as that.
- Takes an already-computed `PlayerForm` as its second argument rather than recomputing — `scorePlayer` and `engine/chips.js` both already hold one, so this avoids doubling the work per player.

### 7.4 Individual player-vs-player duels (`engine/counter.js → calcIndividualDuels`)

Supplementary to §7.2's position-group aggregate: pairs specific players (a striker against the centre-back he will most likely face) using a likely XI picked by `minutesSecurity` against a 4-4-2 baseline, then scores that single duel with the same `50 + edge * COUNTER_SENSITIVITY` shape. Returns the top 5 by absolute form differential. Consumed by the Matchup Analyser's per-pairing info disclosures via `duelsForPairing` (§7.2), which is now its only reader — the standalone "Individual Duels" section at the foot of each card was removed, since a flat top-N list repeated players every pairing already names in the context that gives them meaning. Does not feed the composite.

---

## 7.3b Playtime security (`engine/form.js → calcPlaytimeSecurity`)

**Output:** `0–1`, higher = more secure a place in the starting XI. Banded to a label by `playtimeBand()` against `PLAYTIME_BANDS`.

Answers a different question from §7.3. `calcPlayingLikelihood` asks *"will he be on the pitch this weekend"* and feeds `PROJ_MINUTES` in the projection. This asks *"how safe is his place in the side"*, and drives the Ranker's Playtime column only — it is **not** a weighted term in any composite, because `PROJ_MINUTES` already carries minutes and a second term would double-count them.

### Why the old column was wrong

The Playtime column previously banded `calcPlayerForm`'s `minutesSecurity`. In the fallback branch — which is the branch essentially every Ranker row takes, because element summaries are lazily fetched (ARCHITECTURE.md §6) and are absent for almost the whole pool — that was:

```js
minutesSecurity = minutes / (SEASON_GWS * 90)     // 38 × 90 = 3420
```

A player who had started and completed every match scored `90/3420 = 0.03` after GW1 and `0.53` by GW20, against a `Rotation` threshold of `0.40`. The column therefore read `Risk` for nearly the entire pool for most of the season, and because `W_MINUTES` puts the same figure inside the form score, it quietly suppressed every player's form too. The denominator is now elapsed gameweeks, not the whole season.

(The likely-XI selection in `engine/counter.js` also sorts on `minutesSecurity`. It was unaffected: the bug scaled every player by the same constant, so the relative ordering it depends on was preserved.)

### Inputs

All four are available for the **whole pool** from `bootstrap-static` alone. Anything requiring element-summary history would be null for almost every row the Ranker draws, which is what made the old proxy necessary in the first place.

| Term | Formula | Why |
|---|---|---|
| `startRate` | `starts ÷ elapsedGws` | Starting is the binary that matters most in FPL. |
| `minutesShare` | `minutes ÷ (elapsedGws × 90)` | What fraction of a starting slot he actually holds. Catches the nailed starter who is hooked on 60 every week — `startRate` alone scores him identically to a player finishing matches. |
| `completion` | `minutes ÷ (starts × 90)` | Does he see games out? Deliberately the smallest weight: a late substitution is ordinary squad management, not insecurity. |
| `crowding` | `bodies ÷ slots` in the club's group at his position | How many players the club is actually rotating through the position. |

`slots` is derived, not assumed: `groupMinutes ÷ (elapsedGws × 90)`, so a back four playing every minute totals four slots' worth of minutes and a manager switching to a back three moves the figure without anyone hard-coding a formation. `bodies` counts group members clearing `PLAYTIME_BODY_SHARE` of one slot.

### Combination

```
base  = PLAYTIME_W_START      × startRate
      + PLAYTIME_W_MINUTES    × minutesShare
      + PLAYTIME_W_COMPLETION × completion          # weights sum to 1

crowdingRisk = clamp(0,1, (crowding − 1) / (PLAYTIME_CROWDING_FULL − 1))
             × (1 − minutesShare)

value = clamp(0,1, base − PLAYTIME_W_CROWDING × crowdingRisk) × (availability / 100)
```

Crowding is scaled by `(1 − minutesShare)` for a specific reason: the crowding figure is a property of the **club's position group**, identical for every player in it. Left unscaled it would punish a nailed starter at a squad-heavy club exactly as hard as his rotating team-mate. Scaling it means it barely touches a player already commanding his slot, and bites hardest on the genuinely rotated — which is the distinction the column exists to draw.

Availability multiplies rather than caps: an injured player with a cast-iron place is still a zero for the gameweek in front of him.

### Early-season shrinkage

Both rate terms are shrunk toward a prior worth `PLAYTIME_PRIOR_GWS` gameweeks of evidence:

```
startRate = (starts + PLAYTIME_PRIOR_GWS × prior) / (elapsedGws + PLAYTIME_PRIOR_GWS)
```

**MODEL:** with one match played, a raw start rate is either `0.0` or `1.0` and neither is believable. The prior comes from the player's price percentile **within his position**, mapped onto `PLAYTIME_PRIOR_MIN … PLAYTIME_PRIOR_MAX` — price is the only pool-wide, forward-looking role signal FPL exposes before a ball is kicked, and the game prices nailed-on starters up and bench fodder down. Position-relative because a £5.5m defender and a £5.5m forward imply completely different roles. The prior dominates in GW1–2 and is effectively irrelevant by ~GW10. While it still outweighs the observed record the result carries `estimated: true`, and the badge renders dashed.

### elapsedGws

Derived from the data, not from a gameweek counter: the highest season minutes total in the pool, ÷ 90, rounded. The most-played footballer in the league defines how many rounds have actually been played, which stays honest through postponements, blanks and doubles — and needs no agreement about whether `currentGw` means "in progress" or "last completed". Computed once per context in `buildScoreContext` (`buildPlaytimeContext`), alongside the per-player prior and crowding figures, because all three are `O(pool)` aggregates and recomputing them per player would make a full-pool render quadratic.

---

## 8. The composite matchup score (`engine/composite.js → scoreFixture`)

This is where everything combines into the single 0–100 number (per team, per fixture) that drives the whole app.

### 8.1 Default weights (`config.js → WEIGHTS`)
```
WEIGHTS = {
  baseDifficulty:  0.35,   // strength priors — the dependable floor
  counterMatchup:  0.20,   // attacking AND defending pairings blended (§7.2)
  teamForm:        0.15,   // recent trajectory, opponent-adjusted
  history:         0.15,   // H2H nudge — real cross-season data (§4)
  homeAway:        0.05,   // venue performance this season
  styleClash:      0.10    // stylistic interaction — Understat xG-backed (Phase 3A)
}   // sums to 1.00
```
Rationale for the ordering:
- **Base difficulty (0.35):** the largest single weight, raised again from 0.30. Opponent quality is the only sub-metric that is *never* estimated — it is available from day one of a season and does not degrade when player summaries or Understat data are missing. The 5 points cut from home/away below were banked here rather than spread around, since it's the one weight §8.3's confidence renormalisation never has to discount.
- **Counter-matchup (0.20):** Gaffer IQ's signature metric — blends both pairings (`calcCombinedCounterMatchup`, §7.2), so a team's own attack AND defence both earn direct credit on its own composite.
- **Form (0.15)** and **H2H (0.15):** raised to parity once §4's `calcFixtureHistory` moved off this-season-only FPL fixtures onto real cross-season Understat match data (up to `N_H2H=8` real meetings, drawn from a six-season window) — no longer thin enough to justify a token weight. Live-checked case: Fulham vs Chelsea's actual 4-2 record over 6 meetings now resolves to 67/33, not a flat 50/50.
- **Home/away (0.05):** cut from 0.10. Still real, but the smallest of the six — even doubled sensitivity (§3.2's `W_VENUE_EFFECT`) makes it a clearer *read*, not a bigger *driver*, and this pass explicitly reduces how much it can move the score.
  Full history of this table (`config.js` §8.1):

  | Weight | Phase 1 | Pre-rebalance | Prior | Previous | **Current** |
  |---|---|---|---|---|---|
  | `baseDifficulty` | 0.33 | 0.30 | 0.30 | 0.35 | **0.40** |
  | `counterMatchup` | 0.22 | 0.28 | 0.20 | 0.20 | **0.25** |
  | `teamForm` | 0.18 | 0.16 | 0.15 | 0.15 | **0.20** |
  | `history` | 0.03 | 0.03 | 0.15 | 0.15 | **0.10** |
  | `homeAway` | 0.13 | 0.13 | 0.10 | 0.05 | 0.05 |
  | `styleClash` | 0.11 | 0.10 | 0.10 | 0.10 | **— removed** |

**Why `styleClash` was removed (§6 kept for reference).** Three reasons, in order of weight:
  1. **It substantially restated `counterMatchup`.** Two of its three rules — directness × their press, territory × their compactness — describe the same interaction §7.2 already reads from real shot situations and locations, at double the weight and from the same Understat payload. Two correlated weak predictors are worse than one: the shared noise is counted twice while the dependable metrics are diluted.
  2. **Season-aggregate style is not a stable team property.** PPDA is a per-opponent game-plan decision, not a trait — a side presses a promoted team and sits off against a title contender. Averaging that across a season and applying it to one fixture assumes an exogeneity football does not have. The same objection undercuts the high-line assumption behind rule 2.
  3. **The magnitude could not change a decision.** Observed spread was ~45–55, so at 0.10 it moved the composite by roughly ±0.5 points — too small to flip a call, large enough to add noise whenever the mechanism read a fixture wrong.

**Why `history` fell 0.15 → 0.10.** It is **not opponent-quality-adjusted**, unlike `teamForm`. A lopsided H2H record therefore mostly restates *who has been the better side*, which `baseDifficulty` and `teamForm` already say from far larger samples; the genuine "bogey team" signal is the residual after the quality gap is removed, and §4 never isolates it. Its earlier raise to 0.15 also reasoned from better DATA (cross-season Understat) to a bigger EFFECT — better data narrows the error bars around a near-zero signal, it does not enlarge the signal. Kept non-zero because it is the one cheap pairing-specific read available.

**Where the freed 0.15 went.** Evenly, three ways. `counterMatchup` because it inherits `styleClash`'s job on better evidence and is most of what makes this score differ from FPL's own FDR. `teamForm` because it corrects `baseDifficulty`'s preseason-seeded priors in-season — it captures what the largest metric structurally cannot, which is better diversification than topping up the largest metric itself. `baseDifficulty` because it is the only metric that is never estimated.

> **Early-season note.** `counterMatchup` and `teamForm` both ramp (§5, §7.2), and they now total 0.45. In the opening weeks §8.3's renormalisation therefore leans the composite harder on `baseDifficulty` than it does mid-season. That is correct behaviour, not a fault — but the first month will read closer to FPL's FDR than the rest of the season does.

> **The base-difficulty weight and the §8.6 stacking penalty are a matched pair.** Raising base difficulty on its own would make a strong favourite's score nearly immovable — no realistic combination of secondary metrics could shift it. §8.6 is what restores the ability of *several* bad secondary signals to tip a fixture, without letting any *single* one do so. Do not tune one without re-checking the other.

### 8.2 Combination
```
confidence =                                      # computed FIRST — linearValue divides by it
    (baseDifficulty.estimated ? 0 : WEIGHTS.baseDifficulty)
  + (counterMatchup.estimated ? 0 : WEIGHTS.counterMatchup)
  + (teamForm.estimated       ? 0 : WEIGHTS.teamForm)
  + (history.estimated        ? 0 : WEIGHTS.history)
  + (homeAway.estimated       ? 0 : WEIGHTS.homeAway)
  + (styleClash.estimated     ? 0 : WEIGHTS.styleClash)

rawWeightedSum =                                  # estimated sub-metrics contribute ZERO here
    (baseDifficulty.estimated ? 0 : WEIGHTS.baseDifficulty * invert(baseDifficulty))  # §2 direction exception
  + (counterMatchup.estimated ? 0 : WEIGHTS.counterMatchup * counterMatchup)
  + (teamForm.estimated       ? 0 : WEIGHTS.teamForm       * teamForm)
  + (history.estimated        ? 0 : WEIGHTS.history        * history)
  + (homeAway.estimated       ? 0 : WEIGHTS.homeAway       * homeAway)
  + (styleClash.estimated     ? 0 : WEIGHTS.styleClash     * styleClash)  # all sub-metrics already 0–100

linearValue = confidence > 0 ? rawWeightedSum / confidence : 50   # re-normalised to the considered share

ownRawValue = clamp(0, 100, linearValue - stackingPenalty)   # §8.6 — independent, per-team

# §8.7 — NOT the final value. See §8.7 for why an independent per-team read
# must be compared against the SAME fixture's other team before it's final.
edge  = ownRawValue - opponentRawValue
value = clamp(0, 100, 50 + edge * RELATIVE_EDGE_SENSITIVITY)
```

### 8.3 Confidence handling
- Each sub-metric reports `estimated: true|false`. The composite computes **confidence** = weighted share of non-estimated metrics FIRST. If confidence < `CONFIDENCE_FLOOR` (default 0.5), the UI shows the score as provisional (e.g. hatched/greyed) — the number is still produced, never hidden.
- **MODEL (revised 2026-08-21):** each sub-metric contributes `weight × maturity`, where `maturity` comes from `metricMaturity()` (`engine/composite.js`) — 0 when the metric is `estimated`, 1 when it reports no maturity of its own, and anything in between when it does. `confidence` is the sum of those maturity-weighted shares and remains the re-normalisation denominator, so the identity still holds exactly: whatever weight actually applied is scaled back up to cover the full 0–1 range. Today only `counterMatchup` reports a partial maturity (see §7.2's ramp); the other five are binary and behave precisely as they did before. The mechanism is general — any metric can opt in by returning a `maturity` field, with no change to the blend.
- **MODEL:** estimated sub-metrics are **excluded entirely** from `linearValue`'s weighted sum (maturity 0), and the remaining weights are **re-normalised** (divided by `confidence`) so they cover the full 0–1 range — e.g. a fixture where only 55% of the weight is non-estimated has that 55% scaled up to count as 100% of the score, exactly as `confidence` reports it. This replaced an earlier design where estimated metrics passed through at their fallback value (usually 50) and only lowered `confidence` without changing `value` — a genuinely unreliable reading no longer dilutes the score at full weight by masquerading as a neutral 50; it simply doesn't count.
- `baseDifficulty` is never estimated (§8.1) — it's available from day one of a season and never degrades — so `confidence` is always > 0 and the division above never hits its zero-guard in practice.
- `homeAway` is a deliberate exception: `calcHomeAwaySplit`/`calcVenueEffect` never flag `estimated` at all (§3.1), so Home Advantage / Away Disadvantage always counts toward both `confidence` and `linearValue`, even for a side with no usable venue history.

### 8.4 Bands (`config.js → BANDS_V2`)
`value` maps to a band string (drives colour everywhere — see `CONVENTIONS.md` §5.2). One scale, seven tiers, every 0–100 integer in the app:
```
80–100 → 'excellent' (gold, glowing)
65–79  → 'great'     (green)
57–64  → 'good'      (light blue)
44–56  → 'neutral'   (grey)
36–43  → 'tough'     (yellow)
21–35  → 'brutal'    (red)
 0–20  → 'extreme'   (black, dark red ink and border)
```
Thresholds are config, not literals, so the palette can be re-calibrated after observing a season's distribution. Symmetric around the neutral midpoint (50).

**What it replaced, and why.** The previous scale had five tiers — `great` 75+ (dark green), `good` 60–74 (green), `neutral` 41–59 (grey), `tough` 26–40 (amber), `brutal` 0–25 (red) — and spent its resolution in the wrong place. Its top band was 26 points wide and did all its work below 85, so a genuinely exceptional fixture and a merely strong one shared a colour; everything below 26 was likewise lumped together. Those two ends are exactly the numbers a user acts on — the ones to build around and the ones to avoid outright — so `'excellent'` splits the top and `'extreme'` mirrors it at the bottom.

Two other things moved with it. The neutral band widened by two points either side (41–59 → 44–56), because a value that close to even is not worth colouring. And `'good'` moved off green: the old scale spent two of its five tiers on greens that had to be told apart at 14px on the Full Season ribbon, which they could not be. One green now means one thing. It landed on a deep blue first and has since lifted to a light one — the deep blue was the darkest hue in the scale and read as heavier than the green above it, which is backwards for the second-best tier.

**Where the band is attached.** `bandFromValue` (exported from `engine/composite.js`) is the single implementation, and `CompositeScore.band` carries its result — surfaces read `score.band` rather than re-deriving it. It **rounds before comparing**, because every surface displays `Math.round(value)`: banding the raw value would label a displayed "44" as `tough` whenever the true value was 43.6. The label therefore always agrees with the number printed beside it, at every boundary.

**Two things deliberately did NOT follow the scale.**
- `engine/season.js → isLoadedWeek` tests against `SEASON_LOADED_MIN_VALUE` (75), a fixed number of its own. It used to read the old top band's foot, which was also 75; following the band across would have loosened the bar to 65 and lit up half the season.
- Anything that borrowed a band colour to mean something that is not a rating — an away fixture, a postponed tag, an import error — reads a **primitive** token instead (`CONVENTIONS.md` §5.3). Left on the semantic token, "error" would have followed `brutal` off red onto orange and back again.

### 8.5 Output shape (matches `ARCHITECTURE.md` §8)
```js
CompositeScore = {
  value: 56,                     // §8.7 — the FINAL, relative-to-opponent value
  band: 'neutral',
  confidence: 0.78,              // §8.7 — min(this team's, opponent's) confidence
  breakdown: {                   // still explains ownRawValue below, unchanged by §8.7
    baseDifficulty: { value: 68, weight: 0.25, estimated: false },
    counterMatchup: { value: 81, weight: 0.25, estimated: false },
    teamForm:       { value: 70, weight: 0.20, estimated: false },
    homeAway:       { value: 75, weight: 0.15, estimated: false },
    styleClash:     { value: 55, weight: 0.11, estimated: false },
    history:        { value: 50, weight: 0.03, estimated: true  }
  },
  stacking: {                    // §8.6 — adjustment ACROSS sub-metrics
    linearValue: 76.4,           // weighted sum before the penalty
    penalty: 3.4,                // points deducted
    stackIndex: 0.27,            // 0–1 severity-weighted share
    countUnfavourable: 2,        // secondaries below the pivot
    consideredWeight: 0.67,      // non-estimated secondary weight in play
    pivot: 45
  },
  relative: {                    // §8.7 — adjustment ACROSS the two teams' totals
    ownRawValue: 73,             // = linearValue - stacking.penalty (76.4-3.4); this
                                 //   is what `value` meant before §8.7 existed
    opponentRawValue: 61,        // the opponent's own independent read, same fixture
    edge: 12,                    // ownRawValue - opponentRawValue
    sensitivity: 0.5             // config: RELATIVE_EDGE_SENSITIVITY
  }
}
// value = clamp(0, 100, 50 + 12 * 0.5) = 56. breakdown/stacking still fully
// explain ownRawValue (73); relative explains the further step from 73 to 56.

---

## 8.6 Stacking penalty (`engine/composite.js → calcStackingPenalty`)

**Purpose:** make the composite behave *conditionally* rather than purely linearly, so a fixture that looks good on the dependable signal stays good when one thing goes wrong, but genuinely tips when several go wrong together.

**The problem with a plain weighted sum.** It degrades linearly: the first poor secondary metric costs a favourite exactly as much as the third does. Real fixtures don't work that way. A side facing a weak opponent still has a strong chance if only one factor is against them — but they genuinely lose that chance when a poor venue record, poor form *and* a losing counter-matchup all arrive at once. A linear model cannot express "resilient to one, vulnerable to three."

**Formula:**
```
STACK_METRICS = [counterMatchup, teamForm, history, homeAway]
                # baseDifficulty EXCLUDED — see below
                # styleClash removed with the metric itself (§8.1)

for each m in STACK_METRICS:
    if m.estimated:            skip entirely (do not count its weight)
    earned = m.weight * metricMaturity(m)         # what it actually carries
    if earned == 0:            skip entirely
    consideredWeight += earned
    if m.value >= STACK_PIVOT: continue           # metric is fine
    shortfallWeighted += earned * (STACK_PIVOT - m.value) / STACK_PIVOT

stackIndex     = clamp(0, 1, shortfallWeighted / consideredWeight)      # 0–1
stackingPenalty = STACK_MAX_PENALTY * (stackIndex ^ STACK_CURVE)        # 0–45
```
- **Weighed by what a metric has EARNED, not by its configured maximum.** A metric on a maturity ramp (§5's teamForm, §7.2's counterMatchup) contributes `weight × maturity` here, the same quantity §8.3's sum uses. Counting a one-game form reading at its full 15% while the score itself counted 3% would let evidence the composite barely trusts drive a penalty at full force — precisely the asymmetry the ramp exists to remove. A metric reporting no maturity is unaffected (`metricMaturity` treats it as 1).
- `STACK_PIVOT` = **45**, `STACK_CURVE` = **2.0**, `STACK_MAX_PENALTY` = **45** (`config.js`).
- **The exponent is the mechanism.** Above 1 it makes the punishment *curve* rather than *ramp*. At 2.0 the three-unfavourable case takes roughly **9.8×** the penalty of the one-unfavourable case, despite its stack index being only ~3× larger. Lower toward 1.0 to make secondary metrics bite earlier and more linearly.
- **Same shape and same reasoning as `calcTenurePenalty` (§2.1)** — `MAX * (deficit ^ CURVE)`, curve 2.0. The engine deliberately keeps one idiom for "punish genuine stacking, not incidental single dips."

**Why `baseDifficulty` is excluded:** it is the reading the resilience is measured *relative to*, not one of the things that can pile up against a team. Including it would mean a hard fixture penalised itself twice — once through its own 0.33 weight and again through the stack.

**Why `STACK_PIVOT` sits below 50:** every estimated sub-metric falls back to exactly 50 (§8.3). A pivot at or above 50 would penalise the entire league whenever data is thin — i.e. most of pre-season.

**Why estimated metrics are excluded entirely** (rather than passed through at 50, as §8.3 does for the weighted sum): §1 rule 3 — *absence of information is not evidence of a hard fixture*. A data gap must never manufacture a penalty. The remaining non-estimated weights are re-normalised via `consideredWeight`, so a fixture with only two loaded secondaries is judged on those two, not diluted by three unknowns.

**Worked behaviour** (strong home favourite, `baseDifficulty` 25 = weak opponent, weights as §8.1 — note: these specific decimals predate the §7.2 counter-matchup blend/reweight and are kept as-is; the stacking-curve mechanism they illustrate is unaffected by that change, only the exact numbers would shift slightly under the current weights):

| Scenario | Secondaries below pivot | Linear sum | `stackIndex` | Penalty | Final | Band |
|---|---|---|---|---|---|---|
| One weak secondary (`homeAway` 20) | 1 of 5 | 58.82 | 0.108 | **−0.52** | **58.30** | neutral |
| Three weak (`homeAway` 20, `teamForm` 25, `counter` 30) | 3 of 5 | 46.00 | 0.337 | **−5.10** | **40.90** | tough |
| All five mildly weak (all at 40) | 5 of 5 | — | 0.111 | **−0.56** | — | — |
| All five at 0 (total collapse) | 5 of 5 | — | 1.000 | **−45.00** | — | — |
| Pre-season, all estimated | 0 (skipped) | — | 0.000 | **0.00** | — | — |

The favourite keeps its edge on one bad metric (costs 0.52) but drops **17.40 points and a full band** once three stack. Note the fourth row: *widespread but mild* weakness stays near-free — a merely mediocre side is not the "stacked against them" case, and the curve is what keeps those two situations distinct.

**Explainability:** the adjustment is reported on `CompositeScore.stacking` (see §8.5), not inside `breakdown`, because it is an interaction *across* sub-metrics and has no weight of its own in `WEIGHTS`. Any gap between `stacking.linearValue` and `relative.ownRawValue` is fully accounted for by `stacking.penalty` — **but note `relative.ownRawValue`, not the top-level `value`**, since §8.7. The further gap between `ownRawValue` and `value` is what §8.7's `relative` explains.

---

## 8.7 Relative (zero-sum) composite (`engine/composite.js → scoreFixture`, `computeRawFixtureScore`)

**Purpose:** make the two teams' total composite scores for the same fixture sum to exactly 100, so a score reflects genuine relative strength between the two sides rather than each side being marked against a fixed internal scale independently of who they're actually playing.

**The problem this fixes.** Every sub-metric above (§2–§7) is computed independently per team, against a fixed scale, with no reference to the opponent's own equivalent read. Concretely, `calcBaseDifficulty(team, opponent, ...)` normalises the **opponent's** raw strength against the fixed `OPP_STRENGTH_MIN/MAX = 1000/1400` — it never looks at `team`'s own strength. The consequence, traced with real numbers:

| Fixture | A's baseDifficulty term | B's baseDifficulty term | Sum (should track ~33 for zero-sum) |
|---|---|---|---|
| Two weak teams (strength 1000 vs 1000) | 33.0 | 33.0 | **66.0** — both rewarded for facing a "soft" opponent |
| Two strong teams (strength 1400 vs 1400) | 0.0 | 0.0 | **0.0** — both punished for facing a "tough" opponent |
| Uneven, not extreme (1400 vs 1200) | 16.5 | 0.0 | **16.5** — no consistent relationship at all |

(baseDifficulty is one of six weighted terms; the same independence applies to `teamForm`, `homeAway`, `styleClash`, `counterMatchup`, `history` — none of them compare team A's read to team B's either.) Two strong teams shouldn't both score harshly just because the opponent is individually tough, and two weak teams shouldn't both score well just because neither is "objectively good" — what matters is whether either side has a real edge over the other, and today's independent absolute reads cannot express that.

**Design.** `scoreFixture` no longer returns an independent per-team read directly. The old function body — every sub-metric, the weighted sum, and the §8.6 stacking penalty, all completely unchanged — is now `computeRawFixtureScore(team, opponent, fixture, isHome, ctx)`, an internal (not exported) helper producing the **independent** pre-relative value (`ownRawValue`). `scoreFixture(team, fixture, ctx)` calls this helper **twice** — once for `team`'s own perspective, once for the opponent's — and derives the final value from their difference:

```
ownRawValue      = computeRawFixtureScore(team, opponent, ...).value        # §2-§8.6, unchanged
opponentRawValue = computeRawFixtureScore(opponent, team, ...).value        # same formula, swapped

edge  = ownRawValue - opponentRawValue
value = clamp(0, 100, 50 + edge * RELATIVE_EDGE_SENSITIVITY)               # RELATIVE_EDGE_SENSITIVITY = 0.5
```

**Why this guarantees zero-sum BY CONSTRUCTION, not coincidence.** `scoreFixture(opponent, fixture, ctx)` computes the *identical* `(ownRawValue, opponentRawValue)` pair in swapped roles, so its value is *always* `clamp(0, 100, 50 - edge * RELATIVE_EDGE_SENSITIVITY)` — literally 100 minus this team's pre-clamp figure. `clamp(0,100,v) + clamp(0,100,100-v) ≡ 100` is a general identity for clamp-to-`[0,100]`, true for every real `v` (trivial by cases: below 0 one side clamps to 0 and the other's mirror exceeds 100 and clamps to 100; above 100 the reverse; in range neither clamps and they sum algebraically). This is the same "derive, don't independently compute" principle §7.2 already uses for the mirrored counter-matchup pairings (`mirroredValue = 100 - attackingValue`) — extended here to the whole fixture total. Verified by exhaustive sampling (20,000 random `(ownRawValue, opponentRawValue)` pairs spanning the full `[0,100]²` input space, including clamp-saturating extremes): worst observed `|sum - 100|` was `0` to floating-point precision.

**`RELATIVE_EDGE_SENSITIVITY = 0.5` is not an arbitrary softening constant.** At exactly 0.5, an edge spanning the theoretical full range (`ownRawValue=100, opponentRawValue=0`, edge=±100) maps to the full `[0,100]` output range with the clamp only ever touching the boundary exactly, never saturating early. Raising it above 0.5 makes *smaller* real edges reach 0/100 sooner (a more binary read of a given gap); it does not affect the zero-sum guarantee, which holds at any sensitivity value via the identity above.

**This does NOT flatten every fixture toward 50/50 — and does NOT touch the promoted-team logic.** `calcBaseDifficulty` and `calcTenurePenalty` (§2, §2.1) are completely unchanged; a promoted side's `ownRawValue` still comes out low (their opponent's undiminished strength inverts to near-0) and an established side's `opponentRawValue` reading of that same promoted side is still pulled further down by the tenure penalty. Both of those genuine, real differences flow straight into `edge` — a big real gap produces a big edge, and therefore a lopsided (not 50/50) split. Only the *relationship* (sum ≈ 100) is new; the *size* of the split is still driven entirely by the real, unmodified strength/form/tenure gap between the two teams.

**Worked examples** (`WEIGHTS` and `STACK_*` as §8.1/§8.6; `own`/`opp` = each team's independent `computeRawFixtureScore` — note: these specific decimals predate the §7.2 counter-matchup blend/reweight and are kept as-is; the zero-sum identity they illustrate is unaffected by that change, only the exact numbers would shift slightly under the current weights):

| Fixture | A's raw (independent) | B's raw (independent) | edge | **A's final** | **B's final** | Sum |
|---|---|---|---|---|---|---|
| Two weak teams (Ipswich vs Hull, strength 1000/1000, near-identical mediocre form) | 64.77 | 64.77 | 0.0 | **50.0** | **50.0** | **100.0** |
| Two strong teams (Man City vs Arsenal, strength 1400/1400, both in form) | 39.01 | 39.01 | 0.0 | **50.0** | **50.0** | **100.0** |
| Promoted vs established (Arsenal, full tenure, vs Coventry, tenure 0.0 — realistic secondaries: Coventry's own form/venue/counter also weak, Arsenal's strong) | 73.98 | 22.52 | 51.46 | **75.73** | **24.27** | **100.0** |

The first two rows are the direct fix: under the old model neither team's absolute raw read was itself meaningful evidence of an edge — Ipswich and Hull both land at 64.77 (both reading a weak opponent generously) and City/Arsenal both land at 39.01 (both reading a tough opponent harshly), yet in both cases the two sides are IDENTICAL, so the honest relative read is exactly 50/50. What matters is the *difference* between the two reads, not their shared absolute level — and that difference is genuinely 0 when neither side has a real edge. The third row shows the promoted-team asymmetry surviving completely intact: a **75.73 / 24.27** split, clearly lopsided, still summing to exactly 100.

**Downstream effects — verified, not assumed:**
- `scoreOverHorizon`, `rankPlayers`, `scorePlayer`, and every module (`ranker.js`, `dashboard.js`, `planner.js`, `matchup.js`) read only `.value`/`.band`/`.confidence`/`.provisional`/`.breakdown` — all still present with the same types, so nothing breaks structurally. The *numbers* shift (by design): a player's fixture outlook is now genuinely "how favourable is this specific matchup" rather than "how strong is my team in the abstract" — an intended, more meaningful ripple into `scorePlayer`'s `PROJ_FIXTURE` term, not a bug.
- `confidence` is now `min(own, opponent)` confidence, not just `team`'s own — because the final value depends on both sides' reads, it can only be as trustworthy as the less-certain one. Both teams' Matchup Analyser cards for the same fixture will now show the *same* confidence percentage; this is intentional (§8.5).
- `CompositeScore.breakdown` still explains `relative.ownRawValue` exactly (§8.5/§8.6's identities hold for `ownRawValue`), but no longer arithmetically reconstructs the top-level `value` on its own — `relative` is required to close that gap. The Matchup Analyser's existing breakdown rows are unchanged and still correct for what they show (`ownRawValue`'s composition); they do not currently render the new `relative` field. Flagged as a follow-up, not implemented here (out of this change's scope): surfacing `relative.opponentRawValue`/`edge` somewhere on the card would let a user see *why* the headline number differs from a manual sum of the breakdown rows.
- Perf: `scoreFixture` now does roughly double the internal work per call (`computeRawFixtureScore` runs for both sides every time). `engine/chips.js` already memoises `scoreFixture` per `(team, fixture)` pair (`makeFxCache`), so chip planning is unaffected. `rankPlayers`/`scorePlayer` have no such cache and call `scoreOverHorizon` (and therefore `scoreFixture`) once per player with no memoisation across players sharing a team — this was already uncached before this change; it is now roughly twice as expensive per call. Not addressed here (a caching layer for `scorePlayer`/`rankPlayers` is a separate concern, unscoped for this change) but worth knowing if Ranker load time is ever noticeably slow.
- **Further perf note (§7.2 counter-matchup blend):** `computeRawFixtureScore` itself now calls `calcCounterMatchup` twice per side (once for the attacking read, once for the opponent's attacking read that feeds the defending mirror) instead of once, roughly doubling the counter-matchup-specific cost on top of the doubling above. Same reasoning applies: no caching added, not addressed here, worth knowing if Ranker load time grows noticeably.

---

## 8.8 How the breakdown is displayed (`js/modules/matchup.js → buildBreakdownRows`)

Presentation, not model — recorded here because it is the surface that has to
tell the truth about §8.3's weighting, and getting that wrong makes a correct
model look broken.

**Row order is derived, not written down.** `METRIC_ORDER` sorts `WEIGHTS`
descending, with `METRIC_TIEBREAK` separating metrics on equal weight
(`teamForm` and `history` are both 0.15). The hand-maintained list it replaced
had already drifted out of step with a reweighting — `homeAway` (5%) was sitting
above `styleClash` (10%). Reweight in `config.js` and the card reorders itself.

**The `%` column is the metric's configured MAXIMUM, and it is static.** It
answers "how much can this row ever matter", which is a property of the model,
not of today's data. It previously printed the *applied* weight
(`effectiveWeight`), which made a ramping metric read `0%` early in the season —
indistinguishable from a metric that had been switched off.

**A ramping metric carries an `n/N` counter instead**, between the label and the
bar, shown only while `maturity < 1`. The two numbers then say different things:
`N%` is the ceiling, `n/N` is the progress toward it. Both are derived from the
same `maturity` the engine applied, so they cannot disagree with the score.

| Metric | `N` | Unit |
|---|---|---|
| `teamForm` | `FORM_WINDOW_GWS` (5) | matches played |
| `counterMatchup` | `CHANNEL_MATURITY_FULL_MATCHES` (10) | matches played, by the thinner of the two sides |

Both are a literal count of matches, so both counters tick exactly once per
match and neither needs a caveat about its unit. `counterMatchup` keeps one
genuine wrinkle the tooltip names: it is a **pairing** reading, not a team one.
`calcCombinedCounterMatchup` takes `min()` of the two sides' maturities — a
blend is only as well-evidenced as its weaker half — so a team several matches
in still shows a low counter against a newly promoted opponent.

`done` uses **`Math.round`, clamped to `N - 1`**. Round rather than floor
because `maturity * total` is a float division round-tripped: `3/5 * 5` is
`2.9999999999999996`, which floor turns into 2. The clamp guards the top, so a
metric at 96% cannot round up to `10/10` and claim a completeness it has not
reached — unreachable anyway, since `maturity >= 1` hides the counter.

### 8.8.1 Counter pairing "i" panels (`buildPairingExplainer`)

Each Attacking/Defending Counters row opens onto a disclosure panel. It used to
contain only the named players behind the pairing, which answered *who is
involved* but never *what am I looking at* — the score and its two percentages
were documented nowhere in the UI, so they read as arbitrary. The panel now
leads with an explanation and keeps the player list beneath it — when there is
one. Duels depend on lazily-fetched player summaries, so the common case is no
players at all; that section is now simply absent rather than carrying a
"not loaded yet" notice, which appeared in every panel and read as a caveat
about the score. It is not one — the pairing score comes from team-level shot
data and never consults duels.

The explanation states, for the row's own axis:

- that **both percentages are shares of a team's own xG, not volumes** — they describe *how* a side scores and concedes, not how much. This is the single most misreadable thing about the section: "Box Occupation — Def 97%" invites reading as "this team is terrible in the box" when it means "97% of what they concede is from inside it", which is close to normal for everyone.
- what each share measures, phrased from the perspective of the section it sits in (a Defending Counters row leads with the defensive share, matching the score row above it).
- the personnel scaling, **only when it is not 1** — a line saying "scaled to 100%" is noise.
- that the score feeds Counter-Matchup, at a weight read live from `WEIGHTS.counterMatchup` rather than written into the copy, so a rebalance cannot leave the text lying.

**Deliberately descriptive, not directional.** The panel says what each figure
*measures* and stops there — it does not tell the reader which way a high score
should be read. That is a considered omission, not an oversight:
`calcChannelCounter` scores an axis as `attackShare − concedeShare`, which
*rises as the opponent concedes less through that channel* — the reverse of the
"my strength meets their weakness" reading §7.2's model comment describes.
Verified with controlled inputs at the documented league spread (set-piece share
0.170–0.370): a side that specialises in set pieces facing one that leaks them
scores **50**, while the same side facing one that defends them well scores
**91**. Until that direction is settled, copy asserting an interpretation would
document behaviour the engine does not have.

---

## 9. Horizon aggregation (`engine/composite.js → scoreOverHorizon`)

Single-fixture scores are aggregated across a horizon (1, 3, or 6 GWs — see `ARCHITECTURE.md` §9).

```
fixtures = team's fixtures within the horizon window (handle blanks & doubles!)

For each fixture f in window:
  s(f)        = scoreFixture(team, f).value
  gwWeight(f) = HORIZON_DECAY ^ (gwOffset(f))     # default HORIZON_DECAY = 0.9; nearer GWs matter more

aggregateMean = Σ(s(f) * gwWeight(f)) / Σ gwWeight(f)
aggregateMin  = min(s(f))                          # the "trap" detector — worst fixture in the run

horizonScore = (AGG_METHOD == 'mean') ? aggregateMean
             : (AGG_METHOD == 'min')  ? aggregateMin
             : (W_MEAN * aggregateMean + W_MIN * aggregateMin)   # 'blend' (default)
```
- **Default `AGG_METHOD = 'blend'`** with `W_MEAN = 0.75`, `W_MIN = 0.25` — rewards a good run but punishes a single brutal fixture hiding in an otherwise green sequence (critical for transfer/captaincy decisions). All in `config.js`.
- **`HORIZON_DECAY` (0.9):** GW+0 weighted fully, GW+5 weighted ~0.59. Reflects that near fixtures are more certain and more decision-relevant.
- **Blank GW handling:** a team with no fixture in a GW contributes a configurable `BLANK_GW_VALUE` (default **40** — a blank is mildly bad for that team's assets, not neutral, because you get zero return). It is included in the aggregation, never silently skipped. Flagged in the breakdown.
- **Double GW handling:** a gameweek's fixtures are **collapsed to one aggregation entry** — their mean — and the extra fixture is then priced through `applyDgwUplift`:

```
gwValue = mean(scoreFixture(team, f).value for f in that gw)
gwValue = gwValue + (100 − gwValue) × DGW_UPLIFT × (n − 1)
```

  At `DGW_UPLIFT = 0.35` a double at 30 becomes 54.5 and a double at 70 becomes 80.5. The uplift is a fraction of the **remaining headroom to 100**, so it is asymptotic — a double can never overflow the band scale, and a great fixture gains proportionally less than a poor one (a double is worth most to the player you would otherwise have benched). `aggregateMin` takes the minimum of the **adjusted per-GW values**, not the worst individual fixture, or `W_MIN` would keep punishing a double that contains one hard game.

  **History:** this section previously claimed that pushing one entry per fixture "naturally boosts" the horizon score. It did not. Two entries at the same `gwOffset` doubled that gameweek's *weight* in the denominator without adding any return, which inverts for poor fixtures — a double against two hard opponents scored **lower** than a single hard fixture (39.2 vs 42.6 at `HORIZON_DECAY 0.9` over three GWs with fixtures at 30, 50, 50). Good doubles did lift the aggregate, which is why it went unnoticed. There is no value of `DGW_UPLIFT` that reproduces the old behaviour: collapsing to a per-GW mean is itself a change.

  The UI labels DGW teams — see §9.1.
- Output mirrors `CompositeScore` plus a `perGw: [{ gw, value, band, opponent, venue, isBlank, provisional, provisionalKickoff }]` array so modules can render the fixture run as a strip of coloured cells. **`perGw` is one entry per FIXTURE, not per gameweek** — a double produces two entries sharing a `gw`, so its length does not equal the horizon length. Fold it with `groupPerGwSlots` (§9.1) before rendering. The aggregation collapse described above does **not** apply to `perGw`; the two are deliberately separate.

---

## 9.1 Schedule irregularities (`engine/fixtures.js`, `modules/scheduleBar.js`)

FPL's calendar is not one-fixture-per-team-per-gameweek. Four states occur, and all four are surfaced:

| State | Meaning | Source |
|---|---|---|
| **Double** | team plays 2+ fixtures in one gameweek | two `perGw` entries sharing a `gw` |
| **Blank** | team plays none | one `perGw` entry with `isBlank: true` |
| **Postponed** | fixture exists, no gameweek assigned | `season.pendingFixtures` (`event: null`) |
| **Kickoff TBC** | gameweek assigned, kickoff unconfirmed | `fixture.provisionalKickoff` (`provisional_start_time`) |

### The one rule

**Schedule structure is carried by geometry; fixture quality is carried by colour. The two never overlap.**

Both alternatives were already committed: the five band colours mean fixture quality in all four modules (CONVENTIONS §5.2), and `--estimated-border-style` (dashed) means low **model** confidence. A kickoff-TBC marker cannot be dashed, because that would collide with a different axis — schedule confidence and model confidence must stay separately legible. A double against brutal opposition reads as red-and-grouped.

| Signal | Treatment |
|---|---|
| Double | slot's cells wrapped in a `--color-accent` tinted group with an accent outline; label gains `··` |
| Blank | hatched cell showing `∅` — a bare `–` was indistinguishable from a failed load |
| Kickoff TBC | 4px `--band-tough` corner dot |
| Postponed | dashed `+n TBD` pill, after the strip — it has no gameweek to sit inside |

`--color-accent` is used for doubles precisely because it is **not** one of the five band colours, so it cannot be read as a quality signal.

### `groupPerGwSlots(perGw)`

Folds the flat per-fixture array into `[{ gw, fixtures, isDouble, isBlank }]`, ordered by gameweek. A **derived view**, not a change to `scoreOverHorizon`'s output — the engine contract stays stable while renderers migrate independently. `isDouble` and `isBlank` are mutually exclusive by construction: a blank is always exactly one entry.

Consumed by the Ranker strip, the Matchup strip, `buildFixtureContextLabel` (Dashboard) and the Planner's transfer cards.

### `summariseGwIrregularities(ctx, fromGw, count)`

Returns `[{ gw, doubleTeams, blankTeams }]` for **only** the irregular gameweeks in a window. An ordinary window returns `[]`, and that emptiness is the signal `modules/scheduleBar.js` uses to render nothing at all — a bar that always showed would cost vertical space on every view for information that is usually "nothing unusual".

The bar exists because the per-team strip only appears in the Ranker and Matchup Analyser. Dashboard, Planner and Fixtures render no strip, so without it three of five tabs would say nothing about the schedule.

### `pendingFixturesForTeam(teamId, ctx)`

**Display-only.** Postponed fixtures have no gameweek, so nothing that aggregates over a gameweek window may read them — `fixturesForTeamInWindow` keeps its `f.gw === null` guard, and that guard is what makes retaining them safe.

---

## 10. Player projection (`engine/composite.js → scorePlayer`)

Bridges team fixture scores to player-level decisions (consumed by ranker, dashboard, planner).
```
playerProjection(player, horizon) =
    PROJ_FORM   * player.form.value                    # is HE in form?
  + PROJ_FIXTURE* teamHorizonScore(player.teamId)      # are the FIXTURES good?
  + PROJ_COUNTER* playerCounterEdge(player, horizon)   # does HIS position matchup favour him?
  + PROJ_MINUTES* playingLikelihood(player)            # will he actually START? (§7.3)
```
- Defaults: `PROJ_FORM = 0.36`, `PROJ_FIXTURE = 0.28`, `PROJ_COUNTER = 0.16`, `PROJ_MINUTES = 0.20` (`config.js`). **Sums to 1.00.**
- `playerCounterEdge` pulls the specific pairing the player participates in (a striker gets the FWD-vs-CB pairing of each fixture in the horizon), so the counter-matchup is personalised to his role, not just his team's average.
- Output: `{ value, band, perGw, breakdown, valueScore, avgPointsPerGw, costPerPoint, nextFixtureScore, expectedPoints }` where `valueScore = value / price` (points-per-million proxy) for budget-aware ranking. `expectedPoints` is a separate, real points-scale projection — see §10.2 — never conflate it with `value`.

**`PROJ_MINUTES` — playing likelihood as a first-class term.**

Minutes-security previously reached the composite only *indirectly*, through `W_MINUTES` inside `calcPlayerForm` (§7.1). That gave it just `0.45 × 0.30 ≈ 13.5%` of the score — enough to nudge, not enough to stop a high-per-90 rotation risk out-ranking a nailed starter. The Ranker showed exactly that failure. `PROJ_MINUTES` promotes it to a term of its own, sourced from §7.3.

The three existing weights were scaled down proportionally (**×0.80**) to make room, so the total still lands on exactly 1.00:

| Weight | Before | After |
|---|---|---|
| `PROJ_FORM` | 0.45 | 0.36 |
| `PROJ_FIXTURE` | 0.35 | 0.28 |
| `PROJ_COUNTER` | 0.20 | 0.16 |
| `PROJ_MINUTES` | — | **0.20** |

- **MODEL: this deliberately double-counts minutes.** `W_MINUTES` still sits inside the form term, so total minutes influence is now ≈33%. That is intended, not an oversight: minutes matter twice over in FPL — once as evidence a player is actually performing, and again as the probability he takes the pitch at all. Reducing `W_MINUTES` to compensate was **rejected** because `calcPlayerForm` also feeds `engine/counter.js`'s unit-form reads and the Individual Duels (§7.4), so lowering it would silently move counter-matchup numbers too.
- Measured effect on a player held at form 62 / fixture 70 / counter 60, varying only minutes-security: the Guaranteed-vs-Risk spread attributable to this input rises from **0.00 → 16.00 points**. A rotation punt on 67.1 drops to 59.7 while a nailed starter on 64.4 rises to 70.5 — i.e. the two swap rank. Worked table:

  | `minutesSecurity` | Playing likelihood | Score before | Score after | Δ |
  |---|---|---|---|---|
  | 0.15 | 15 | 64.40 | 54.52 | −9.88 |
  | 0.30 | 30 | 64.40 | 57.52 | −6.88 |
  | 0.50 | 50 | 64.40 | 61.52 | −2.88 |
  | 0.75 | 75 | 64.40 | 66.52 | +2.12 |
  | 0.95 | 95 | 64.40 | 70.52 | +6.12 |

- Reported on `breakdown.minutes` as `{ value, weight, estimated, startShare, availability, availabilitySource }`. Both halves are exposed so the UI can distinguish *benched* (low `startShare`) from *injured* (low `availability`) — they score alike but mean different things.
- **`engine/chips.js` inlines this same four-term blend** for single-fixture chip evaluation. Any change to the `PROJ_*` set must land there too, or chip advice silently diverges from the Ranker/Dashboard/Planner.

**Phase 5 additions (Player Ranker):**

- **`avgPointsPerGw` (`calcAvgPointsPerGw(player, ctx)`)** — `{ value, estimated }`, average FPL points per gameweek THIS season. Prefers real per-GW `history[]` from an already-loaded player summary (mean of `history[].points`, `estimated: false`) — FPL's history payload has one entry per elapsed gameweek regardless of whether the player featured (0 points for a blank week), so this is already a true weekly average. Falls back, when no summary is loaded (or its `history[]` is empty), to `player.totals.points ÷ elapsedGws`, where `elapsedGws` is the count of distinct gameweeks in `ctx.playedFixtures` (`estimated: true`). Pre-season, `elapsedGws` is genuinely `0`, so this is genuinely `0` for every player — real information, not a bug, and this function does **not** substitute anything else in for it (see §10.1 for the explicit alternative view). **Divides by gameweeks elapsed this season, not by games the player actually appeared in** — a player who scored 10 points in GW1 and then missed GW2–4 averages `10/4 = 2.5`, not `10/1 = 10`; dividing by appearances instead would make a fringe player's one big week look like elite sustained output. **Never triggers a bulk player-summary fetch** — uses only `ctx.playerSummariesById`, which is populated lazily as the user clicks into players elsewhere in the app (ARCHITECTURE.md §3 rule 7).
- **`costPerPoint`** — `player.price / avgPointsPerGw.value`, or `null` when `avgPointsPerGw.value` is 0 (never `NaN`/`Infinity`; the ranker displays `null` as "—"). **This is the inverse ratio direction from `valueScore`** (money spent per point vs. points per million) — the two must never be merged or treated as the same figure. `valueScore` answers "how much projected score do I get per pound"; `costPerPoint` answers "how much does each point actually cost". **Reads the exact same `avgPointsPerGw` value the Ranker's Avg Pts/GW column displays** — there is no independent computation, so whenever that column is populated, Cost/Pt is automatically populated too, with no separate wiring. In the Ranker's "Last Season" toggle mode (§10.1), Cost/Pt is instead derived from `calcLastSeasonAvgPointsPerGw`'s value — same derivation, different input, computed in the module layer (`buildLastSeasonLookup`) rather than by `scorePlayer` itself.
- **`nextFixtureScore`** — `{ value, estimated }`, a 0–100 blend of *only* `breakdown.fixture.value` and `breakdown.counter.value` (form excluded), re-normalised over `PROJ_FIXTURE + PROJ_COUNTER` since `PROJ_FORM` drops out of the blend: `(PROJ_FIXTURE × fixture.value + PROJ_COUNTER × counter.value) / (PROJ_FIXTURE + PROJ_COUNTER)`. Answers "is this player's next fixture favourable", independent of whether he's personally in form. Derived from the SAME `horizonResult`/`counterEdge` values `scorePlayer` already computes — not a new metric. The Ranker shows this alongside a rank position among the currently-filtered player set (not the full ~700), since a bare rank number without its underlying score isn't explainable on its own.

### 10.1 "Avg Pts/GW source" toggle (`calcLastSeasonAvgPointsPerGw`, Ranker only)

**History:** an earlier version of this section documented an *automatic* pre-season fallback — `calcAvgPointsPerGw` would silently substitute last season's average whenever `elapsedGws <= 0`. That design was reverted: it turned out to be practically inert, because the player summaries it depended on are only ever lazily loaded when the user clicks into a player (which immediately navigates away to Matchup), so nothing ever populated it from browsing the Ranker alone. Rather than auto-loading summaries to make an invisible fallback work, the feature became an **explicit, user-controlled toggle** instead — simpler to reason about, and the user chooses when the (deliberately bulk) load happens rather than it happening silently.

**What it is:** a button in the Ranker's filter panel ("This Season" / "Last Season") that switches what the **Avg Pts/GW** and **Cost/Pt** columns display:
- **"This Season"** (default) — the ordinary `calcAvgPointsPerGw`/`costPerPoint` from §10 above, unchanged. Shows a real `0` pre-season, since that's genuinely what has happened so far.
- **"Last Season"** — every player's most recent **past** season average instead, via the new `calcLastSeasonAvgPointsPerGw(player, ctx)`: `lastSeasonPoints ÷ SEASON_GWS` (config.js, 38), sourced from `historyPast` (the same lazily-loaded `element-summary` payload that already provides current-season `history[]` — no new endpoint). Always rendered with the `~` estimated marker and a tooltip naming the season (e.g. "2025/26's average — not this season's"), since by definition it isn't this season's number, current-season or not.

**Why bulk-loading here doesn't violate the no-bulk-fetch rule:** ARCHITECTURE.md §12 non-goal 7 / §3 rule 7 forbid *automatically* fetching all ~700 player summaries on load or in the background. Clicking "Last Season" is neither — it is a single, deliberate, user-initiated action, staggered into chunks of `SUMMARY_FETCH_CHUNK_SIZE` (config.js, 20 — deliberately smaller than `RANKER_CHUNK_SIZE`'s 50, since these are real network requests through the proxy, not just CPU-bound scoring) with a yield between each chunk so the page stays responsive. Switching back to "This Season" cancels any in-flight load via an incrementing run-id guard (`_summaryLoadRunId`), mirroring the existing `_computeId` staleness-guard pattern `rebuildRowsChunked` already uses.

**Three display states per row, not two** (`modules/ranker.js → buildRow`, fed by `buildLastSeasonLookup`):
1. **Not loaded yet** (bulk load still in flight, or not yet triggered for this player) — a muted "…" placeholder, not a dash, so it doesn't read as "no data exists".
2. **Loaded, no past-season record** — a definitive "—": this player genuinely has no prior-season history (e.g. a new arrival to the league), not an in-progress load.
3. **Loaded, real value** — the last-season average/cost, flagged `~` as described above.

Sorting by Avg Pts/GW or Cost/Pt while in "Last Season" mode sorts by these same displayed values (`applySort`'s `lastSeasonByPlayerId` parameter), not the current-season ones underneath — otherwise the sort arrow would silently contradict what's on screen. Both column headers append "(last season)" while the toggle is active, so the meaning is clear even scrolled away from the toggle button itself.

**Worked example, real data** (fetched live from `bootstrap-static`/`element-summary`, player id 12, "Saka"):

| | "This Season" | "Last Season" (after load) |
|---|---|---|
| `history[]` (current season) | empty (pre-season) | *(not read by this view)* |
| `avgPointsPerGw.value` / display | `0`, real | `historyPast` most recent entry `{ seasonName: '2025/26', points: 157 }` → `157 / 38 = 4.13` → displayed **4.1~** |
| `costPerPoint` (price = £9.5m) | `null` → displayed **"—"** | `9.5 / 4.131579 = 2.30` → displayed **£2.30m~** |

Confirms the same underlying arithmetic as before — only how (and when) it's surfaced has changed: a real `0` is always available on the default tab, and the last-season figure is only ever shown when the user explicitly asks for it.

### 10.2 `expectedPoints` — real points-scale projection for captaincy/TC (`calcExpectedPoints`)

**Problem this fixes:** the Dashboard's captaincy pick and the Planner's Triple Captain candidate pick both used to rank the owned squad by `score.value` — the same 0–100 composite the Ranker uses to compare players *within* a position. That composite does not scale with a position's actual scoring ceiling (a forward's good game is worth more raw FPL points than a defender's good game), so a defender in great form with an easy fixture could out-rank a genuinely higher-scoring midfielder/forward for the armband — exactly backwards from "captain whoever is predicted to score the most points."

**The fix:** `scorePlayer` now also returns `expectedPoints: { value, estimated }`, computed by `calcExpectedPoints(avgPointsPerGw, nextFixtureScore, playing)`:

```
expectedPoints.value = avgPointsPerGw.value
                      * (1 + EXPECTED_PTS_FIXTURE_SWING * (nextFixtureScore.value − 50) / 50)
                      * (playing.value / 100)
                      * max(0, 1 + DGW_EXPECTED_PTS_FACTOR * (fixtureCount − 1))
```

- `avgPointsPerGw.value` (§10 above) is a real points figure that already reflects each position's true scoring ceiling — forwards/mids naturally average more points per gameweek than defenders — so no separate per-position scaling is needed.
- The fixture-quality term scales that average by up to `± EXPECTED_PTS_FIXTURE_SWING` (config.js, default `0.5`): a `nextFixtureScore` of 50 (neutral) applies ×1.0, 100 (best possible) applies ×1.5, 0 (worst) applies ×0.5.
- The playing-likelihood term (`playing.value / 100`, §7.3) suppresses the projection for anyone unlikely to start, so a high season-average player who's now injured/benched doesn't still look like the best captain pick.
- **The fixture-count term** (`DGW_EXPECTED_PTS_FACTOR`, default `0.9`) is how many games the player's team actually plays in the nearest gameweek: `0` on a blank, `2` on a double. A blank therefore projects **zero** — the team does not play — and a double projects ×1.9. `0.9` rather than `1.0` is a rotation-risk haircut: managers rest players across a congested double far more often than across a single, so a straight doubling over-projects. Clamped at 0 so a nonsense count cannot invert the projection into negative points. **Added because the projection previously had no fixture-count term at all**, so a double-gameweek captain projected identically to a single-gameweek one and a blank-gameweek player projected a full score — and double-gameweek captaincy is the highest-leverage use of schedule knowledge in FPL.
- **`DGW_EXPECTED_PTS_FACTOR` applies only here; `DGW_UPLIFT` (§9) applies only to `value`.** One fact, two axes, one treatment each — never apply either to the other, or a double is counted twice.
- **`value` and `expectedPoints` are two different axes and must never be merged**: `value` (0–100) answers "how good a pick is this player right now, relative to others at his position" (Ranker's job); `expectedPoints` (real points) answers "how many points will he actually score" (captaincy/TC's job).
- **Callers:** `modules/dashboard.js → renderDecisions()` picks the XI's `expectedPoints.value` max as captain (and shows it on the Captain Pick card, "Predicted X.X pts"); `modules/planner.js → pickTcCandidate()` picks the squad's `expectedPoints.value` max as the Triple Captain candidate. Neither reads `score.value` for this decision anymore.

---

### 10.3 Ranker column set (`modules/ranker.js → renderThead`, `buildRow`, `colCount`)

Fifteen columns, fixed — there is no per-column toggle. Left to right:

| # | Header | `data-sort` / `data-col` | Source |
|---|---|---|---|
| 1 | Player | `name` | `player.name` |
| 2 | Team | `team` | `team.shortName` + badge |
| 3 | Pos | `pos` (static) | `player.position` |
| 4 | Price | `price` | `player.price` (`now_cost / 10`) |
| 5 | £ ↑/↓ | `priceChange` | `calcSeasonPriceChange` (§10.4) |
| 6 | Cost/Pt | `costPerPoint` | `score.costPerPoint` — §10.1 toggle applies |
| 7 | Avg Pts/GW | `avgPointsPerGw` | `score.avgPointsPerGw` — §10.1 toggle applies |
| 8 | Total Pts | `totalPoints` | `player.totals.points` |
| 9 | Form | `fplForm` | `player.fplForm` (FPL's own 30-day average) |
| 10 | Tsfr In | `transfersInEvent` | `player.transfersInEvent` |
| 11 | Tsfr Out | `transfersOutEvent` | `player.transfersOutEvent` |
| 12 | Value | `value` | `score.value` — the headline chip (§13 colouring) |
| 13 | Next Fixture | `nextFixtureScore` | `score.nextFixtureScore` + rank tag |
| 14 | *(horizon label)* | `fixtures` (static) | per-GW fixture strip |
| 15 | Playtime | `playtime` | `calcPlaytimeSecurity` band (§7.3b) |

Every column except Pos and the fixture strip is sortable through the one `_sortBy`/`_sortDesc` pair and the single delegated `<thead>` click handler — there is no second sort mechanism. Numeric columns sort descending on first click.

**Tsfr In / Tsfr Out are the GW's flow (`transfers_in_event` / `transfers_out_event`), not the cumulative season totals** (`transfers_in` / `transfers_out`), which the app does not retain. They are the same two figures `calcPriceChangeRisk` reads, surfaced raw so the prediction that used to occupy column 15 can be read off its inputs directly.

`colCount()` returns 15 and is the single source of truth for anything spanning the table — the empty/loading rows in `renderTable`/`rebuildRowsChunked`, and the fallback `colspan` in `index.html`. The `<th>` width percentages in `components.css` must sum to 100: `table-layout: fixed` silently redistributes a shortfall.

### 10.4 Season price change (`engine/prices.js → calcSeasonPriceChange`)

```
value     = costChangeStart / 10
direction = costChangeStart > 0 ? 'rise' : < 0 ? 'fall' : 'flat'
label     = sign + '£' + (|costChangeStart| / 10).toFixed(1) + 'm'
```

`costChangeStart` is bootstrap-static's `cost_change_start` in **tenths of a million** — the same unit as `now_cost`, not the same unit as the normalised `price`. The divide happens once, here.

**This is a fact, not a forecast, and is deliberately separate from `calcPriceChangeRisk`** (which predicts the *next* move from in-GW transfer flow). They answer different questions and must never be merged: this one reports movement already banked since the season opened; that one reports probability of imminent movement. The Ranker shows this one; the Transfer Planner shows that one.

Formatting rules the tests pin (`tests/engine/prices.test.js`):
- The sign belongs to the number, not the symbol — `-£0.1m`, never `£-0.1m`. The label is built from the absolute value with the sign prepended.
- **Zero is a real reading, not missing data**: `£0.0m`, no sign, muted styling — never blank, never a dash (which would be indistinguishable from a load failure), and never `+£0.0m` (which reads as a rise that never happened).
- Always one decimal place: `-£1.0m`, not `-£1m`.
- A missing `costChangeStart` is treated as zero, matching the zero-safe contract on `transfersInEvent`/`transfersOutEvent` beside it in `normalisePlayer`.

Colour vocabulary is shared with the Planner's price warnings: `--band-great` green for a rise, `--band-brutal` red for a fall, `--color-muted` for flat.

---

## 11. How the engine feeds each module

| Module | Primary engine call | What it shows |
|---|---|---|
| **Matchup Analyser** (`modules/matchup.js`) | `scoreFixture(team, fixture)` for **both** sides | Full side-by-side breakdown of one fixture: each sub-metric, the counter-matchup pairings (each with an info disclosure naming the players behind it, via `duelsForPairing` §7.2), style clash, confidence. The "view source" for any score elsewhere. Since §8.7, the two cards' `value`s are guaranteed to sum to 100 — a genuinely relative read of the matchup, not two independent absolute scores. |
| **Player Ranker** (`modules/ranker.js`) | `rankPlayers(players, horizon)` → sortable by every column bar Pos and the fixture strip | Ranked, filterable table (position, price threshold, team, minutes-security) of projected value over the active horizon — 15 columns (§10.3): permanent Value and Cost/Pt, Avg Pts/GW, season price change (§10.4), in-GW transfers in/out, Next Fixture (rank + score), and a per-GW fixture strip per player. |
| **GW Dashboard** (`modules/dashboard.js`) | `scorePlayer(p, HORIZON.GW1)` for owned squad + `event/<gw>/live` | Captaincy pick (top `expectedPoints`, §10.2, in squad), start/bench order, risk flags (low minutesSecurity, brutal band, low confidence), and live points when the GW is in progress. Horizon-locked to GW1. |
| **Transfer Planner** (`modules/planner.js`) | `rankPlayers` over horizon + current squad + constraints | For each candidate out→in swap, computes Δ projected horizon score; ranks transfers by gain per cost, respecting budget and free transfers (−4 hit modelled). Surfaces the moves that most raise total projected score over the horizon. Triple Captain candidate picked by top `expectedPoints` (§10.2), same as Dashboard captaincy. |

All four read the **same** scores and breakdowns. No module recomputes a metric. If a module needs a number the engine doesn't expose, add it to the engine and its breakdown — never inline it (see `CONVENTIONS.md` §11).

Because Ranker, Dashboard and Planner all obtain player scores from `scorePlayer`, engine-level changes to the `PROJ_*` blend (such as `PROJ_MINUTES`, §10) propagate to all three with no per-module code. `engine/chips.js` is the **one** exception — it inlines the same blend for single-fixture chip evaluation and must be updated in lockstep.

---

## 12. Tuning & validation guidance (for whoever maintains the model)

- **Single source of tunables:** every constant named in this doc is in `config.js`. Tuning the model = editing `config.js`, never editing formulas.
- **Sanity benchmark:** after any weight change, spot-check a handful of fixtures whose outcome is intuitively obvious (a top side at home to a bottom side should land 'great'; a poor side away to a top side should land 'brutal'). If it doesn't, the weights or a metric's direction is wrong.
- **Backtesting (Phase 3):** persist each GW's pre-deadline scores and compare against actual points to calibrate weights empirically. Until then, weights are informed priors, explicitly documented here so they can be argued with.
- **Direction bugs are the #1 risk.** A single inverted metric quietly poisons the composite. Every metric function must restate its direction in its JSDoc (`CONVENTIONS.md` §7.2).

---

## 13. Rank-relative player colouring (`engine/composite.js → calcRankTier`, `attachRankTiers`)

**Purpose:** make the standout players — genuinely worth squad consideration, or genuinely not — visually pop in the Ranker, Dashboard, and Planner, regardless of how the absolute 0–100 scale happens to be distributed this season.

**This is a SEPARATE axis from `BANDS_V2` (§8.4), not a replacement.** `score.band` classifies a value against the fixed 0–100 scale — it answers "is this an objectively good score". `rankTier` classifies a player against the **current pool** — it answers "does this player stand out relative to everyone else right now". A season where scores cluster low (thin early-season data, most sub-metrics still estimated) would leave the band scale unable to distinguish the genuinely best players from the merely-average ones; `rankTier` still can, because it only cares about relative ordering.

**Tiers and precedence** (`config.js`):
```
RANK_ELITE_COUNT_BY_POS  = { GKP: 2, DEF: 5,  MID: 5,  FWD: 3 }   # fixed count, per position
RANK_STRONG_COUNT_BY_POS = { GKP: 8, DEF: 20, MID: 20, FWD: 12 }  # fixed count, per position
RANK_TOP_PERCENTILE      = 0.25                                  # fraction of the pool, POOL-WIDE
RANK_BOTTOM_PERCENTILE   = 0.40                                  # fraction of the pool, POOL-WIDE

calcRankTier(index, poolSize, positionIndex, position):
    # index/poolSize: 0-based rank / size in the WHOLE pool (0 = best)
    # positionIndex:  0-based rank among players of the SAME position only
    if positionIndex == 0:                                               return 'positionBest'
    if positionIndex < RANK_ELITE_COUNT_BY_POS[position]:                return 'positionElite'
    if positionIndex < RANK_STRONG_COUNT_BY_POS[position]:               return 'positionStrong'
    if index < poolSize * RANK_TOP_PERCENTILE:                           return 'topPercentile'
    if index >= poolSize * (1 - RANK_BOTTOM_PERCENTILE):                 return 'bottomPercentile'
    else:                                                                return 'midPercentile'
```
**`positionBest` — rank 1 of a position — is the only tier with no config constant**, because it has no threshold to tune: it is literally the top one. That fixed scarcity is the whole signal. There are always exactly **four** of them on the board, one per position, however the pool moves — a count that cannot inflate, which is what earns it the gold the absolute scale reserves for its own top tier (`.score-chip--rank-gold`, same chrome/ink split and glow as `.score-chip--excellent`). "Best there is" reads identically whether it was earned on the absolute axis or the relative one.

**Every player now gets a tier.** Unlike the original 3-tier design, `calcRankTier` no longer has a "leave it alone" case for the unremarkable middle — `topPercentile`, `bottomPercentile`, and `midPercentile` between them exhaustively partition every player who isn't already position-elite/strong. `null` is now only a defensive fallback for a malformed/empty pool, never a normal outcome. This was a deliberate redesign (from "3 standout tiers, everyone else keeps their absolute `BANDS` colour") to a fully rank-relative colouring scheme: **red = bottom 40% of the pool, grey = top 25%, yellow = the middle 35% between them** — with the gold and the two remaining green tiers still taking priority over all three when a player also qualifies for one.

**The two green "worth considering" tiers are PER-POSITION, not pool-wide** — this was a deliberate correction: a pool-wide cut across all 700+ players regardless of position systematically buried Forwards (fewer squad slots, scores that don't reliably cluster as high as cheap Defenders' do in bulk). `topPercentile`/`bottomPercentile`/`midPercentile` stay POOL-WIDE by contrast, same as the original `bottomPercentile` design — there's no equivalent "hidden gem" concern to correct for once green has already had first pick; a player who isn't green is just being placed somewhere on the same overall scale as everyone else, regardless of position.

**Green cutoffs can reach deeper into the pool-wide percentile range than they numerically look at first glance**, for a thin position — GKP's top 8 (`RANK_STRONG_COUNT_BY_POS.GKP`) can already exceed 25% of all loaded goalkeepers, for instance. This is harmless: green is checked first and always wins, so `topPercentile` (grey) only actually renders for players a given position's own green cutoff doesn't reach, whatever that turns out to be pool-wide.

Tier names describe their **role** (mirroring the `RANK_*` config constant names), not the current threshold numbers — a name baked to a specific figure (e.g. the original `'top30'`/`'top10'`, which went stale within the same week they were introduced) silently drifts out of sync the next time any constant is retuned.

Tiers are checked **most-specific first**: `positionBest` before `positionElite` before `positionStrong` before `topPercentile` before `bottomPercentile`, falling through to `midPercentile` last. A position-elite player is always also position-strong (the elite count is always ≤ the strong count for every position) — `positionElite` is the smaller, "definitely worth considering" flagship signal within that position, checked first so it isn't silently absorbed into the wider tier.

`attachRankTiers` derives each player's `positionIndex` in a single pass over the already pool-wide-sorted array — counting occurrences of each position as it goes (advancing that position's own counter only when it meets another player of it) reproduces the same descending order restricted to one position, with no second sort needed. Verified against an independent brute-force per-position sort across a simulated 700-player pool: 0 mismatches. Also verified per-position: `positionElite`/`positionStrong` counts land exactly on the configured numbers for every position (e.g. FWD: exactly 3 elite, exactly 12 total elite+strong).

**Colour tokens (`base.css`):** these classes are named after their **colour**, not their tier, and they read the **primitive** tokens directly (`--band-dark-green`, `--band-light-blue`, `--band-red`, `--band-grey`, `--band-amber`, `--band-gold`) — this axis is deliberately not on the 0–100 scale and must not move when that scale is re-pointed (`CONVENTIONS.md` §5.3).

`positionStrong` was `--band-light-green` (`#6fcf78`) until the seven-tier scale landed — originally a true lime (`--band-lime`, `#a3e635`), softened because lime read too bright on this dark palette. It is now **blue** — specifically `--band-light-blue` (`#58a6ff`). Two greens one step apart is a distinction the eye has to work for, and the Value column was asking it to do that ~700 rows deep; against the dark green of `positionElite`, blue separates at a glance and costs nothing, since nothing else in that table is blue. It took the deep `--band-blue` (`#1f6feb`) first and moved to the light one when the `'good'` band did: the two axes are independent and read separate token layers, but the app has to have exactly **one** blue, or a reader carrying a colour over from the Matchup page meets a second, darker one here and has to work out whether the difference is telling them something. (The class kept the name `--rank-light-green`; renaming it would touch three modules for no behavioural gain, and the block's comment says what it now paints.) Rendered via six CSS classes (`components.css`): `.score-chip--rank-gold`, `.score-chip--rank-green`, `.score-chip--rank-light-green`, `.score-chip--rank-red`, `.score-chip--rank-neutral`, `.score-chip--rank-yellow` — deliberately **not** named after (or reusing directly) the `BANDS` classes they happen to share a colour with (`.score-chip--great`, `.score-chip--neutral`, etc.), for two reasons: conflating the two in the DOM would make a future reader unable to tell "scored 67+" from "ranked position-elite" just by reading the class name, and — more concretely — reusing the band class directly would make the override's cascade position depend on which band a given player's own absolute score happened to carry (e.g. a `midPercentile` player whose own score is `brutal`-banded would incorrectly stay red, since `.score-chip--brutal` is declared after `.score-chip--neutral`/`.score-chip--tough` in the stylesheet). A chip renders **both** its band class and its rank-tier class together; the rank-tier rules are declared as their own block, after all **seven** band rules, in `components.css`, so they always win the cascade at equal specificity regardless of which band happens to also apply — no `!important` and no JS class-stripping needed. `.score-chip--rank-gold` is last within that block, so it also beats `--rank-green` for the player who is both.

**Player pool scope — the FULL pool, not the currently-filtered view.** Ranker's rank tiers are computed against every loaded player (`store.getPlayers()`), **before** `applyFilters()` narrows the table for display — "top 5 Forwards in the game" must mean the same thing whether the position filter is set to "FWD only" or "all", and must match what Dashboard and Planner (which have no filters at all) compute for the same players. Dashboard and Planner each maintain a squad of ~15 players with no natural "pool" of their own, so both compute the same full-pool ranking `rankPlayers(store.getPlayers(), horizon, ctx)` + `attachRankTiers(...)` and cache a `playerId → rankTier` lookup, reused across squad edits. Ranker's tooltip text for each chip is built from the player's own position and the live `RANK_ELITE_COUNT_BY_POS`/`RANK_STRONG_COUNT_BY_POS` values (`rankTierTitle`), not a single fixed string, since the count now varies by position.

**Cost, and why it's cached, not recomputed per edit.** A full-pool ranking scores every loaded player — the same cost the Ranker already accepts as normal (it does this on every load/horizon change via chunked async scoring). The ranking depends only on `(ctx, horizon)`, **not** on squad membership, so Dashboard and Planner compute it **once** per data load (and, for Planner, once per horizon change — its horizon can change via the global switcher; Dashboard is locked to GW1 so only data-load invalidates it) and reuse the cached lookup across every subsequent squad add/remove. Recomputing on every edit would re-score ~700 players per click for no reason.

**Where it's shown:** the headline "Value" score chip in each module (Ranker's Value column; Dashboard's captain/XI/bench/squad-slot chips; Planner's squad-slot and transfer in/out candidate chips), plus the Ranker's **Avg Pts/GW** and **Cost/Pt** columns.

**Each column is ranked on its OWN number.** The three Ranker columns share the tiers, the palette and the chip, and nothing else — a row is routinely gold for Cost/Pt and mid-table for Value, which is the entire point of showing all three. Reusing the Value tier across the row would paint two columns with a metric that is not theirs and tell the reader nothing they could not already see one column to the left. `rankTierMapBy` (`engine/composite.js`) does the per-metric ranking; it is `attachRankTiers` with the sort key and direction lifted out.

Two things that ranking has to get right:
- **Direction.** Cost/Pt is £ per point, so **lower wins** and it ranks ascending. This is an explicit caller argument, never inferred — backwards, it would not throw, it would silently gild the worst player in every position.
- **Pool membership.** A player with no points has no Cost/Pt at all. They are excluded from that column's pool rather than ranked last, so they render as a bare "—" with no chip, and "bottom 40%" means 40% of the players who actually have the metric (~357 of ~629, early season) rather than 40% of everyone. The same applies to a row whose last-season figure is still streaming in.

Both columns follow whichever season the Avg Pts/GW toggle is showing (§10.1), so the colours always describe the figures on screen; the last-season lookup they read is therefore built over the full pool, not the filtered view, matching the pool rule above.

Still deliberately **not** applied to the Ranker's Next Fixture chip, the per-GW fixture strip, or the minutes-security badge. Those are narrower metrics (fixture favourability, per-GW difficulty, playing time) already carrying the 0–100 band scale or their own vocabulary; a rank tier on top would be a second colour system competing for the same cell.

---

## 14. Transfer Planner: the five lanes and the weekly verdict (`engine/lineup.js`, `engine/transfers.js`, `engine/strategy.js`)

Full design: `docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md`.

### 14.1 The XI-expected-points spine, and why the composite was the wrong axis

**Problem this fixes:** the Planner used to rank a candidate transfer by the change in `score.value` — the same 0–100 within-position composite the Ranker uses. That composite has no relationship to whether a player is actually **in the starting XI**, so swapping a 0-point bench substitute for a marginally-better 2-point bench substitute could out-score a genuine upgrade to a starter. Ranking transfers by a number that ignores selection is the bug this whole feature exists to fix.

**The fix:** `pickStartingXI` (`engine/lineup.js`, lifted from `modules/dashboard.js` and now shared by both — see `ARCHITECTURE.md` §10) orders candidates for the XI and bench by `score.expectedPoints.value` — the real points-scale projection (§10.2) — not `score.value`. `calcXiExpectedPoints(scoredSquad)` then sums the XI's expected points plus the bench at `BENCH_CONTRIBUTION_WEIGHT`:

```
calcXiExpectedPoints(squad) = Σ expectedPoints(xi) + BENCH_CONTRIBUTION_WEIGHT × Σ expectedPoints(bench)
```

> **MODEL:** a benched player is not worth zero — autosubs mean a bench player whose XI counterpart blanks does score. `BENCH_CONTRIBUTION_WEIGHT = 0.15` is deliberately small, so improving the bench registers as a faint positive rather than nothing, without ever rivalling a genuine XI upgrade.

A candidate swap's worth (`nearXiDelta` / `farXiDelta`) is the **difference** in this total before and after the swap, with `pickStartingXI` re-run on the changed squad:

```
xiDelta = calcXiExpectedPoints(after) − calcXiExpectedPoints(before)
```

This is the fix in one line. A swap between two bench players moves the total by roughly nothing, whatever their composite gap. A swap that promotes someone into the XI is credited for the promotion **and** for the knock-on demotion of whoever they displace, because both fall out of re-picking the XI. Verified live on a synthetic 15-man squad (626-player pool, GW6 horizon, 508 enumerated swaps): bench-to-bench swaps averaged **0.02** points on the Now lane (max 0.20 in either direction) against **2.74** average (peak 9.26) for swaps that reach the starting XI — roughly two orders of magnitude apart, which is the intended shape.

### 14.2 Candidate enumeration: a two-window swap search (`engine/transfers.js`)

```
enumerateSwaps(squadIds, allPlayers, ctx, opts) → Swap[]
```

`opts` carries `{ horizon, budget, freeTransfers, scorePlayerFn, caches, rankTierByPlayerId }`. Every candidate is scored in **two windows**, memoised per `(playerId, windowKey)` so a re-render never re-scores a player it has already seen this session:

- **Near** — the active horizon, as selected in the UI.
- **Far** — `FUTURE_WINDOW_START` gameweeks out (default `+2`), running `FUTURE_WINDOW_GWS` gameweeks (default `5`). Only the fixture window shifts; form terms stay measured from today, because future form is not knowable.

**Candidate SELECTION uses a cheap proxy; candidate RANKING does not — this is a deliberate change from the design plan.** The plan's original enumeration scored the entire ~626-player pool with the full composite (`rankPlayers`) just to find each position's top `CANDIDATE_POOL_PER_POS`, then re-scored the shortlist through the memoised path — duplicating the most expensive step. `candidateProxyScore(player, ctx)` now narrows the field first, at zero `scorePlayer` cost: season points divided by elapsed gameweeks, ties broken by price. Only the resulting shortlist (`CANDIDATE_POOL_PER_POS = 40` per position) is ever scored through the full composite, and it is that full composite — not the proxy — which orders candidates within every lane.

> **MODEL:** the proxy decides who is *considered*, never who *wins*. A genuinely strong player with a rough season-points history (a new signing, a player returning from injury) could be excluded from the pool; a player who makes the pool is never ranked by the proxy. This trade only costs breadth, never correctness of the ordering shown. Confirmed live: Haaland, Palmer, Bruno Fernandes and João Pedro all survive the pre-filter.

**Performance is deliberately split into a cold and a warm path**, and the gap between them is load-bearing, not an oversight:
- **Cold** (first enumeration, or a horizon change): ~3.5–6s on the ~626-player pool. This runs only while the Planner tab is off-screen or first activates (`route:changed` deferral), never while the user is typing.
- **Warm** (budget field, free-transfer count, hit toggle): re-filters and re-ranks the already-scored candidates **without re-scoring**, ~50ms. This is spec §11's actual requirement — the interactive controls must never re-score — and is the path a keystroke exercises. Measured live: 59.80ms for a budget-field keystroke.

### 14.3 The five lanes (`config.js` §14)

Each lane returns `{ value, components, estimated, reasoning }` on its own natural unit; normalisation to a shared 0–100 scale happens in `strategy.js` (§14.4 below), so the raw, explainable number stays available for display.

**Now** (`LANE_SCALE_NOW = 10`) — `nearXiDelta`, less `HIT_PENALTY` (4 points) when the move requires a hit. Nothing else: expected points added to your starting XI over the active horizon.

**Future Prep** (`LANE_SCALE_FUTURE = 0.7`) — ranked by *swing*, not raw far-window projection:

```
swing = farXiDelta − nearXiDelta,  gated on farXiDelta > FUTURE_MIN_FAR_GAIN (0.5)
```

> **MODEL:** ranking the far window by raw projection would mostly re-list the Now board — a genuinely good player is good in both windows. Swing isolates the move that is *specifically* about the future: rough fixtures now, green fixtures later — the buy-before-the-price-rises decision this board exists to serve.

**Funds & Flexibility** (`LANE_SCALE_FUNDS = 5`) — flexibility gained per expected point sacrificed: `flexGain / (pointsGiven + 1)`. Flexibility (`calcSquadFlexibility`) blends two weighted components:

- *Spread* (`FLEX_W_SPREAD = 0.6`) — how much of the squad sits clumped inside a `FLEX_CLUMP_BAND`-wide price band (six players at 7.0–7.6m cannot upgrade one without selling two).
- *Headroom* (`FLEX_W_HEADROOM = 0.4`) — how much cash the four most disposable outfield players (lowest `expectedPoints`) would raise, as a fraction of `FLEX_HEADROOM_TARGET`.

> **ASSUMPTION (unresolved):** the user described the problem as price clumping making up-value moves hard when capped — *spread*. *Headroom* is the adjacent reading of the same complaint. Both are carried as weighted components so that resolving this is a config change in `config.js`, not a rewrite. Revisit after a few weeks of live use.

Cash freed (`−priceDiff`) and `calcPriceChangeRisk()` (`engine/prices.js`) fold into this lane's `components`, including a `priceRiskConfidence` figure the verdict's `priceDeadline` trigger reads (§14.7).

**Ceiling** (`LANE_SCALE_CEILING = 8`) — peak rather than mean:

```
ceiling = CEILING_W_PEAK (0.65) × best playable-GW expectedPoints in the near window
        + CEILING_W_HAUL (0.35) × haul rate × that same peak
```

Haul rate is the share of played gameweeks scoring ≥ `HAUL_POINTS_THRESHOLD` (10), from `summary.history[].points`.

**Ceiling excludes blank gameweeks from its peak — a deliberate fix, not the original design.** `groupPerGwSlots` scores an empty slot at `BLANK_GW_VALUE` (40), which is high enough to beat a genuinely hard fixture in a naive `Math.max`; a blank week — the team does not play at all — could therefore present as the player's "peak" week. The lane now filters `slot.isBlank` out before taking the max; if every slot in the window is blank there is no week to peak in, so the lane reports `0` and flags itself `estimated` rather than a confident zero.

> **KNOWN WEAKNESS:** FPL exposes no variance data, so haul rate is a backward-looking proxy, thin for players with few starts, and player summaries load lazily — many candidates will have none loaded at all. This lane sets `estimated: true` whenever the summary is missing or the peak itself is estimated, and the verdict downgrades its own confidence accordingly (§14.6). It is the least trustworthy of the five and must never present as equally solid.

**Structure Fix** (`LANE_SCALE_STRUCTURE = 10`) — fires only when the OUT player is in the *projected* starting XI **and** is broken by at least one of:

- `status !== 'available'` (injured, suspended, doubtful), or
- `breakdown.playtime.value` below `STRUCTURE_PLAYTIME_FLOOR` (0.45), or
- rank tier `bottomPercentile` against the full player pool (a nailed, fit starter whose underlying output has still collapsed relative to the whole pool — the only one of the three conditions that catches this case).

Scored by how much of the XI total the repair restores (`max(0, nearXiDelta)`). Legitimately empty most weeks — the board renders an explicit "Nothing broken — no starter is flagged or short of minutes" state rather than padding itself with the next-best generic swap. Verified live both ways: empty on a squad of fifteen `status: 'available'` players, populated (naming the injured starter and the points restored) on a squad carrying one flagged player.

The rank-tier condition depends on `rankTierByPlayerId` — a `playerId → tier` map built from a full-pool `attachRankTiers(rankPlayers(...))` pass, computed once by the caller (`modules/planner.js`) and threaded through `enumerateSwaps`'s `opts.rankTierByPlayerId` to `scoreStructureLane` (`engine/transfers.js:550-551`; wired at `modules/planner.js:742`). Added by commit `0e76814`, after this section was first written describing only the first two conditions — see CONVENTIONS.md §10.

### 14.4 Lane normalisation and why it is the first thing to calibrate

`buildVerdict` (`engine/strategy.js`) maps each lane's best swap onto 0–100 by dividing by a per-lane config threshold and capping:

```
normaliseLaneValue(laneId, value) = clamp(0, 100, (value / LANE_SCALE_<LANE>) × 100)
```

> **MODEL:** this is the load-bearing and most arbitrary step in the whole design. Without a shared scale, "a swing of +6" and "frees £0.5m" have no common language, and the margin the verdict reports would be meaningless. The `LANE_SCALE_*` thresholds are calibration targets, not truths.

**The shipped values are a recalibration, not the plan's original numbers.** The design plan proposed `NOW=6, FUTURE=8, FUNDS=25, CEILING=12, STRUCTURE=5`. Measured against a live synthetic squad (GW3 horizon, £2.0m budget, 581 swaps), those values made Future Prep (normalised max 8) and Funds & Flexibility (normalised max 18) **arithmetically incapable of ever clearing `VERDICT_ACT_THRESHOLD` (35)** — two of the five lanes the feature exists to surface could never win the verdict, however good the underlying swap. The thresholds were recalibrated against the same measured distributions to `LANE_SCALE_NOW = 10`, `LANE_SCALE_FUTURE = 0.7`, `LANE_SCALE_FUNDS = 5`, `LANE_SCALE_CEILING = 8`, `LANE_SCALE_STRUCTURE = 10`, so each lane's best real-world move lands at roughly 90–100 rather than being structurally shut out. They remain calibration targets, not truths — the first thing to tune against realised results per `ROADMAP.md` Phase 3B.

**Caveat carried forward, not resolved:** Now, Future and Structure are *deltas*; Funds is a *ratio*; Ceiling is an *absolute* (every swap scores positive — 532 of 581 in the calibration run). Normalisation makes the five comparable **by convention**, not by shared units. Spec §7.1 chose that; it is not being re-architected here.

### 14.5 The roll lane

Doing nothing is scored as a lane, not treated as a fallback — a planner that always recommends something is the failure this design exists to prevent. If no acting lane clears `VERDICT_ACT_THRESHOLD`, the verdict is **roll it**, and its reasoning either banks the transfer toward the Future Prep board's already-identified target, or — with an empty swap set — states plainly that no legal transfer exists within budget. Verified directly: `buildVerdict([], ...)` returns `{ lane: 'roll', laneScore: 0, confidence: 'clear', reasoning: 'Roll the transfer — no legal transfers are available within your budget.' }`.

### 14.6 Verdict confidence bands

```
margin = arithmetic leader's normalised score − runner-up's (never negative)

margin ≥ VERDICT_MARGIN_DOMINANT (30) → 'dominant'  ("in a different league")
margin ≥ VERDICT_MARGIN_CLEAR    (12) → 'clear'
otherwise                             → 'close', and `alternatives` names every
                                         lane within VERDICT_MARGIN_CLEAR points
```

**Honesty rule 1 — estimated inputs downgrade confidence.** A winning lane whose swap is itself flagged `estimated` never reports the same confidence a measured winner would: `'dominant'` downgrades to `'clear'`, and `'clear'` (including a fresh trigger promotion, §14.7) downgrades to `'close'`. `lanes.now.estimated` / `lanes.future.estimated` read the **aggregated** estimated flag `calcXiExpectedPoints` already computes across every XI/bench member, not just the incoming player — under-reporting this would let the verdict overstate certainty. Verified live: a squad whose only strong lane was Ceiling (estimated — no gameweek history loaded for the target) reported `'clear'`, not `'dominant'`, despite a raw margin of +72.

### 14.7 Triggers, and how they promote a lane past the arithmetic

Four hard conditions can override the ranked lanes. Each supplies its own headline reason and is always named in `verdict.triggers` — detecting a trigger never by itself reorders anything; only `buildVerdict`'s promotion step (below) does.

1. `xiPlayerUnavailable` — a projected-XI player is injured, suspended or flagged. → `structure` lane.
2. `chipWindow` — a chip's recommended GW falls within `CHIP_WINDOW_GWS` (3). → `ceiling` lane for Triple Captain, `future` otherwise.
3. `cashCrunch` — squad flexibility below `FLEX_FLOOR` (35). → `funds` lane.
4. `priceDeadline` — a lane-leading target trending toward a price rise. → `funds` lane.

**Trigger promotion is a shipped capability the original plan under-specified.** The design's own language ("triggers override the arithmetic", "promote a lane") and the user's stated intent ("hard triggers jump the queue and say so") both called for a trigger to be able to change the winning lane. The first implementation only ever *reported* triggers in the output without using them to reorder anything — an injured XI starter could silently lose the verdict to a marginally larger points gain elsewhere. Promotion now works as follows: the highest-scoring lane with a fired trigger, if it *also* clears `VERDICT_ACT_THRESHOLD` and differs from the arithmetic leader, is promoted to be the verdict's lane. A promotion always forces `confidence: 'clear'` (before the estimated-data downgrade above) and sets `promotedBy` to the trigger's id; `reasoning` explicitly names the higher-scoring lane it jumped ahead of, so the user can see when they are being steered off the raw numbers rather than have it happen invisibly. Verified live: `xiPlayerUnavailable` promoted Structure Fix (93) ahead of an arithmetically-tied Now (93), with reasoning naming Now by name and score.

**At most one `chipWindow` trigger fires — also a fix, not the original behaviour.** `engine/chips.js` always recommends a best gameweek for *every* chip; without a cap, wildcard/free hit/bench boost landing in the same nearby window (the common case, not the exception) fired three near-identical triggers at once and drowned the sharper signals. Only the nearest-GW chip fires, ties broken `triplecaptain > benchboost > freehit > wildcard` — the sharper, more time-critical chips win a tie.

**`priceDeadline` is gated on `PRICE_BUY_NOW_CONFIDENCE`, not on direction alone — also a fix.** `calcPriceChangeRisk` reports `direction: 'rise'` for any net-positive transfer flow above its activity floor, including thin, noisy signals; the trigger originally fired on any rise regardless of confidence, so a 52-in/48-out signal would tell the user "buying later costs more" with no real basis. It now reuses the existing `PRICE_BUY_NOW_CONFIDENCE` constant — the same bar the Planner's own "Buy now" badge already uses — rather than introducing a second, looser threshold.

### 14.8 The two honesty rules, together

1. **Estimated inputs downgrade confidence** (§14.6) — a verdict never sounds more certain than its weakest load-bearing input.
2. **Empty boards state their emptiness** — a lane with nothing to say (most often Structure Fix, §14.3; sometimes Future Prep when no swing clears `FUTURE_MIN_FAR_GAIN`) renders an explicit "nothing here" state. Per `CONVENTIONS.md` §9, a board never pads itself with a weaker suggestion to look busy — silence is the honest answer some weeks.

---

## 15. Full Season strip (`engine/season.js`)

Full design: `docs/superpowers/specs/2026-09-01-full-season-strip-design.md`. Rendered by `modules/fullSeason.js` as a collapsed GW1–38 ribbon on the Matchup page, each column expanding into a floating detail panel. Several rules below ship differently than that spec's §6 describes — the divergences are called out inline, and **the code is what's documented here, not the spec.**

### 15.1 Two-sided matchup read (`buildGameweekMatchups`)

A fixture is scored **twice**, once from each side's own `scoreFixture` call. The matchup's headline `value` is the higher of the two, and the side that produced it becomes `favouredId` — so the panel's "which team does this fixture favour" indicator falls out of the same number rather than needing a second rule to agree with it. A club playing twice in the gameweek (an occurrence count over `homeTeamId`/`awayTeamId`, not a squad import) marks every fixture it appears in that week `isDouble`. Rows are sorted by `value` descending and capped at `SEASON_TOP_MATCHUPS` (3).

### 15.2 Week strength (`isLoadedWeek`)

A week reads as **loaded** once at least `SEASON_LOADED_MIN_GREAT` (2) of its (already-capped-at-3) top matchups clear `BANDS.great` (75). Postponed rows are excluded from the count before the threshold is applied — a `null` `value` must neither trip the comparison nor throw. One blowout fixture is an ordinary week with a good fixture in it; two together is what the UI's glow is for.

### 15.3 Postponement attribution — an inference, and display-only (`attributePostponements`)

FPL sets `event: null` on a postponed fixture and does not retain the gameweek it was originally scheduled for — `season.pendingFixtures` carries these with `gw === null`, exactly as ARCHITECTURE.md §9 describes. The Full Season strip still wants to show *where* a postponement left a hole, so `attributePostponements` derives one:

1. For every gameweek that has **any** scheduled fixture, collect the clubs with no fixture in it.
2. A pending fixture is a candidate for a gameweek only if **both** its clubs are blank there.
3. It is attributed to the **earliest** such gameweek — a rearranged fixture always lands later than the hole it left, never earlier.
4. A gameweek with **no** scheduled fixtures at all is skipped outright, not treated as a hole — every club is trivially "blank" in an unplayed stretch of the season, and matching on that would wrongly swallow every pending fixture into the first empty gameweek found.

**This is display-only.** The inferred gameweek is written nowhere but the strip's own `note` text (worded to say the attribution is *inferred*, so a wrong guess reads as a guess) — it is never merged back onto the fixture object and never reaches `scoreFixture` or any horizon aggregation. ARCHITECTURE.md §9's rule that gameweek aggregation must skip `f.gw === null` fixtures — enforced by `fixturesForTeamInWindow`'s own guard — is completely untouched by this: that guard only ever sees the fixture's real (`null`) `gw`, because `attributePostponements`'s output is consumed nowhere near it. §9's statement that a postponed fixture "has no gameweek to sit inside" and this feature's inferred gameweek are not in tension — one is about what feeds a score, the other is purely what a panel note says.

### 15.4 Bottom-up matchup slot filling (`fillMatchupSlots`)

Once a gameweek's live matchups and its attributed postponements are both known, they share the same `SEASON_TOP_MATCHUPS` (3) slots — live rows fill from the top, postponements from the **bottom**. Slot 1 is reserved for a live fixture whenever one exists at all, so a week with two postponements out of three reads as "one real fixture left to plan around" rather than being visually indistinguishable from an ordinary three-fixture week with the rows merely reordered. Only when no live fixture remains at all does a postponement occupy slot 1.

### 15.5 Player form cache (`buildPlayerFormCache`)

`calcPlayerForm` reads a player's own history and the league context — neither depends on which gameweek is being asked about — so it is computed exactly **once per player** (~700 calls) into a `Map<playerId, PlayerForm>`, and every one of the 38 per-gameweek `buildGameweekPlayers` passes reads from that cache instead of recomputing it. Only the cheap part — which clubs have a fixture that specific week, and that week's best fixture score per club — repeats 38 times. This is what keeps a league-wide top-5 ranking for all 38 gameweeks affordable; without the cache the same ~700 form computations would re-run once per gameweek instead of once, total. The ranking is deliberately squad-agnostic throughout — no `ownedBy` filter anywhere in the read — so the strip works before anyone has imported a team.

### 15.6 Chip windows, searched per half (`buildChipWindows`, `recomputeChipWindows`)

GW1–`CHIP_RESET_AFTER_GW` (19) and GW20–38 are searched **independently**, which is also the entire mechanism that stops a window straddling the reset — a candidate run that would cross GW19 is simply never assembled in either half's search. FPL reissues every chip after GW19, so a window spanning it would be advice nobody could act on.

**Wildcard — diverges from spec §6.5.** The design spec describes the wildcard window as chosen "across the top `WC_TOP_TEAMS` clubs", mirroring how the existing squad-aware planner chip logic (`engine/chips.js`, which genuinely does read `WC_TOP_TEAMS` — FEATURE_ENGINE.md's Planner sections) picks its wildcard point. The shipped rule is different, and `WC_TOP_TEAMS` is never imported by `season.js` at all: for every contiguous run of `WC_WINDOW` (5) gameweeks sitting wholly inside the half, `buildChipWindows` sums each week's `matchupTotal` (the sum of that week's top-3 matchup values from §15.1) and picks the run with the highest total. That is a whole-league fixture-quality read, not a top-N-clubs read — consistent with the rest of the strip's squad-agnostic design (§15.5), but not what the spec proposed. Do not "fix" this back to a `WC_TOP_TEAMS` read without re-reading this note; it is deliberate.

**Free Hit and Triple Captain omit themselves when nothing discriminates them.** Free Hit picks the single week with the highest `blankCount` in the half; Triple Captain picks the single week with the highest `bestPlayerPoints`. Both are found with an `Array.reduce` seeded on the half's first row (`rows[0]`) and a strict `>` comparison — and both are then gated by a floor check before being pushed: `blankCount > 0` for Free Hit, `bestPlayerPoints > 0` for Triple Captain. The floor exists because a strict `>` reduce seeded on `rows[0]` has a blind spot: when every row in the half is tied — concretely, `blankCount` is 0 everywhere because nothing has actually blanked yet, or `bestPlayerPoints` is 0 everywhere because the player pass hasn't run yet (see below) — the reduce never finds anything greater than its own seed, so it silently returns `rows[0]` itself: gameweek 1, or GW20 in the second half. Pushed unconditionally, that would render as if gameweek one were a considered recommendation, and it would be indistinguishable in the UI from a genuine one. The floor check is what stops that: a half with nothing to discriminate on now omits the chip's bar from the rail entirely. An absent bar reads correctly as "nothing to recommend yet, or nothing damaged"; a bar confidently sitting on gameweek one when the truth is "no real signal" does not, and a wrong-but-confident recommendation is worse than none.

**Two-phase computation.** `buildSeasonModel` is normally called once with `{ skipPlayers: true }` (from `modules/fullSeason.js`'s `rebuild()`) so the ribbon can paint immediately from fixtures and matchups alone, without waiting on the ~700 form computations §15.5 describes. At that moment every gameweek's `players` is `null` and every `gwStats` entry's `bestPlayerPoints` is `0` — so the omission rule above correctly withholds Triple Captain from this first pass. That is the rule working as designed, not a bug to chase down. The module's chunked background pass (`runPlayerPass`) then fills `g.players` gameweek by gameweek and, once every week has its top five, calls `recomputeChipWindows(model)` — which rebuilds `gwStats` from the now-populated `players` and re-runs `buildChipWindows` for real — before the module paints the rail. The reader never sees the first pass's answer: the strip is skeletoned as a whole from `rebuild()` until `runPlayerPass` finishes all 38 weeks, so the rail is drawn once, from the recomputed windows. (It used to paint immediately and then have Triple Captain appear a few seconds later — the two-phase design showing through as a mark that moved under the reader.)

**Downstream, for context:** `modules/fullSeason.js`'s rail renders one bar per chip window that covers a given gameweek, not a single "winner" — Free Hit and Triple Captain can legitimately land on the same week within a half, and both bars are drawn stacked inside that gameweek's cell rather than one being dropped silently.
