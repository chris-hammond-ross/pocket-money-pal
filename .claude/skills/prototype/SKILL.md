---
name: prototype
description: Build three different throwaway HTML/JS prototypes for a Pocket Money Pal feature in the gitignored prototypes/ folder, following the workflow in CLAUDE.md. Use when the user says "/prototype <feature>" or asks to prototype a feature.
---

Prototype the feature the user described: $ARGUMENTS

Follow the "Prototyping workflow" section of CLAUDE.md exactly:

1. Look in `prototypes/` for the highest `NNN-` number and use the next one. Name the folder `NNN-<kebab-feature-name>`.
2. Read `prototypes/_shared/mock-data.js` and use it (via `<script src="../../_shared/mock-data.js">`). Extend it if the feature needs more data.
3. Before building, pick three **genuinely different** concepts: different interaction models, layouts or metaphors. State them in one line each.
4. Build `a/index.html`, `b/index.html` and `c/index.html`: plain HTML/CSS/JS, no build step, CDN libs allowed. Each starts with a banner describing the idea and what to evaluate. Make them feel real: animations, sounds (WebAudio beeps are fine) and realistic data. The kiosk is a wide second monitor viewed from across a room; the parent views are phone-sized.
5. Build `NNN-<name>/index.html` linking the three with their one-line pitches.
6. Finish by telling the user the path to open and a short comparison of the three, plus the questions each one is meant to answer.

Do not touch the real app (`apps/`, `packages/`) during a prototype round.
