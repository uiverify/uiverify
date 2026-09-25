---
name: implement-figma-design
description: Implement a Figma design (a Figma frame link or an exported PNG) in code as a Storybook story and converge the render to it using UI Verify as the source of truth. Declare the design as the story's baseline (`parameters.uiVerify.baselineImage`), build, upload, then converge SECTION BY SECTION from the top of the page down - reading UI Verify's localized diff and measuring the baseline/candidate pixels (never your own screenshots), fixing one section per upload until it is locked, then moving down. Stop at the minimum WITHOUT accepting - accepting rebases the baseline off the design. Use when building a page/component to match a provided design image, e.g. "implement this Figma", "build this design", "match the mockup", "reproduce this landing page and make the diff go away", "close the design-baseline diff". Not for accept/deny triage of a normal regression build (that is triage-visual-changes).
---

# Implement a Figma design with UI Verify (the design is the source of truth)

You are building a page/component in code to match a **design image** (a Figma export or mockup screenshot).
UI Verify sets that image as the story's baseline, renders your story in its own browser, diffs it against
the design, and hands you back the delta. You converge until the delta is gone, and **stop there. You do
NOT accept** - accepting would rebase the baseline off the design (see "Do not accept" below).

**The flow: get the design PNG -> declare it as the story's baseline -> build the whole page once -> then
sweep top-to-bottom, locking one section at a time -> stop at the minimum.**

Read "The section sweep" below before your second upload. It is the whole method. Four previous agents
failed this task, all in the same way: they treated convergence as *tuning a number* instead of *locking
sections*, and all four stalled between 2.5% and 5% and declared a floor that was not a floor.

## Evidence integrity

These qualifications apply to the sweep and the historical examples below:

- Record the commit, build ID, diff ID, baseline image hash, candidate image hash, dimensions, and mask
  scope for each round. Concurrent runs can share the server's `branch` value; resolve builds by commit.
- `metrics.changedPct` is a **fraction**. Display `100 * changedPct` followed by `%`, alongside changed
  pixels and canvas dimensions. For example, `0.01581616` means `1.581616%`. The denominator includes
  ignored areas and empty space; this is not a visual-similarity score or a ranking between designs.
- Only ignore content explicitly excluded by the task. Missing static photos/assets are unresolved
  dependencies, not permission to add masks. Record missing assets and the evidence for the target font;
  bundled font files alone do not establish the font in a newly supplied design.
- Verify an ignored region's outer bounds, border, radius, and surrounding spacing against the original
  design separately. Candidate-sized masks can hide an oversized container. Masking a child rectangle can
  also hide overlapping labels and controls, even when they are siblings in the DOM.
- Use one row per element or text line. Check text content, wrapping, outline, fill, border, radius, and
  gaps as well as position/size. Group centroids can conceal opposing errors; matching centroid and total
  ink do not prove matching shapes. A measurement window must include the complete element on both sides.
- Segment the foreground before measuring ink. `255 - gray` applies to dark foreground on a white
  background only. On dark/colored/gradient backgrounds, estimate the local background and measure
  foreground contrast with the correct polarity. If segmentation is unreliable, mark the measurement
  inconclusive and inspect the pair; do not certify a lock from it.
- The historical ~0.1% AA examples are not a universal floor. The centroid/ink tolerances are diagnostics,
  not proof of rasterization differences. Establish any claimed rendering floor with relevant controlled
  evidence; trying two settings unsuccessfully does not establish that all remaining errors are AA.
- Revalidate dependent blocks after changes to shared styles or upstream geometry. Top-down order helps
  ordinary flow layout but does not guarantee independence. Correct section height and the intended gap
  separately; do not compensate with arbitrary spacing just to keep the page height unchanged.

## Stop states: convergence, budget exhausted, or an unresolved dependency

If assets, reliable measurements, or the required native MCP remain unavailable, report **incomplete** with
the blocker and residuals. Do not spend uploads on an unavailable input or describe an incomplete run as
converged. Otherwise continue the sweep within the upload budget below.

You do not get to stop because the number "feels done". When the required inputs and tools are available:

1. **Converged** - every section passes the hard stop test ("The stop test" below) AND `sizeChanged` is
   false, every required asset is present, mask scope is explicit, and every remaining discrepancy has
   an evidenced explanation. A centroid+ink pass or a small global percentage alone cannot establish this.
2. **Out of budget** - you have made **50 uploads** and it still is not converged. Then you STOP, write the
   honest incomplete report (best %, which sections are locked, and every remaining error as a measured
   number), and tell the user they may continue in a fresh session. You do **not** accept.

"1.09%, looks like AA, done" is not a stop condition - it is the exact sentence every failed run wrote while
fixable geometry (a default button border, a nav row 1px off in tracking, a gradient word) was still lit on
the page. If fixable errors remain and inputs/tools are available, keep going within the budget.

**The evidence-pair gate.** Before each upload after round 1, inspect and measure the current section
in the design baseline and the preceding UI Verify candidate. Use the matching `render_diff_image` views,
or download the original PNGs through `get_diff` and record their build/diff IDs, hashes, and crop window.
A URL request alone is not an image read. Reuse a baseline only after confirming its identity is unchanged.
The thresholded overlay alone is insufficient; original PNG pairs contain the same usable evidence
regardless of which native MCP retrieval method supplied them.

**Log every round, and build the report ONLY from that log.** Each round record: the section you were
locking, the `diffResultId` and `pxPagination` window you read, and the measured baseline-vs-candidate
numbers you acted on (`headline: design 646 wide / render 631, -15 -> font-size 54->57`). Your final report
must cite these per-round measurements. Never write a summary claim like "I read baseline and candidate at
each window" - a prior run wrote precisely that while its tool log shows one honest read in thirty rounds.
If a measurement is not in your round log, it did not happen and it does not go in the report.

**The flatline trip.** If the number moves less than ~0.05% across three consecutive uploads while
`sizeChanged` still toggles `true`, you are NOT near a floor - you are re-lighting the same glyph edges with
tracking nudges while an unmeasured box or section height sits untouched. Stop editing text and do a full
baseline/candidate sweep from the top to find the box you never measured.

## The algorithm - a cursor over blocks, and it only moves DOWN

This is not advice, it is the loop you run. It is how a person would do it with the design and the render
side by side: *"Does the very top look right? No - fix, fix, fix, upload, look again. Yes? Good, I never
touch it again. Next block down. Does it look right? ..."* all the way to the bottom.

0. **Before round 2, write the block list.** Split the design at its real whitespace boundaries into blocks
   of ~100-400px (nav, hero badge+headline, subtitle+buttons, logo strip, card row, CTA, footer columns,
   footer legal ...). Record each block's design y-range. The list is fixed for the rest of the run.
1. **Put the cursor on block 1.** Read `baseline` and `candidate` at exactly that window.
2. **Fill the block's element table** (see "The element table"): every text run, box, pill, icon, divider,
   image edge in the block - design bbox vs render bbox, dW dH dx dy, colour, and centroid/ink for rows
   already at 0.
3. **Fix every non-zero row.** All of them, in one edit, all inside this block (plus the one gap directly
   above it if the whole block is uniformly offset). Nothing outside the block.
4. **Upload. Re-read the SAME window. Re-fill the SAME table.**
5. **Locked?** Every row is 0 in dW/dH/dx/dy, colour matches, centroid within 0.3px, ink within 3%. If yes,
   write `LOCKED` next to the block in your round log and **move the cursor down one block**. If no, go to 3.
6. **Per-block budget: 15 uploads.** If a block is not locked after 15 uploads spent on it, write
   `NOT LOCKED` with its table (the rows still non-zero) in the log and move the cursor down anyway. Do not
   spend a 16th on it. You return to it only after the last block, and only with budget left under 50.
7. When the cursor passes the last block: **walk once more top-down, re-filling every table.** Any non-zero
   row reopens that block (cursor jumps to it, fixes, then continues down from it). When a full walk finds
   nothing, you are converged - stop.

Rules of the cursor:
- **It never moves up on its own.** Not to "fix the nav colour I just noticed", not because "cards is the
  biggest section now". Anything you notice above the cursor goes in a note; the final walk gets to it.
- **Never rank blocks by changed pixels and jump to the biggest.** One run did exactly this from round 13
  on ("aggregate changed pixels per section to rank what's left") and spent 12 uploads bouncing
  CTA -> cards -> CTA -> hero -> nav -> logos -> cards -> nav. Its nav was never actually locked: links 2px
  high at the end.
- **"Locked" means zero, not "within 1-4px".** That run wrote "Nav locked - all links within 1-4px" at round
  4 and moved on; those pixels were still wrong at the end. A row of 1 is a fix, not a tolerance.
- **One block per upload, always.** Another run batched "hero drift + footer spacing" in round 2 and "nav
  band + newsletter tracking + divider width" in round 16, then reverted because it could not attribute the
  regression.
- **A fix that shifts everything below the block is normal**, not a reason to skip it. Re-measure the
  section's own height and the intended gap below it; revalidate dependent blocks. Do not cancel a height
  error with arbitrary spacing merely to keep a downstream anchor fixed.

Did the two most recent runs do this? No. One swept top-down for rounds 1-12 with a loose lock (1-4px
counted as locked), then abandoned the order. The other never had a cursor at all: from round 2 it
alternated nav <-> footer <-> cards every round, declared "body locked" with "cards -3px, footer -3px,
negligible", and finished with its nav links 3px low and a footer text row 19px too wide.

## Step 0a - get the design as a PNG

You need the design as a **1x PNG at the page's real canvas size** (a 1200px-wide frame exports as 1200px
wide, not 2400 or 1024). Get it in this order:

1. **The user gave you a PNG** - use it. Check its size with PIL; if it is 2x, ask for a 1x export rather
   than resizing it yourself.
2. **The user gave you a Figma link and the Figma MCP is connected** - export the frame with
   `download_assets { fileKey, nodeId, defaultFormat: "png", defaultScale: 1 }` and download the `export`
   URL into the repo (e.g. `.storybook/public/design/page.png`). Take `fileKey` and `nodeId` from the URL
   (`node-id=12-34` -> `12:34`); if the link has no `node-id`, ask for a link to the frame itself. If you
   use `get_screenshot` instead, pass `maxDimension` at least the frame's longer edge (its default of 1024
   silently downscales a page), and confirm the PNG's size equals the frame's `original_width` x
   `original_height`.
3. **Neither** - stop and ask the user to export the frame from Figma as PNG at 1x (select the frame ->
   Export -> PNG, 1x) and put it in the repo. Do not build from a screenshot of a screenshot.

If the Figma MCP is connected, `get_design_context` on the same node gives you the design's own values
(font family, sizes, weights, colours, spacing). Use them for the first build. They are a starting point:
UI Verify's diff against the PNG still decides what matches.

## Step 0b - set up the story with the design as its baseline

Once per project, before the first upload:

- **The UI Verify MCP is connected** (setup: the `triage-visual-changes` skill, "Connect the MCP"). If its
  tools are not in your session, stop and tell the user; the MCP connects at session start.
- **The story has never been accepted in this project.** UI Verify uses the declared design as the baseline
  only when the story has no accepted baseline. If it was accepted before, use a new story id (or a fresh
  project), or you will converge to an old render instead of the design.
- **You have the design's font files** (woff2). If you can't identify or get the font, tell the user: every
  line of text will differ and the run can't finish.

Then:

- On the story, declare the design image:
  `parameters: { uiVerify: { baselineImage: "<path-or-data-uri>" } }`. The key is **`uiVerify`**
  (camelCase). The value is either a **bundle-relative path** to a PNG that ships inside your built
  Storybook (a `staticDirs` asset, e.g. `"design/hero.png"`), or a **`data:image/png;base64,...` URI**.
  **PNG only.** No `http(s)`/`file:` URLs, no absolute paths, no `..` - the image has to live inside the
  artifact you upload.
- Mark an **explicitly excluded dynamic region** (a video, an autoplay animation, a live/random
  background) with the
  `data-uiverify-ignore` attribute. UI Verify blanks that box on both the design and your render, so its
  noise never counts. The whole bounding box is blanked, so keep critical foreground text out of it.
- Match the design's **canvas width** and **fonts**. If the design was drawn at 1200px, build at 1200px; if
  it uses a specific font, self-host it (ship the woff2 in the bundle) so text metrics match. Without the
  exact font, every line of copy diffs.
- **Each round is a commit plus an upload.** Builds are keyed by commit SHA, so commit first, then build
  Storybook and upload it. This is a local loop; it needs no pull request and no CI:

  ```sh
  git add -A && git commit -qm "attempt N: <block>: <change>"
  npx storybook build -o storybook-static   # or your repo's build script
  UIVERIFY_API_KEY=uv_proj_... npx -y uiverify@latest upload --static-dir ./storybook-static
  ```

## THE RULE - UI Verify is the only source of truth

- **All diffing is done by UI Verify, through the native `mcp__uiverify__*` MCP tools.** Never compute
  a diff yourself (no `pixelmatch`/`resemblejs`/`odiff`/ImageMagick compare, no PIL subtraction).
- **No private measurement loop.** Never serve `storybook-static` yourself, never open your page in
  Playwright or any browser, never screenshot it, never read your own DOM (`getBoundingClientRect`, Range
  metrics). The only view of your render that counts is the one UI Verify renders. A DOM box is not the
  inked pixels: one run measured its own DOM, declared "every property matches within 1-2px", and accepted a
  page whose buttons were 20px too wide and whose card row was 15px too tall.
- **You MAY measure sizes and positions with Python/PIL** - on the design PNG, and on the
  `baseline` / `candidate` PNGs UI Verify returns (`get_diff` URLs). Widths, heights, row tops, colors.
  That is measuring, not diffing, and it is the most effective thing you can do (see "Measure, do not
  eyeball").
- **The changed-% is a progress log, NEVER a decision input.** It is one area-weighted scalar over the whole
  page. It cannot tell you *where* anything is wrong, and it will rise when you correctly fix a small error
  while a large one remains. Never revert a measured, localized fix because the number went up. Never pick
  values by bisecting the number ("try the midpoint of round 15 and round 16") - that is not convergence,
  that is curve-fitting noise.
- **`get_build` returns the NUMBER, not the diff. You are FLYING BLIND until you view the pixels.**

## The section sweep (the method)

After the first whole-page upload, stop thinking about the page and think about **one section at a time,
from the top down.**

**Why top-down is not just tidy:** in ordinary flow layout a height/gap fix in section *k* moves sections
*k+1…N* and usually leaves everything above it alone, so sweeping downward keeps most of what you finish
finished and gives you a simple reading of inherited drift: if everything above section *k* is locked and
section *k*'s contents are uniformly N px off, the first suspect is **the gap immediately above this
section**, not the elements. It is a heuristic, not a guarantee - a shared style, a font-size change on a
reused class, or a width change that re-wraps text can reopen a block above. When a fix touches anything
shared, re-fill the tables of the blocks that depend on it.

The loop:

1. **Identify the current section's own pixel bounds** in the design - nav, hero, logo strip, card row, CTA
   band, footer. Use the design's real boundaries (find the whitespace gaps), not a blind 300px grid; you do
   not want a button row sliced in half. A section is typically 150-400px tall.
2. **Read that exact window in BOTH images**: `render_diff_image which:"baseline"` and `which:"candidate"`
   at the same `pxPagination` offset/height, plus `which:"diff"` for the overlay. Never the overlay alone -
   see "The overlay lies about low-contrast edges".
3. **Enumerate every discrepancy in the section as a measured number**, not an impression. "The pill box is
   298px wide in the design and 333px in my render, +35." "The button row is 47px tall vs my 50." "The
   footer column starts at y=1858 in the design and y=1849 in mine, 9px high."
4. **Fix all of them.** Batching *within* one section is fine and correct - the fixes are co-located and you
   are about to verify them by looking at that window, not by watching the global number.
5. **Re-upload. Re-read the same window. Confirm it is clean.** Only then move the cursor down to the next
   section.
6. **Never batch fixes across sections.** This is the rule that both recent runs broke, and it is what
   killed them. Verification granularity must match change granularity: if you change the hero and the
   footer in one upload and the number rises, you have learned nothing and you will revert the good fix
   along with the bad one. One section per upload.

Budget: locking a 2000px page is ~7 sections, and ~2 uploads per section is the *floor of effort*, not a
target you stop at. You have a **50-upload budget** overall and **15 per block** (see "The algorithm") -
spend it driving each block to zero rows, not stopping the moment the overlay looks calm. Under-using the
budget is how runs stall: the last three stopped at uploads 30, 25 and 23 with measurable geometry still on
the page.

## Anchor in absolute design coordinates

The strongest technique available to you: measure the design once to get the **absolute y of every section
boundary** (and the absolute x of every column), then measure the same anchors in your candidate and solve
for the property.

> design divider is at y=1810; my CTA bottom is at 1748 and my current margin is 29, so I compute 1777;
> to hit 1810 I need margin-top = 62.

That is a derivation, not a guess. Do this instead of nudging.

**But it only works top-down and one section at a time.** That arithmetic is a chain: if you also change
something *above* the CTA in the same round, the CTA bottom moves and your footer number is already wrong
before it lands. A previous run computed exactly the footer margin above, changed the card padding in the
same upload, and went 3.42% -> 4.72%.

**And match each section's OWN HEIGHT, not only where it lands.** Absolute anchors alone can be satisfied
by cancelling errors: a card row 15px too tall plus a margin below it 8px too small, a preview band 11px too
short plus a gap 12px too big. Every later section lands at roughly the right y, the overlay looks calm, the
% stays low - and the structure is wrong. For every section check top, bottom AND height against the design.

**`sizeChanged: true` means you are not done.** If the candidate's height differs from the design's, some
section's height is wrong. Keep going - never treat it as done.

## The overlay lies about low-contrast edges

`which:"diff"` highlights per-pixel differences above a threshold (often ~0.06). A **low-contrast** element -
a near-white pill on white, a pale card fill, a light divider - can be displaced by tens of pixels and still
not trip the threshold, while the dark text inside it lights up green.

The overlay then tells you the exact opposite of the truth: *"the box is fine, only its text moved."* In one
run a badge pill was **35px too wide (12%)** and showed **zero highlight** on its outline; the agent read the
clean outline as proof the pill was correct and called the green text "AA fringe".

**Therefore: never judge a section from the overlay alone.** Always also read `baseline` and `candidate` at
the same window. A box that looks clean in the overlay can be the most wrong element on the page.

## Measure, do not eyeball

Eyeballing produces "the buttons look a bit off", which leads to nudging. Measuring produces "+3px tall,
+9px wide", which leads to a padding fix. Pull spans out of the images with a script:

- **horizontal extent** of a text run -> its rendered width -> `font-size` / `letter-spacing`
- **vertical extent** of a row -> its height -> `padding` / `line-height` / `font-size`
- **row tops down a list** -> the *pitch* between lines. A **constant** offset on every row is a block
  translation (fix the margin above). A **growing** offset is a `line-height` error. These look identical in
  an overlay and are told apart only by the numbers.

## Diagnosing what the green means (read it, don't guess)

Work out which *dimension* is wrong before changing anything:

- **Element at the right position but the wrong WIDTH** (box and text both scaled) = a text metric:
  `font-size` first, then `letter-spacing`. `font-weight` is a **last** guess, not a first - but it is NOT
  "never": if the bundle ships that weight AND an ink-density measurement (see "Measure ink, not boxes")
  shows the glyphs carry more/less ink than the baseline at the same width, weight IS the fix (a header
  wordmark that was horizontally dead-on was still +9% ink - `700` vs the design's `600`). Asking for a
  weight the bundle does *not* ship changes nothing and proves nothing, so confirm the woff2 is loaded first.
- **Box the right size but its contents offset inside it** = `padding` or an internal gap.
- **Box the wrong size with correct-size text** = `padding` / explicit width / `line-height`.
- **A whole section uniformly displaced, with everything above it already locked** = the gap immediately
  above it. Fix that one margin, not the section.
- **Rows whose offset grows down a list** = `line-height`.
- **A thin, even fuzz that hugs every glyph edge at <=1px with NO displacement** is the only pattern that
  *might* be rasterization. Note that the verifier runs pixelmatch with `includeAA:false` and threshold
  `0.063`: pixels it classifies as anti-aliasing are already discarded before the count. So a lit edge has
  survived the AA filter, and you may call it AA only after the element's row reads 0 (see "The element
  table").

**If a fix does not work, change DIMENSION, not magnitude.** Both failed runs got stuck turning the same
knob harder. One saw the two hero buttons differ, decided the *gap* between them was wrong, tried 16->20px,
saw the number rise, and concluded "sub-pixel artifact". The buttons were in fact 3px taller and 9px wider -
a `padding` bug it never tested, because it never left the "gap" hypothesis.

## Measure INK, not boxes (the last mile: sub-pixel position and weight)

Bounding boxes round to whole pixels, so they go blind exactly when you get close. A header run stalled at
**0.90%** because every element's bbox was "within 1px" - it called that the AA floor. It was not. Whole-pixel
bboxes cannot see the two things that dominate the last mile, and a switch of *measurement* (not effort) took
it **0.90% -> 0.125%**, a 7x drop, all real fixes:

- **Sub-pixel position.** A block 0.3px off, or a group 0.7px off, rounds to the same bbox yet paints a real
  fringe. Measure the **intensity-weighted centroid** of an element - `sum(x * ink) / sum(ink)` where
  `ink = 255 - gray` **only for dark foreground on white**, with background-aware segmentation elsewhere.
  Compare baseline and candidate; it can resolve shifts below 1px. Test a fractional
  transform, e.g. `translateX(-0.15px)` on the group. **Horizontal sub-pixel nudges work.**
- **Ink density = weight or size, not position.** An element dead-on in position can still be ~10% too heavy.
  Measure **total foreground ink** and foreground color using the appropriate background model; if
  the candidate carries
  more ink than the baseline at the same width, the glyphs are heavier or larger. On that header the wordmark
  was horizontally perfect and still wrong - `font-weight 700` vs the design's `600`, +9% ink; weight 600 fixed
  it. Centroid+ink also exposed a logo mark that was un-rotated by ~5deg (same total ink, shifted centroid +
  wrong outline). None of this is visible to a whole-pixel bbox or to the eye.

The rule: **when every bbox reads "within 1px" but the window still lights up, your ruler is too coarse -
switch to centroid+ink (with correct foreground segmentation) before you conclude anything.** The
gain comes from a sharper
measurement, not from turning a knob harder (which is the number-chasing trap).

**Validate sub-pixel experiments.** Compare the UI Verify candidate images or their pixel-content hashes;
an unchanged changed-pixel count does not mean the images are identical. Establish whether a fractional
CSS adjustment affects this element in this capture environment rather than assuming universal snapping.
Neither an unsuccessful adjustment nor matched centroid/ink proves cross-engine AA. Keep an unexplained
residual unresolved, and use the final visual sweep to catch shape, wrapping, border, and spacing errors.

## Slice sizes

Cap `pxPagination.height` at **~400**. A page-tall slice averages everything into a grey wash where real
geometry is indistinguishable from anti-aliasing. One run paged at `height: 1019`, looked at the result, and
wrote *"the page is now dominated by thin AA fringe"* - at that zoom, a 13px footer displacement and a 35px
pill error both look like fringe. It then accepted.

## The element table (the artifact that replaces "looks fine")

For the block under the cursor, produce this table every time you read the pair. It is the only form of
"looks fine" you are allowed:

| element | design x0-x1 / y0-y1 | render x0-x1 / y0-y1 | dW | dH | dx | dy | colour D / R | centroid / ink | fix |
|---|---|---|---|---|---|---|---|---|---|

One row per text run, box, pill, icon, divider, image edge. Measure with PIL on the two PNGs UI Verify
returned (bbox by a threshold that suits the background - dark pages need `>40`, not `<170`; centroid and
ink for rows already at 0). The table goes in the round log verbatim, and the report is built from these
tables and nothing else.

What the table stops you from doing: writing "footer within 1px" next to a row that says +17. One run's
final explanation attributed a footer tagline to "cross-engine AA"; the row reads dW=+17 (font-size).
Another explained a row of small footer links as "small low-contrast text trips the threshold"; the row
reads dW=+19, dx=-10, colour 138 vs 61. Neither builder had a table, so the sentence won.

**You may use the words "cross-engine AA", "baseline snapping", "rasterizer", "threshold noise" or "floor"
for an element only when its row is 0/0/0/0, its colour matches, its centroid is within 0.3px and its ink
within 3% - and you cite that row.** Anything else is a fix you have not made yet. Two corollaries:
- **A lit outline is always real.** The overlay thresholds per pixel, so it can only *under*-report; it never
  lights a box that matches. One run on a dark page read lit pill outlines as "low-contrast threshold noise
  in the harmless direction". The pill fill was 47 vs the design's 71, and the pills were 2px taller.
- **A small decrement is not a stop signal.** "Each remaining fix moved the number by only hundredths" is the
  number as a decision input, just from the other direction. A 17px-wide tagline is ~0.05% of a page. The
  stop test is the table, never the size of the last step.

## The stop test (this is a test, not a feeling)

A section is done when, reading `baseline` and `candidate` at that window, **no element appears as a
displaced second copy, and no box differs in measured width or height.** "It looks like AA now" is not a
stop test - it is the sentence every failed run wrote just before quitting.

**Bbox-clean is necessary but NOT sufficient.** Whole-pixel bounding boxes are blind to sub-pixel position and
to ink density (weight/size). If every box reads "within 1px" but visual discrepancies remain, investigate
further with a valid **centroid+ink pass** ("Measure
ink, not boxes") on each element before you declare a floor. A header that stopped at 0.90% this way had a
+9% wordmark weight, a 5deg-un-rotated logo, and two sub-pixel offsets still on it.

The page is converged only when every section passes the stop test, `sizeChanged` is false, required
assets are present, ignored content has the agreed scope, and the final original-image sweep has no
unresolved visual defects. Record any supported rendering tolerance and its evidence. There is no fixed
AA percentage that proves this. Stop and report the final changed-% without accepting. Otherwise continue
within the budget, or report incomplete with the remaining discrepancies and any missing dependencies.

## Do not accept - it rebases the baseline off the design

**Never call `accept_build` (or `review_diff` with an accept) on this task.** UI Verify diffs against the
design only while the design is the baseline. Accepting replaces the baseline with *your render*, which (a)
hides every remaining design delta forever and (b) makes every later upload diff against your render, not the
design. A prior run accepted at ~2.8%, then a fresh session re-uploaded against that accepted render, saw
~13% "drift", and spent 20 rounds polishing a phantom against its own snapshot instead of the design. Leave
the build `changed` at its floor - that is the finished state, and it keeps the project reusable without
recreating it.

**Confirm you are still diffing the DESIGN, every round.** `get_build` must show the design as the baseline
(`hadBaseline: true`, baseline origin `design`). If it ever shows origin `render` or `hadBaseline: false`,
STOP and tell the user - the branch was accepted or the baseline failed to resolve, and the number is now
measuring your render against itself.

## The MCP tools you use (UI Verify)

Use the native `mcp__uiverify__*` tools - they return inline images you read directly. **If they
are not available in your session, stop and tell the user.** Do not fall back to `curl` against the MCP
endpoint: the MCP connects at session start, and the fix is connecting it and starting a fresh session.
(Downloading the PNG URLs that `get_diff` returns is fine - that is how you measure.)

- **`get_build { commitSha }`** - the build's changed stories, each with a `diffResultId` and `changedPct`.
  The number only. Never your last call before a decision.
- **`render_diff_image { diffResultId, which: "baseline" | "candidate", pxPagination: {offset, height} }`** -
  **your primary pair.** The design and your render at the identical window. This is what you measure, and
  it is the only view that is honest about low-contrast geometry.
- **`render_diff_image { diffResultId, which: "diff", pxPagination: { offset, height } }`** - the overlay for
  the same window; good for spotting *that* something moved, unreliable for *what*. Height <= 400.
- **`render_diff_image { diffResultId, which: "before_after" }`** - baseline and candidate side by side,
  auto-cropped to each changed region. Excellent for a fast survey - use it after every upload, not just the
  first few. (Both recent runs used it 4 times out of ~40-50 image calls, and never after round 10.)
- **`get_diff { commitSha }`** - presigned URLs for the baseline/candidate/diff PNGs. Download these when you
  want to measure spans with a script.
- **`accept_build` / `review_diff`** - **do NOT use these on this task.** Accepting rebases the baseline off
  the design (see "Do not accept"); this is converge-and-stop, not accept.

## Anti-patterns (each of these is a real run that failed)

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
- Misreading a headline halo as a missing `font-weight` and quitting at a plateau.
