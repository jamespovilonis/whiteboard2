# Canvas segmentation

The whiteboard supports two line-grouping implementations:

- `IdentifyLine.js`: the original geometric loose/strict candidate generator.
- `IdentifyLineDBNet.js`: pause-based grouping followed by PaddleOCR DBNet
  detection. This is selected by `lineDetection.mode: "dbnet"` in
  `config.json`.

`DBNet_Integration.py` owns the PaddleOCR detector. The unified FastAPI server
imports it and exposes `POST /segment-lines` plus `GET /segment-lines/health`.

## DBNet segmentation lifecycle

### 1. Save vector strokes

`StrokeDataSaver` records every completed stroke with a stable ID, start/end
times, raw points, rendered outline, and canvas-coordinate bounding box. Stroke
IDs are immutable; adding or replacing ink therefore changes the affected
line's content signature.

### 2. Form pause-based batches

After each pen, erase, undo, or redo event, `RealtimeRecognitionScheduler`
starts (or resets) its idle timer. The default delay is 1,000 ms.

Consecutive strokes completed without a pause longer than that delay form one
temporal batch. This captures multi-stroke symbols and expressions before
attempting spatial grouping.

### 3. Merge intersecting catchment zones

Each temporal batch has:

- a **tight box** around its actual ink;
- an **expanded catchment box** with 50 px horizontal padding; and
- adaptive vertical padding: at least 10 px, one-half of the ink height, and no
  more than 40 px.

Two batches merge when either tight box intersects the other's catchment box.
After a merge, the box is recomputed and intersection checks repeat until the
set is stable. This makes merging transitive.

The resulting stroke collection is a **base candidate**. Its DBNet cache key is
the sorted stroke-ID set plus the tight bounding box. Consequently, adding,
removing, or altering ink in a candidate creates a new key and forces DBNet to
process a newly rasterized image of the entire merged box.

### 4. Rasterize and run DBNet

`flushPendingGroups()` rasterizes every uncached base candidate as black ink on
white and posts the padded PNG to `/segment-lines`. The Python adapter runs the
local PaddleOCR `TextDetection` model and returns detection polygons, bounding
boxes, and scores in crop coordinates. The browser translates them back to
canvas coordinates.

Requests carry a document version and stroke signature. A result is applied
only if the document is still the version that produced the request. Stale
responses cannot overwrite newer writing.

### 5. Convert detections into math lines

Overlapping DBNet regions are clustered into horizontal bands. Each vector
stroke is assigned to exactly one band using vertical intersection first and
center distance as a tie-breaker.

When DBNet joins tightly spaced rows, the browser also clusters vector strokes
by vertical center and extent. If this produces more credible, full-width rows
than DBNet, the vector rows refine the DBNet result. This is particularly
important for aligned elimination work such as `+5 +5`, `/3 /3`, and a final
answer written directly beneath the preceding equation.

Before a refined set of bands becomes separate math lines, the splitter folds
local 2-D structure back into its parent expression. A vertically offset band is
treated as an attachment, not a line, when it is compact or sparse, close to the
neighboring expression row, and horizontally supported by nearby ink. This
covers repeated superscripts such as `x^3 + x^2`, subscripts, and
summation/integral-style limits. Thin horizontal decoration rows directly under
an operation row are also attached to that operation row, so underlined
intermediate work like `+1  +1` remains one work row instead of becoming a
separate line.

The refinement deliberately remains geometric rather than symbol-name based.
Full-width or baseline-sized rows still split as algebra work even when they
are close together, while small local rows stay with the expression they modify.

For a genuine multi-line candidate, the application retains both:

- the complete unsplit base candidate; and
- the separate DBNet line candidates.

These alternatives may share strokes. The downstream global-cover selection
chooses a non-overlapping interpretation using CoMER scores and structural
LaTeX evidence.

An unsplit multi-row parent receives an explicit selection penalty when its
DBNet-line children form a complete cover. CoMER is trained for one expression,
so its score for a tall multi-row crop is not directly comparable with the
combined evidence from individual line crops. Fraction-protected candidates do
not create line children and therefore do not receive this penalty.

Candidate identity depends on its stroke set, not its current vertical index.
Thus, when another equation is added nearby, an unchanged original line keeps
the same identity and image signature, while a new or altered line receives a
new signature.

### 6. Protect fractions

A fraction is vertically arranged but is one mathematical line. Before
accepting a DBNet split, the browser looks for a long horizontal stroke with
ink and DBNet bands both above and below it. This is treated as a fraction
bridge, and the complete candidate is preserved rather than separating the
numerator and denominator.

The fraction bridge check is conservative around in-between algebra. A bar must
be a dominant horizontal structure for the candidate, and the nearest ink above
and below it must be locally balanced. Local underlines beneath operation rows
therefore attach to that operation row instead of causing the whole surrounding
stack to be protected as a fraction.

### 7. Send changed candidates to CoMER

The scheduler waits for `flushPendingGroups()` before rasterizing candidates.
`LinesRasterizer` computes each candidate signature from its stroke IDs and
tight box. `LatexPredictor` caches recognition by server URL, image signature,
and model list.

Therefore:

1. A newly written line is sent through DBNet and then CoMER.
2. When DBNet cleanly splits a compound base candidate, the child DBNet lines
   are stored as segmentation-memory anchors. The unsplit `dbnet-parent` crop
   remains available as a recognition fallback, but its large box is not used
   to catch future writing while child anchors are valid.
3. New writing first merges against those child anchors. If it touches one
   child, only that local row receives a new base key; unchanged siblings keep
   their signatures. If it bridges multiple child anchors, only those nearby
   anchors are merged and sent back through DBNet as a local compound.
4. DBNet's resulting new or altered lines have new signatures and are sent to
   CoMER.
5. A line whose strokes and box are unchanged reuses its existing CoMER result.

For example, after `\frac{x-1}{x+1}=6` is recognized, adding
`x-1=6(x+1)` underneath may initially merge both temporal batches into one base
box. DBNet receives that complete box, the fraction remains structurally
protected, and the lower equation becomes another line candidate. Once those
children are anchored, future edits near the lower equation use that smaller
child catchment instead of the original parent box.

## Current findings

- Multiple superscripts in one expression can appear to DBNet as an upper text
  row. The structure-aware band merge keeps those sparse, locally supported
  bands with the baseline expression.
- Summation, integral, and similar operator limits follow the same rule:
  compact upper/lower bands near the operator attach to the expression rather
  than becoming independent work rows.
- Underlined intermediate operations are treated as real algebra work rows. The
  underline strokes attach to the operation row, and the fraction bridge
  heuristic rejects them when they are unbalanced local decoration rather than a
  numerator/denominator separator.
- Dense multi-line algebra still relies on full-width/baseline-sized row
  evidence, so the script and underline protections do not suppress ordinary
  `line -> operation -> next line` splitting.

The remaining hard cases are inherently ambiguous geometry: a very wide,
multi-stroke superscript row may look like a real algebra row, and a very dense
local underline stack may look fraction-like. In those cases the splitter keeps
the parent fallback candidate so CoMER/global cover selection can recover.

### 8. Failure behavior

If DBNet is unavailable, times out, or returns no regions, the unsplit base
candidate is retained so ink is never discarded. CoMER errors are displayed
with their HTTP/model detail instead of only `(failed)`.

## Configuration

The `lineDetection` section of `config.json` controls:

- `mode`: `"dbnet"` or `"geometric"`;
- `idleDelayMs`;
- `horizontalPadding`;
- `verticalPadding` (the adaptive-padding floor);
- `requestTimeoutMs`; and
- `minVerticalOverlapRatio` used to cluster DBNet detections.

Press `B` on the whiteboard to display tight boxes in green and catchment boxes
in blue.
