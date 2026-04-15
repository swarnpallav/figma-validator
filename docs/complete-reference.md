# Figma Validator Complete Reference

This document explains the current product end to end:

- what the tool is for
- how users should use it
- what every visible part of the panel means
- what happens behind the scenes
- how far the current system can go
- where the current limitations still are

It is written for internal launch preparation and technical understanding.

## 1. Product Summary

Figma Validator is currently best understood as a **design QA assistant for Figma-to-frontend implementation**.

The shipped product story is:

1. Pick the area to validate.
2. Review visible problems in `Visual QA`.
3. Switch to `Dev` when you need implementation guidance.

The tool does two jobs:

- **Visual QA**
  - detect visible drift between the Figma reference and the browser implementation
  - explain the issue in user-facing language
  - provide exact fix guidance when confidence is high
- **Dev**
  - show technical context for the same issue
  - point developers toward the likely implementation fix
  - keep raw tree-aware diagnostics available as a fallback

## 2. Current Workflow

### 2.1 Normal user flow

1. Open the design in Figma.
2. Run the Figma Validator plugin.
3. Select the root frame, card, section, or component to validate.
4. Open the implemented page in the browser.
5. Click `Pick Area`.
6. Hover the target area and click the matching rendered container.
7. Start in `Visual QA`.
8. Switch to `Dev` only if you need implementation detail.

### 2.2 Why `Pick Area` replaced `Shift + Click`

`Shift + Click` caused two problems:

- browsers also use it for native text selection and range interactions
- blue selection highlights could pollute the comparison and confuse users

The current picker mode prevents that by:

- arming an explicit selection state
- suppressing browser text selection while armed
- clearing any existing selection before validation
- highlighting only candidate containers for selection

`Shift + Click` may still exist as a fallback shortcut, but it is no longer the primary interaction model.

## 3. What Users See

## 3.1 Page-level controls

### `Pick Area`

This is the launcher that arms selection mode.

When active:

- candidate regions highlight on hover
- one click or tap selects the area
- the picker exits after selection
- `Escape` cancels on desktop

### Overlay panel / bottom sheet

The same validator content is shown in two shells:

- **desktop**
  - fixed floating panel
- **mobile / narrow viewport**
  - bottom sheet

This keeps the main QA flow usable in both layouts without changing the core logic.

## 3.2 Top-level views

### `Visual QA`

This is the default launch-facing view.

Its job is to answer:

- what looks wrong
- where it looks wrong
- what fix is likely, when the tool is confident enough

### `Dev`

This is the implementation-facing follow-up view.

Its job is to answer:

- what exact node or relation is involved
- what to inspect in CSS/layout terms
- what change is likely to fix the issue

## 4. Visual QA: Visible UI Explained

Visual QA is now issue-first and accordion-first.

Each issue opens into its own self-contained comparison surface.

## 4.1 Visual QA accordion

Each issue header shows:

- issue number
- short summary
- issue kind
- compact numeric context such as a delta or scope

Only one issue stays open at a time. This is intentional. It keeps the user focused on one problem instead of bouncing between a global stage and a separate issue rail.

## 4.2 Guided visual view

When an issue opens, it shows a comparison stage inside that issue.

The stage contains:

- `Figma`
- `Browser`
- `Difference`

### `Figma`

Shows the selected Figma reference render for the issue area.

Important detail:

- the tool composites the Figma render onto a white background so transparent Figma exports remain visually comparable against the browser implementation

### `Browser`

Shows the captured browser rendering of the selected container.

### `Difference`

Shows the browser image with the Figma reference overlaid on top.

The only visible control in this section is:

- `Overlay opacity`

This control affects only the `Difference` pane. It lets the user increase or decrease how strongly the Figma image sits on top of the browser image.

## 4.3 Legend

The legend is issue-aware. It only shows the concepts actually active for the selected issue.

Possible legend items:

- `Expected`
- `Actual`
- `Changed area`

### `Expected`

Where Figma expects the region to appear, align, or size.

### `Actual`

Where the browser actually rendered the region.

### `Changed area`

A visually changed zone detected by the image-comparison pipeline when the tool cannot confidently express the issue as a single clean expected-vs-actual pair.

## 4.4 Issue details

Inside the open accordion body, the issue details explain the selected problem.

The visible sections can include:

### `Expected vs Actual`

Shown for high-confidence positional issues such as:

- spacing
- alignment
- inset
- size

This means the tool believes it can point to:

- where something should be
- where it currently is

### `Changed Area`

Shown for weaker or non-positional issues such as:

- generic visual drift
- some style-only problems
- some text/typography problems
- cases where the mismatch is real but the exact displaced box is not trustworthy enough

### `Technical hint`

A compact explanation sourced from the tree-aware issue engine when available.

Example:

- `Expected aligned top edges. Browser offset: -13px`

This is useful, but it is secondary. Visual QA should still make sense even before the user reads this.

### `Recommended fix`

Shown only when the tool has high enough confidence to convert the issue into an explicit fix instruction.

Examples:

- `Make the icon top-aligned with the content block.`
- `Gap between icon block and content block should be 8px; browser is using 12px.`
- `Set letter spacing for the title to 0px instead of 0.2px.`

### `Why this fix is likely`

Explains why the recommended fix is trustworthy.

Examples:

- the issue came from a mapped relation with exact numeric values
- the style diff was explicit on a mapped text node

### `What to verify after the fix`

Shown when an exact fix exists.

This helps the user confirm the issue is visually gone after the change.

### `What to check`

Shown instead of exact fix verification when the tool cannot confidently provide a precise recommended change.

## 5. Dev: Visible UI Explained

Dev is now the fix-focused technical view.

It is not meant to be the first place a QA user spends time. It is the next step after `Visual QA`.

## 5.1 Fix handoff

This is the top summary card in Dev.

It answers:

- `What looks wrong`
- `Where to look`
- `Recommended fix` or `What to inspect next`
- `Why this fix is likely`
- `Technical hint`

This is the shortest path from symptom to engineering action.

## 5.2 Relevant nodes

Dev then shows the nodes most relevant to the visible issue.

Each node card can include:

- raw mapping status
- geometry comparison
- text comparison
- style diagnostics
- `Visual symptom flags`

## 5.3 Visual symptom flags

These are Dev-facing issue summaries attached to specific mapped nodes.

They reuse the same issue engine as QA, but with more implementation context.

They can show:

- issue summary
- whether the node is the primary or related anchor
- recommended fix
- why that fix is likely

## 5.4 Advanced raw tree diagnostics

This is where the lower-level matcher and tree-aware information still lives.

It is still useful for:

- unmatched nodes
- candidate review
- raw mapping suspicion
- difficult repeated-component debugging

It is no longer the main product story.

## 6. What Happens Behind The Scenes

The system has four major layers:

1. Figma snapshot + reference render
2. Browser capture + DOM candidate extraction
3. Tree-aware validation and issue derivation
4. Visual QA rendering and fix recommendation

## 6.1 Figma plugin

The Figma plugin currently publishes:

- recursive visible node tree
- bounds
- node name
- node type
- text content for text nodes
- selected style metadata
- a rendered PNG reference image for the selected root

Important style data currently includes:

- typography
  - `fontSize`
  - `fontWeight`
  - `lineHeight`
  - `letterSpacing`
- selected spacing and color data

The plugin skips noisy vector internals so icons are represented at the wrapper level rather than path-by-path.

## 6.2 Browser-side capture and extraction

When a user picks an area:

- the selected DOM container becomes the validation root
- the extension captures the visible browser tab
- the screenshot is cropped to the selected container bounds
- the extension also gathers DOM candidate nodes from inside the container

Important:

- capture is currently based on the visible tab
- the selected region should be meaningfully visible in the viewport

## 6.3 Suggested mapping engine

The current matcher is geometry-first and confidence-aware.

Its goal is not to rebuild the DOM exactly. Its goal is to find the most plausible visual equivalent for each Figma node and reject weak matches.

The broad steps are:

1. collect visible DOM candidates
2. normalize obvious wrapper noise
3. project Figma child geometry into browser space using root scaling
4. filter implausible candidates
5. score eligible candidates using geometry and lightweight semantic hints
6. assign siblings as a group
7. produce confidence-aware matches

Important behaviors:

- one bad guess should not cascade across siblings
- low-confidence mapping should prefer `unmatched` over a fake match
- raw mapping diagnostics are still available in Dev

## 6.4 Raw validation layer

Once mapping is decided, the validator computes raw diagnostics such as:

- width/height comparisons
- text comparison
- style comparison
- mapping status
- candidate ambiguity metadata

This is the factual base that the later issue layers build on.

## 6.5 Tree-aware QA issue layer

Above raw validation, the extension derives higher-level issues from mapped spatial facts.

Examples:

- sibling gap mismatch
- inset mismatch
- alignment offset
- size mismatch
- mapped text mismatch
- mapped typography mismatch

This is the first place where the tool stops talking in terms of raw node diffs and starts talking in terms of user-visible issues.

## 6.6 Visual QA image-comparison layer

Visual QA adds a second detection path that is not dependent on tree equality.

At a high level it:

1. compares the Figma render and browser capture in normalized image space
2. identifies visually changed regions
3. clusters those regions into issue candidates
4. tries to enrich them with mapped QA issues when reliable overlap exists

This is why Visual QA can still surface visible issues even when DOM/Figma structure diverges.

## 6.7 Precision-fix guidance layer

This is the newest layer.

It turns trustworthy issue detections into explicit “change X to Y” guidance.

It currently works best for:

- gap issues
- inset issues
- alignment issues
- size issues
- explicit typography property mismatches

The tool now adds `recommendedFix` metadata only when confidence is high enough.

That metadata can include:

- confidence level
- exact instruction
- likely CSS property
- expected value
- actual value
- likely element label
- explanation of why the fix is likely

## 7. What The Tool Can Do Well Right Now

The current system is already strong at:

- finding visible layout drift quickly
- explaining issues in more human language than raw box comparison
- flagging exact alignment problems such as icon/content misalignment
- identifying exact gap differences when mapping is reliable
- identifying explicit text mismatches
- identifying explicit typography diffs such as letter spacing
- giving developers a short path from visible symptom to likely fix

This is enough to make the tool genuinely useful for internal design QA today.

## 8. What Still Depends On Tree Quality

Even with Visual QA in front, some of the strongest explanations still depend on the quality of tree-aware enrichment.

This matters most for:

- exact expected-vs-actual positioning
- precise gap recommendations
- exact inset recommendations
- property-level fix suggestions

If tree mapping is weak, Visual QA can still say:

- something looks wrong
- here is the changed area

But it may not be able to say:

- set this gap to 8px
- change this alignment mode
- set letter spacing from 0.2px to 0px

## 9. Current Limitations

These are the important limitations as of the current build.

## 9.1 Not fully tree-independent

Visual detection exists, but the best explanations still benefit from reliable mapped overlap.

## 9.2 Best exact fixes are limited to high-confidence issue classes

Exact fix guidance is intentionally conservative. It is currently best for:

- alignment
- spacing/gap
- inset
- size
- explicit typography property mismatches

Generic visual differences still fall back to broader guidance.

## 9.3 Visual capture depends on viewport state

The browser capture is based on the visible tab.

That means:

- the region should be visible
- lazy-loaded content or missing fonts can affect the result
- wrong responsive breakpoint can produce misleading results

## 9.4 Style understanding is still selective

The tool does not yet produce equally strong exact-fix guidance for every visual style difference.

The most reliable current property-level guidance is for:

- letter spacing
- font size
- font weight
- line height

Broader style issues such as shadows, fills, or radius can still be detected visually, but not always converted into exact property changes.

## 9.5 Repeated structures are still harder

Repeated cards, chips, and list items can still create ambiguity when visual regions are similar and structure diverges.

The matcher is better than before, but repeated layouts are still a known hard case.

## 10. Launch Recommendations

For internal launch, the cleanest product story is:

- `Pick Area`
- review `Visual QA`
- use `Dev` to fix

Do not lead with:

- raw tree matching
- CSS-only comparison
- every internal diagnostic view

Do lead with:

- visible issue detection
- exact fix guidance when confidence is high
- developer handoff when confidence is lower

## 11. Best Next Big Improvements

The next work is best handled as phased improvements rather than one large unfocused milestone.

Chosen order:

- Phase 1: exact fixes, better labels, better expected-vs-actual
- Phase 2: repeated-component disambiguation
- Phase 3: reporting / export

This keeps the immediate work centered on the product's most important promise:

- detect the visible problem
- explain it clearly
- tell the developer exactly what to change when confidence is high

### 11.1 Phase 1: Exact Fix Quality

This is the highest-leverage next milestone.

#### More exact fixes from existing issue facts

Expand the current precision-fix layer so more mapped issues become explicit `change X to Y` guidance.

Target improvements:

- alignment
  - convert offsets into concrete actions such as `make icon top-aligned`
- spacing / gap
  - promote exact relation values into `gap should be 8px; browser is 12px`
- inset
  - convert parent-child offset into exact inset guidance
- size
  - keep exact width/height fixes only when they remain visually meaningful
- typography
  - strengthen exact property/value guidance for:
    - `letter-spacing`
    - `font-size`
    - `font-weight`
    - `line-height`

Rules:

- emit exact fixes only when the issue is mapped and numeric evidence is strong
- keep broader `Check` guidance for weak or fallback-only cases
- continue hiding width-equivalent visual notes from QA

#### Better label quality

Issue wording still depends on region-label extraction.

The next improvement is to make labels shorter, cleaner, and more trustworthy.

Updated target priority:

1. short visible DOM text from the matched anchor only
2. short Figma descendant text
3. accessible label / aria label / button label
4. semantic region label such as:
   - `left icon`
   - `content block`
   - `title text`
   - `button`
   - `tag chip`

Expected outcome:

- `Icon sits 13px lower than content`
- `Gap between icon and content should be 8px`
- `Letter spacing for title should be 0px`

#### Better expected-vs-actual derivation

Current limitation:

- expected bounds are often derived by shifting only the primary box by the measured delta

That works for simple cases, but it becomes weaker in harder spacing and alignment cases.

The next step is to derive expected placement from the relation itself:

- sibling alignment:
  - derive expected position from the aligned reference edge
- sibling gap:
  - derive expected placement from the measured relation between both anchors
- inset:
  - derive expected placement from parent-child geometry
- size:
  - keep current direct size derivation

Add highlight confidence states:

- `exact`
- `good`
- `fallback`

Use them to decide whether to show:

- `Expected / Actual`
- or `Changed area`

#### Phase 1 interface additions

No matcher API or plugin payload break is required.

Recommended derived additions:

- `issue.labelQuality`
  - `high | medium | fallback`
- `issue.highlightConfidence`
  - `exact | good | fallback`
- richer `recommendedFix`
  - keep the current shape
  - expand exact-fix coverage by issue type

#### Phase 1 test plan

- Alignment
  - icon/content mismatch produces:
    - clean labels
    - `Expected / Actual / Delta`
    - exact fix such as `make icon top-aligned`
- Gap
  - expected 8px, browser 12px produces:
    - exact gap statement
    - stable labels
    - no vague drift wording
- Inset
  - child inset issue produces:
    - exact inset guidance
    - expected/actual placement when trustworthy
- Typography
  - letter spacing 0 vs 0.2 produces:
    - exact property/value fix
    - no fallback-style vague language
- Fallback
  - weak visual-only issue still uses `Changed area` and broader guidance
- Label quality
  - no long concatenated subtree labels in common card scenarios

### 11.2 Phase 2: Repeated-Component Disambiguation

This phase focuses on visually similar repeated structures such as:

- cards
- chips
- list items
- repeated stacks

The matcher should gain repeated-structure-aware signals:

- sibling order preservation
- local neighborhood consistency
- repeated-subtree shape comparison
- stronger parent-child grouping bias inside repeated lists
- stronger ambiguity downgrade rules when multiple siblings are nearly equivalent

Goal:

- fewer noisy matches in repeated layouts
- more trustworthy exact fixes in list-heavy UIs
- fewer false positives caused by near-identical siblings

#### Phase 2 interface additions

Extend matcher-side derived confidence metadata only:

- repeated-structure ambiguity signals
- stronger per-assignment confidence interpretation

No public API change is required.

#### Phase 2 test plan

- Repeated cards
  - same-looking siblings do not create misleading exact fixes
- Repeated chips
  - matcher prefers correct sibling neighborhood
- Confidence downgrade
  - ambiguous repeated matches lower fix confidence instead of overclaiming

### 11.3 Phase 3: Reporting / Export

Reporting is intentionally deferred until the issue model and confidence model are more stable.

When the issue model is stable enough, add shareable outputs such as:

- JSON export for tooling and automation
- Markdown or HTML summaries for QA / developer sharing

Recommended report contents:

- selected root metadata
- timestamp
- current strategy
- visible issue list
- issue summary
- issue kind
- severity
- exact fix if available
- numeric values when relevant
- confidence / explanation mode
- optional visual references if feasible

This should remain a later workflow enhancement, not the main product surface.

#### Phase 3 interface additions

Add an export model such as:

- `validationReport`
  - root metadata
  - issue list
  - confidence fields
  - fix guidance
  - optional visual references

#### Phase 3 test plan

- Export
  - report includes visible issues, fix guidance, and confidence fields
- Shareability
  - QA and developers can understand the issue list without reopening the live panel
- Stability
  - exported issue objects match what the panel shows

## 12. Recommended Reading Order

If you are new to the tool:

1. Read this document.
2. Use the tool on one real issue in `Visual QA`.
3. Follow it into `Dev`.

If you are implementing from Figma with an agentic workflow:

1. Read this document first.
2. Then use the plugin prompt flow and validate the result in the extension.
