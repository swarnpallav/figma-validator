# Figma Validator

Figma Validator is a **design QA assistant for Figma-to-frontend implementation**.

It helps teams:

- find visible design drift quickly
- understand what looks wrong
- give developers a likely fix path

The shipped product story is:

- `Pick Area`
- review `Visual QA`
- switch to `Dev` when implementation detail is needed

## Requirements

Figma Validator has two parts:

- Figma plugin
- Chrome extension

Both are required.

## Current Workflow

1. Open the design in Figma.
2. Run the Figma Validator plugin.
3. Select the root frame, card, or section to validate.
4. Open the implemented page in the browser.
5. Click `Pick Area`.
6. Hover and click the matching browser container.
7. Start in `Visual QA`.
8. Open `Dev` only if you need deeper technical guidance.

## What The Product Does Today

### Visual QA

The default user-facing experience.

It focuses on:

- visible spacing issues
- alignment issues
- size issues
- text mismatches
- selected style and typography mismatches

When confidence is high enough, it can also surface exact fix guidance such as:

- make the icon top-aligned
- set the gap to 8px instead of 12px
- set letter spacing to 0px instead of 0.2px

### Dev

The technical follow-up experience.

It focuses on:

- fix handoff
- mapped node diagnostics
- raw tree-aware debugging
- unmatched node inspection
- candidate review
- style and text diagnostics

## What It Is Not

It is not best pitched as:

- a CSS checker
- a pure DOM-vs-Figma tree comparer
- a guaranteed pixel-perfect auto-fixer

It is best pitched as:

- a design QA assistant that shows visible drift first and helps developers fix it

## Docs

- [Complete reference](docs/complete-reference.md)

## Live

- Chrome Extension:
  https://chromewebstore.google.com/detail/figma-validator/abckkojoejplbhaodfpebcaofokmmpjh?authuser=0&hl=en
- Figma Plugin:
  https://www.figma.com/community/plugin/1604167807144854725

## Tech Stack

- Chrome Extension (Manifest V3)
- Figma Plugin API
- JavaScript / TypeScript
- DOM APIs
- canvas-based visual comparison
- chrome.storage

## License

MIT
