# Character Sheet 2.0 — adaptive homebrew foundation

This PR adds an **opt-in** browser-local workspace underneath the existing character sheet.

## Included
- Any number of user-defined sections, stats, values and freeform rules.
- Drag-to-reorder sections in layout mode; responsive editing on mobile.
- Local draft persistence, JSON import/export, and an explicit local approval status.
- Strict versioned import validation, duplicate-ID rejection and size limits.
- No character replacement or forced D&D balancing.

## Important limits / next PRs
- This workspace is deliberately separate from the active campaign snapshot and legacy character model. It is **not** synchronized or authoritative for the 5e rules engine yet.
- Approval here is local draft approval, not multiplayer host/DM permission approval.
- AI-assisted proposal generation and manual acceptance / edit / override flow are not yet implemented.
- Resizable/free-position/overlapping cards, multi-layout profiles, per-character isolation, Codex library integration and campaign migration still need implementation.
- The browser keeps the draft under `lantern.adaptive-sheet.v1`. Export before clearing site data; drafts are not in standard campaign exports.
- We should introduce a character-scoped data model and host-reviewed activation pathway before connecting this workspace to multiplayer or rules execution.

## Manual smoke checks
1. Open Character and expand Character Sheet 2.0; existing 5e editor must still work.
2. Add sections and fields, edit multiline mechanics, refresh; draft must survive.
3. Enable Reorder sections and drag one onto another.
4. Export JSON, change a field, import the export; data should restore as a draft.
5. Reject a malformed JSON import without losing current data.
6. Approve locally, edit a field; status must return to draft.
7. Use narrow mobile viewport; controls must stay accessible.
