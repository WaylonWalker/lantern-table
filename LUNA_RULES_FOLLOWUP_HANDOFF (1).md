# Lantern Table — Luna Follow-up: Stabilize Rules Authority + Finish Character Memory UX

## Working directory

`/home/waylon/git/lantern-table/lantern-table-next`

This follows the first SRD 5.1 rules-engine pass. Inspect the actual current tree before editing; the prior session contains intermediate versions and the tree already had unrelated changes.

Start with:

```bash
cd /home/waylon/git/lantern-table/lantern-table-next
git status --short
git diff --stat
git diff --check
just validate
just smoke-webrtc
```

Preserve unrelated work. Do not reset/clean the tree.

The previous pass ended with `just validate` and 11 deterministic rules tests green, but `just smoke-webrtc` red because signaling connected and the initial DataChannel never opened. No production deploy was performed.

## Assessment of previous work

Overall grade: **B / about 7.5 out of 10 for a first implementation slice; not release-ready.**

Strong work:
- deterministic `assets/rules5e.mjs` rules core;
- host-authoritative typed combat intents and turn IDs;
- initiative, per-creature surprise, checks, attacks, source-aware saves, death saves, timeout events, and rule provenance;
- AI HP-patch authority substantially removed;
- persistent entity IDs and Characters/People directory;
- player-safe entity snapshot work;
- portrait upload/prompt support;
- useful injected-dice unit tests that actually caught rules bugs.

The remaining risk is concentrated at integration boundaries, not the basic idea.

---

# P0 — Do these before adding more rules breadth

## 1. Make `just smoke-webrtc` green

Do not increase the timeout to hide the failure.

The previous failure showed:
- signaling connected;
- room joined;
- host had no remote peer;
- no ICE candidate types;
- DataChannel never opened;
- no ping/pong.

Determine whether the cause is app runtime/module loading, signaling/hello routing, offer generation, offer/answer targeting, ICE handling, or the smoke harness being stale.

Acceptance:

```bash
git diff --check
just validate
just smoke-webrtc
```

all pass.

Also prove one `player_intent` survives reconnect and reaches the host exactly once.

## 2. Audit per-creature reaction lifecycle

Reaction availability belongs to each combatant and resets at the **start of that creature's next turn**.

Add this regression test:

```text
A acts
B acts
A uses reaction during B's turn
C acts
A still has no reaction
A's next turn begins
A reaction is available again
```

Off-turn reactions must remain legal when a real trigger exists.

## 3. Do not auto-skip plain Incapacitated

Audit helpers such as `turnRequiresNoChoice`.

Incapacitated removes actions and reactions, but by itself does **not** remove movement.

Do not treat:

```js
incapacitated(character)
```

as sufficient reason to auto-end the whole turn.

Test:
- Incapacitated can still move if speed is nonzero.
- Unconscious/Stunned/Paralyzed obey their additional movement restrictions.

## 4. Audit surprise fast-forwarding

A surprised creature still has a first turn.

Fast-forward is okay only after:
- mandatory start-of-turn events run;
- turn start/end events remain coherent;
- the supported system offers no legal choice;
- surprise ends at the right moment;
- reaction becomes available after that first turn ends.

Never model a surprise round.

## 5. Separate absent-player permissions

Enforce independently:

- `partyControlAbsent`: another player may act for an offline owner.
- `dmControlAbsent`: host/DM may act for an offline owner.

Do not treat either flag as implying the other.

Delegation requires the owner to actually be absent/offline and still passes through the normal validator.

Test all four permission combinations.

## 6. Fix initial mechanics lifecycle

Do not use only `campaign.started` as the lock boundary.

Use explicit per-character mechanical lifecycle, e.g.:

```js
mechanicsState: "uninitialized" | "initialized" | "locked"
```

Initial mechanics must remain possible during opening setup even if the wizard has already marked the campaign started.

After authoritative play begins, mechanical changes require:
- rules events, or
- explicit host correction events.

## 7. Search for remaining mechanical bypasses

Audit:
- `Math.random` used for authoritative dice;
- direct HP mutation;
- direct AC/resource/condition mutation;
- old `performRoll`;
- old ability roll helpers;
- `hp_delta`;
- mechanical character form edits.

All authoritative mechanics should come through initialization, the deterministic resolver, or a clearly logged host correction.

---

# P1 — Finish reactions and Ready

## Opportunity attacks

Detection alone is not complete.

Implement:

```text
validated movement
-> OA trigger detection
-> stable reaction prompt ID
-> Accept / Decline
-> timeout = Decline
-> Accept consumes reaction
-> normal melee attack resolver
-> resolve before mover leaves reach
```

No automatic OA.

Do not prompt on:
- Disengage;
- teleport;
- forced movement that does not use movement/action/reaction;
- attacker unable to see;
- incapacitated attacker;
- unavailable reaction.

## Ready

The combat UI must not offer a nonfunctional Ready button.

Collect:
- perceivable trigger;
- response action OR movement.

Implement:
- stored trigger identity;
- expiry before the creature's next turn;
- optional reaction prompt;
- Accept / Decline;
- timeout decline;
- reaction consumption;
- normal action resolver for supported readied actions;
- movement up to speed.

Until spell support exists, clearly reject readied spells.

---

# P1 — Make standard actions meaningful

The visible picker currently includes Help, Hide, Search, and Use an Object.

Do not call an action implemented merely because it consumes the action and emits an event.

Either implement it or route it through explicit DM adjudication.

### Help
Create a real state-backed advantage effect for the assisted check/attack and expire it correctly.

### Hide
Use DM adjudication for whether hiding is possible, then resolve Stealth through the normal check engine.

### Search
Resolve an appropriate check only when uncertainty matters.

### Use an Object
Use encoded object rules when known; otherwise use a table-ruling path.

If an action is not usable yet, label or disable it instead of presenting a false deterministic implementation.

---

# P1 — Connect source-driven saving throws to effects

`resolveSavingThrow` is useful, but source effects need a real contract.

Start small:

```js
{
  effectId,
  sourceEntityId,
  sourceRule,
  sourceFeature,
  targets,
  save: { ability, dc },
  onSuccess,
  onFailure
}
```

The model can propose that an established trap/feature activates.

Code owns:
- ability;
- source DC;
- proficiency;
- advantage/disadvantage;
- automatic failures;
- state mutations.

Add one or two fully encoded fixtures before broadening.

---

# P1 — Finish persistent-character UX

The Characters directory is a good start. The original request also required rich entity references everywhere.

## Structured entity mentions

Do not regex names.

Use a stable representation such as:

```md
[[entity:npc_abc123|Branna]]
```

or an equivalent structured message annotation.

Support known entity links in:
- DM transcript;
- timeline;
- quests;
- journal;
- combat tracker;
- location occupants when applicable.

Unknown references degrade to plain text.

## Rich hover / focus / mobile tap

Desktop:
- hover;
- keyboard focus.

Mobile:
- tap opens compact sheet/popover.

Preview:
- portrait;
- name;
- short description;
- personality;
- relationship;
- first met;
- last seen;
- known/last-known location.

A More/View Character action opens the full Characters detail screen.

## Give the DM compact entity context

Audit `/api/dm/stream`.

The model should receive stable IDs for relevant existing entities:
- party;
- current scene;
- current quests;
- recent mentions;
- likely duplicate candidates.

Do not send hundreds of full biographies each turn.

## Complete entity lifecycle tools

Ensure host-validated support for:
- `create_entity`;
- `update_entity_profile`;
- `record_entity_encounter`;
- `move_entity`;
- `set_entity_relationship`;
- `set_entity_known_location`.

Creation alone is not enough for recurring NPC continuity.

## Prevent hidden-data leakage structurally

Do not rely on CSS or deleting only two known keys.

Build a player-safe state projection.

Test that player snapshots do not leak DM-only information through:
- entities;
- nested locations;
- timeline details;
- cards;
- quests;
- messages/tool payloads;
- search metadata.

---

# P1 — Add Characters UI integration tests

Using the existing browser tooling where possible, prove:

- Characters/People nav exists on desktop/mobile.
- PCs and created NPCs appear.
- Search works by name and alias.
- Type/status/relationship filters work.
- Sorting works.
- Detail opens by stable entity ID.
- First-met, last-seen, and known location are correct.
- Portrait upload targets the intended entity.
- Player cannot edit another entity's portrait.
- Copy portrait prompt is stable from canonical appearance.
- Returning to the list preserves filters/search.
- Transcript entity link opens correct entity.
- Hidden DM data is absent from player state/UI.
- A large fixture with hundreds of entities remains usable.

---

# P1 — NPC / monster combatants

Keep identity and mechanics separate:

```text
entity
  -> optional mechanics record
  -> optional combatant
```

Add support for:
- AC;
- HP;
- speed;
- abilities;
- save proficiency;
- attacks;
- conditions;
- side;
- zero-HP policy.

Use:

```js
zeroHpPolicy: "death" | "death_saves"
```

Do not infer a full stat block from prose.

---

# P2 — Attack fidelity

After P0/P1 are green:

## Finesse
Allow explicit STR or DEX choice. Do not silently force the larger stat as the only behavior.

## Weapon ranges
Represent normal + long range and apply long-range disadvantage.

Example:

```js
range: { normal: 20, long: 60 }
```

## Proficiency
Prefer actual character proficiency data. Class-name inference should be migration/initialization fallback, not runtime truth.

## Cover
Only add cover when position/map state can support it reliably.

---

# P2 — Conditions as declarative data

Move condition behavior toward a data-driven layer.

At minimum cover:
- blinded;
- charmed;
- deafened;
- frightened;
- grappled;
- incapacitated;
- invisible;
- paralyzed;
- petrified;
- poisoned;
- prone;
- restrained;
- stunned;
- unconscious.

Expose effects such as:
- canAct;
- canReact;
- canMove;
- speed override;
- auto save failures;
- outgoing/incoming attack modifiers.

Test condition composition.

---

# P3 — Spells/resources only after stabilization

Do not start broad spell support until:
- WebRTC smoke is green;
- reaction lifecycle is complete;
- entity reference/visibility tests exist;
- core conditions are stable.

Build a generic feature contract first, then encode a very small spell fixture set.

The model may choose an existing spell/feature.
It may not invent its:
- slot;
- DC;
- damage;
- range;
- duration;
- condition;
- resource availability.

---

# Test strategy

Keep current pure unit tests and add:

1. **Pure rules tests**
   - injected dice, very fast.

2. **Host integration tests**
   - real state + `resolveCombatIntent` + event recording + safe snapshots.

3. **Host/player browser smoke**
   - signaling/WebRTC, player intent, reconnect, timeout/reaction, Characters visibility.

Layer 1 passing is no longer enough to call a feature complete.

Mandatory new regression cases:

```text
off-turn reaction succeeds
reaction resets only at owner's next turn
plain Incapacitated can move
Unconscious cannot move
surprised first-turn start/end events remain coherent
late timed-out turnId is rejected
partyControlAbsent and dmControlAbsent remain independent
Ready expires
Ready decline does not spend reaction
Ready accept spends reaction
reaction timeout declines
nat20 doubles damage dice, not modifiers
damage at 0 = one death failure
critical damage at 0 = two failures
instant death excess damage works
finesse supports explicit ability choice
long-range disadvantage works
player snapshot contains no hidden entity data
same-name entities remain distinct by ID
alias resolves existing entity
structured entity link opens correct entity
```

---

# Release gate

Do not call this slice release-ready until:

```bash
git diff --check
just validate
just smoke-webrtc
```

are green and:

- no known mechanical bypass remains;
- Ready/OA UI works or unsupported controls are hidden;
- absent-control permissions are distinct and tested;
- structured entity links + rich hover/tap exist;
- player-safe snapshots have leakage tests;
- unsupported mechanics are rejected clearly rather than approximated.

## Final report

Report:
1. files changed;
2. P0 issues fixed;
3. tests added/count;
4. `just validate` result;
5. `just smoke-webrtc` result;
6. unsupported mechanics;
7. deferred work;
8. whether production was touched (default no).
