# Figma Validator

A developer tool to validate implemented UI against Figma designs in real time.

Figma Validator consists of:

- A Figma Plugin to capture style properties from selected design elements
- A Chrome Extension to compare those styles with live webpage elements

It helps reduce manual inspection time and ensures pixel-accurate implementation.

---

## 🏆 Status

✔ Figma Plugin – Approved & Published  
⏳ Chrome Extension – Under Review

---

## 🚀 How it works

1. Select an element in Figma using the plugin
2. Open your website
3. Press Shift + Click on any element
4. Instantly see a comparison panel showing:

- Spacing differences
- Typography mismatches
- Color mismatches
- Border radius differences

---

## ✨ Features

- Real-time style comparison
- Visual mismatch highlighting
- Table-based comparison UI
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

Frontend developers often manually inspect:

- padding/margin
- font size/weight
- colors
- border radius

This is repetitive and time-consuming.

Figma Validator automates this comparison in seconds.

---

## 🔒 Privacy

- No data collection
- No tracking
- No external API calls
- All processing happens locally

---

## 📌 Status

v1 — Initial release

More features coming soon.
