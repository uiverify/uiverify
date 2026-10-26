# Anti-patterns (each of these is a real run that failed)

Part of the `implement-figma-design` skill; the sections named in quotes are in its `SKILL.md`.

- **Batching fixes across sections**, so a regression cannot be attributed. (3.42% -> 4.72%, run stalled.)
- **Letting the number veto a correct diagnosis.** One run wrote *"footer link spacing is ~2px/line too
  tight, card body ~3px high"* - correct, measured - bundled it with an unrelated wrong fix, saw the number
  rise, and reverted **all three**. Those errors were still on the page at accept time.
- **Bisecting margins against the scalar** ("the midpoint between rounds 15 and 16"). Eleven rounds, 0.3
  points, zero sections locked.
- **Declaring an "AA floor" from a page-tall slice**, or from the overlay alone.
- **Declaring an "AA floor" from whole-pixel bounding boxes**, before an ink-centroid pass. Every box "within
  1px" is not the floor - it is the resolution limit of the wrong ruler. (A header stalled at 0.90% this way;
  centroid+ink took it to 0.125% with real fixes: weight, rotation, two sub-pixel offsets.)
- **Stopping at a low flat number instead of at true convergence or 50 uploads.** 1.09% with a default UA
  button border and a nav row 1px off in tracking still lit is not a floor; the last run declared it one at
  upload 30 and wrote a victory report whose "read baseline and candidate at each window" claim its own tool
  log flatly contradicts (one honest read in thirty rounds). Continue within the budget when inputs are
  available; otherwise report incomplete with the unresolved dependency.
- **Substituting URLs or the `diff` overlay for inspecting original baseline/candidate pixels.**
  Downloaded original PNGs are valid evidence when their identity and inspected windows are recorded.
  URLs and thresholded overlays alone cannot certify geometry (see "The evidence-pair gate").
- **Writing a report from memory / impression instead of the per-round measurement log**, so it claims work
  that the tool log does not show. Cite measured numbers per round, or it did not happen.
- **Moving the cursor up, or ranking blocks by changed pixels and jumping around.** One run's rounds
  13-24 went CTA -> cards -> CTA -> hero -> nav -> logos -> cards -> nav; another alternated nav and
  footer from round 2. Neither ever had a block at zero.
- **Declaring a block "locked" at "within 1-4px".** Those pixels are the residual you later call AA.
- **Leaving a measured error because "it would cascade".** Recompute the intended downstream
  spacing and verify affected blocks.
- **Stopping because the decrement got small** ("only hundredths per fix"). That is the number deciding.
- **Explaining a non-zero row as cross-engine AA / baseline snapping / threshold noise.** Both recent runs
  wrote confident essays of this kind for elements measuring +17, +19, -10 and 3px off. The words are
  reserved for rows at 0 (see "The element table").
- **Accepting at all** - it rebases the baseline onto your render and poisons every later upload (a prior
  run accepted at 2.8%, then chased a ~13% phantom against its own snapshot for 20 rounds).
- **Hiding a wrong section height in the margin below it** so `sizeChanged` looks false while the structure
  is wrong.
- **Measuring your own served page / DOM** instead of UI Verify's candidate.
- Looking at the diff **once** and then iterating on the number plus screenshots of your own page.
- **Uploading the whole Storybook every round** with `uiverify upload`. One run re-rendered 16 stories per
  round, 12 of them button variants nobody was touching, for ten rounds straight. `check --target` the
  design's story.
- Misreading a headline halo as a missing `font-weight` and quitting at a plateau.
