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

### 7. Send changed candidates to CoMER

The scheduler waits for `flushPendingGroups()` before rasterizing candidates.
`LinesRasterizer` computes each candidate signature from its stroke IDs and
tight box. `LatexPredictor` caches recognition by server URL, image signature,
and model list.

Therefore:

1. A newly written line is sent through DBNet and then CoMER.
2. Writing that overlaps its catchment zone produces a new merged base key, so
   DBNet rereads the complete merged crop.
3. DBNet's resulting new or altered lines have new signatures and are sent to
   CoMER.
4. A line whose strokes and box are unchanged reuses its existing CoMER result.

For example, after `\frac{x-1}{x+1}=6` is recognized, adding
`x-1=6(x+1)` underneath may merge both temporal batches into one base box.
DBNet receives that complete box again. The fraction remains structurally
protected, the lower equation becomes another line candidate, and CoMER runs
for the newly created or altered signatures.

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
