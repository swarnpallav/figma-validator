# 🚀 Figma Validator

Validate implemented UI against Figma designs in real time — and understand exactly where and why it differs.

Figma Validator is a developer tool that connects your Figma design with a live webpage to detect layout inconsistencies instantly.

---

## ⚠️ Requirements

Figma Validator consists of **two parts that work together**:

- 🧩 Figma Plugin — captures geometry from selected Figma nodes  
- 🌐 Chrome Extension — compares that geometry with live webpage elements  

👉 Both are required for validation.

---

## 🚀 Live

- 🧩 Figma Plugin: Approved & Published  
- 🌐 Chrome Extension: Published (Unlisted)

Chrome Extension:  
https://chromewebstore.google.com/detail/figma-validator/abckkojoejplbhaodfpebcaofokmmpjh?authuser=0&hl=en  

Figma Plugin:  
https://www.figma.com/community/plugin/1604167807144854725  

---

## ⚡ Quick Start

1. Open your design in Figma  
2. Run the Figma Validator plugin  
3. Select any element (frame/text/layer)  
4. Open your website  
5. Press **Shift + Click** on the corresponding element  

👉 Instantly see validation results

---

## ✨ Features

### 📏 Geometry-based validation
- Width & height comparison using real rendered dimensions  
- Detect subtle layout drift not visible to the eye  

### 🔍 Smart DOM mapping
- Matches Figma nodes to **eligible DOM elements only**  
- Avoids incorrect mappings (precision-first approach)  

### 🎯 Clear validation states
- `match` → correct implementation  
- `mismatch` → measurable difference  
- `unmatched` → no reliable DOM mapping found  

### 🧩 Recursive validation
- Validates container and visible descendants  
- Preserves hierarchy for better debugging  

### 📊 Visual debugging panel
- Side panel with per-node comparison  
- Highlighted overlays with numbered markers  
- Expandable details for deeper inspection  

### 🔒 Privacy-first
- No data collection  
- No tracking  
- No external API calls  
- Fully local execution  

---

## 🧠 How it works

Figma Validator uses a **geometry-first, precision-focused approach**:

1. The Figma plugin exports a recursive snapshot using `absoluteBoundingBox`  
2. The extension reads DOM geometry via `getBoundingClientRect()`  
3. Figma nodes are projected into browser coordinate space  
4. DOM candidates are filtered based on visual plausibility  
5. Only eligible candidates are scored (no forced matches)  
6. Used DOM nodes are removed to prevent duplicate mapping  

👉 The system is optimized for **detecting implementation drift**, not reconstructing DOM structure.

---

## 🔍 Match States Explained

- **match**  
  Node mapped successfully and dimensions are within tolerance  

- **mismatch**  
  Node mapped successfully but dimensions differ  

- **unmatched**  
  No DOM element passed the eligibility check  

👉 `unmatched` is intentional — it avoids misleading comparisons.

---

## 🎯 Problem it solves

Frontend developers often miss:

- small spacing issues  
- incorrect container sizes  
- layout drift that “looks fine”  

Figma Validator helps by:

- comparing **actual rendered geometry**  
- avoiding unreliable CSS-based assumptions  
- highlighting only meaningful inconsistencies  

---

## 🧰 Tech Stack

- Chrome Extension (Manifest V3)  
- Figma Plugin API  
- JavaScript  
- DOM APIs  
- chrome.storage  
- window.postMessage bridge  

---

## 📦 Versions

- **v1.0.0** — Initial release  
- **v1.1.0** — Geometry-based validation  

👉 More advanced validation and insights coming soon.

---

## 🛣️ Roadmap

- [ ] Hybrid validation (geometry + CSS insights)  
- [ ] Likely issue detection  
- [ ] Actionable suggestions  
- [ ] Context-aware debugging (flex, overflow, etc.)  

---

## 🤝 Contributing

Feel free to open issues or suggest improvements.

---

## 📄 License

MIT