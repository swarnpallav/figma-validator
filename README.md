# Figma Validator

A developer tool to validate implemented UI against Figma designs in real time.

Figma Validator consists of:

- A Figma Plugin to capture geometry from selected Figma nodes
- A Chrome Extension to compare that geometry with live webpage elements

It helps reduce manual inspection time and surfaces subtle implementation drift that is hard to catch visually.

---

## 🚀 Live

- 🧩 Figma Plugin: Approved & Published
- 🌐 Chrome Extension: Published (Unlisted)

Chrome Extension Link:
https://chromewebstore.google.com/detail/figma-validator/abckkojoejplbhaodfpebcaofokmmpjh?authuser=0&hl=en

Figma Plugin Link:
https://www.figma.com/community/plugin/1604167807144854725

---

## 🚀 How it works

1. Select an element in Figma using the plugin
2. Open your website
3. Press Shift + Click on any element
4. Instantly see a comparison panel showing:

- Layout geometry validation for the selected container and its visible descendants
- Width/height differences with configurable comparison filters
- Explicit `match`, `mismatch`, and `unmatched` mapping states

---

## 🧠 Mapping Logic

The current implementation is geometry-first and container-first.

1. The Figma plugin exports a recursive snapshot of the selected node using `absoluteBoundingBox`.
2. The Chrome extension reads visible DOM rectangles using `getBoundingClientRect()`.
3. For each Figma node, the validator projects its bounds into the browser container coordinate space.
4. DOM candidates are filtered before scoring.
   - Candidates must be visually plausible, not just the “least bad” option.
   - Inner SVG nodes are ignored so icons are validated at the wrapper level.
5. Only eligible DOM candidates are scored.
   - If no candidate is close enough, the node is marked `unmatched`.
   - This is intentional: the tool prefers precision over forced mappings.
6. Once a DOM node is used for a Figma node, it is removed from the unmatched pool for sibling matching.

This means the validator is optimized for minor design drift, not for reconstructing the entire DOM tree from Figma.

---

## 🔍 Match States

- `match`: The node mapped successfully and the selected dimensions are within tolerance.
- `mismatch`: The node mapped successfully, but one or more selected dimensions differ beyond tolerance.
- `unmatched`: No DOM candidate passed the mapping eligibility gate, so the validator intentionally avoids forcing a bad mapping.

`unmatched` is usually better than a misleading mismatch, because this tool is meant to identify subtle implementation errors, not invent correspondences for structurally different nodes.

---

## ✨ Features

- Recursive geometry snapshot extraction from Figma
- Eligibility-gated DOM mapping for minor-diff validation
- Visual mismatch highlighting and numbered markers
- Side-panel hierarchy with per-node comparison details
- Works on any website
- Local-only processing (no data collection)

---

## 🧰 Tech Stack

- Chrome Extension (Manifest V3)
- Figma Plugin API
- JavaScript
- DOM APIs
- chrome.storage
- window.postMessage bridge


---

## 🎯 Problem it solves

Frontend developers often miss tiny width, height, spacing, or wrapper-level regressions that “look fine” at a glance.

Figma Validator helps by:

- mapping visible Figma nodes to plausible DOM equivalents
- comparing geometry instead of relying on CSS implementation details
- highlighting only meaningful differences that are likely to reflect implementation drift

---

## 🔒 Privacy

- No data collection
- No tracking
- No external API calls
- All processing happens locally

---

## Versions

- v1.0.0 – Initial release

More features coming soon.
