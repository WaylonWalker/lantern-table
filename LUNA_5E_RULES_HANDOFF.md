# Lantern Table — 2014 D&D 5e Rules Engine Handoff for Luna

## Mission

Work directly in:

`/home/waylon/git/lantern-table/lantern-table-next`

Implement the first serious rules-authority layer for Lantern Table.

This is not a prompt-only change. The AI Dungeon Master must no longer be able to invent mechanical outcomes and then mutate campaign state. The host browser remains authoritative, but mechanical events must be accepted only after a deterministic 2014 D&D 5e / SRD 5.1 rules resolver validates them.

The target ruleset for this work is **2014 fifth edition, represented by SRD 5.1**. Do not silently implement 2024 / SRD 5.2.x mechanics. D&D Beyond's current SRD page explicitly distinguishes SRD 5.1 as the 5e ruleset and SRD 5.2.x as the newer 5.5e ruleset.

Do the implementation, tests, and integration. Do not stop after writing a design doc or TODO list.

Before editing:

```bash
cd /home/waylon/git/lantern-table/lantern-table-next
git status --short
git diff --stat
```

Preserve all unrelated or in-progress work. Do not reset, clean, checkout over, or otherwise destroy existing changes.

Run the repo's existing validation at the end:

```bash
just validate
just smoke-webrtc
```

If either command is absent or has changed, inspect the `justfile` and use the closest current targets.

---

# Primary design rule

## The LLM is a narrator and intent proposer, not the mechanical authority

The pipeline should become:

1. A player describes an intent.
2. The host-side rules engine determines whether it is legal now.
3. If the action needs a roll, the rules engine constructs the exact roll from authoritative state.
4. The die result is generated locally and recorded.
5. The rules engine computes and emits one or more mechanical events.
6. Those events update host state and are broadcast to replicas.
7. The DM model receives the validated result and narrates it.

Do **not** let the model directly change HP, AC, initiative, conditions, action economy, spell slots, death saves, positions, or other game mechanics.

Model tools may request or propose an intent, but client code must reject anything that has no legal rules path.

A useful mental model is:

`intent -> validate -> resolve -> events -> apply -> narrate`

Never:

`LLM narration -> arbitrary state patch`

---

# Rules baseline and sources

Use the official 2014 Basic Rules / SRD 5.1 as the normative source.

Primary references:

- SRD page / version distinction:
  https://www.dndbeyond.com/srd
- SRD 5.1 CC-BY PDF:
  https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf
- 2014 Basic Rules — Introduction / How to Play:
  https://www.dndbeyond.com/sources/dnd/basic-rules-2014/introduction
- 2014 Basic Rules — Using Ability Scores:
  https://www.dndbeyond.com/sources/dnd/basic-rules-2014/using-ability-scores
- 2014 Basic Rules — Combat:
  https://www.dndbeyond.com/sources/dnd/basic-rules-2014/combat
- 2014 Basic Rules — Conditions:
  https://www.dndbeyond.com/sources/dnd/basic-rules-2014/appendix-a-conditions
- Sage Advice Compendium:
  https://www.dndbeyond.com/sources/dnd/sac/sage-advice-compendium

If you copy SRD text into source comments, docs, UI, or data, honor SRD 5.1's CC-BY-4.0 attribution requirement. Prefer short rule identifiers and links over copying large passages.

---

# Rules you must encode correctly

## 1. Do not turn all play into turns

2014 5e explicitly says that outside structured situations such as combat, players do not need to take turns. The normal loop is:

- DM describes the environment.
- Players say what they want to do.
- DM resolves the actions.
- DM narrates the results.

Therefore add a clear game phase distinction such as:

```js
state.game.phase = 'freeplay' | 'combat'
```

or equivalent.

In `freeplay`:
- multiple players may submit intentions without an initiative lock;
- one silent player must not freeze the entire campaign;
- do not fabricate choices for a silent player's character;
- independent actions from other players may still resolve;
- use ordinary ability checks only when outcome is uncertain.

In `combat`:
- all activity that is part of the fight must respect initiative and reaction timing;
- only the active combatant can take turn-bound actions, except legal reactions and other rules-defined exceptions.

Do not build a universal "only this player can type" system.

## 2. Combat startup order

Implement the 2014 sequence:

1. Determine surprise.
2. Establish positions.
3. Roll initiative.
4. Take turns in initiative order.
5. Start another round when all combatants have taken a turn.

A round represents about six seconds in-world.

Initiative:
- is a Dexterity check;
- stays in the same order from round to round;
- tied player characters may choose their order;
- the DM determines ties among DM-controlled creatures and PC-vs-monster ties;
- rerolling tied initiative is an allowed optional method, but do not silently make that the only behavior.

For a first implementation, deterministic tie ordering plus a recorded tie-resolution reason is fine if the UI for player tie choice would balloon scope. Leave the data model capable of supporting player tie choice.

## 3. Surprise is per creature; there is no "surprise round"

A surprised creature:
- cannot move on its first turn;
- cannot take an action on its first turn;
- cannot take a reaction until that first turn ends.

Another creature on the same side may not be surprised.

Do not model surprise as "the surprised side loses round 1."

After a surprised creature's first turn ends, its surprise restriction is over.

## 4. Turn economy

On a normal turn:
- movement up to speed;
- one action;
- movement may be split before and after the action;
- a bonus action exists only when a feature/spell/rule grants one;
- at most one bonus action on the turn;
- normally one free object interaction during movement/action;
- a second object interaction may require the Use an Object action;
- a creature may forgo movement, action, or its whole turn.

Reaction:
- is triggered, not a normal turn action;
- after a creature uses a reaction, it cannot use another until the start of its next turn.

Do not model "1 reaction per round" as a simple round counter; the authoritative reset point is the **start of that creature's next turn**.

## 5. There is no Delay action

Official Sage Advice is explicit: a combatant cannot delay its turn and take it later.

Do not add "Delay", "Hold Turn", or dynamic initiative reordering as a standard action.

If a player wants to wait for something, use **Ready**.

## 6. Ready

Ready consumes the action on the creature's turn.

It stores:
- a perceivable trigger;
- either an action to perform or movement up to speed when triggered.

When the trigger finishes:
- the creature may spend its reaction to take the readied response;
- or ignore the trigger.

The stored opportunity expires before the creature's next turn.

For a readied spell:
- casting time must be 1 action;
- the spell is cast when Readied;
- holding it requires concentration;
- concentration rules apply;
- preserve enough state to eventually account for resource consumption and losing the held spell if it is never released.

Do not auto-fire Ready for an absent player by default; taking the triggered reaction is optional.

## 7. Standard actions

Build the core action model around real 2014 actions:

- Attack
- Cast a Spell
- Dash
- Disengage
- Dodge
- Help
- Hide
- Ready
- Search
- Use an Object

Also preserve **improvised actions**.

Important: "rules based only" does **not** mean the UI may only expose enumerated buttons. 5e explicitly allows characters to attempt actions not listed in the combat chapter. The DM decides whether the attempt is possible and whether a roll is needed.

The rules engine should distinguish:
- a standard rules action;
- an improvised action adjudicated through a normal ability check / contested check / attack / save;
- an invalid invented mechanic.

An improvised action is legitimate 5e. An invented mechanical power is not.

## 8. Ability checks

An ability check is called for when:
- the character attempts something other than an attack;
- the outcome is uncertain;
- failure is meaningfully possible.

The rules engine must derive the modifier from the actual character:
- ability score -> ability modifier;
- add proficiency only if the relevant proficiency applies;
- support advantage/disadvantage from actual effects.

Typical DCs from the 2014 rules:
- 5 very easy
- 10 easy
- 15 medium
- 20 hard
- 25 very hard
- 30 nearly impossible

The DM may set a DC for an uncertain improvised task, because the rules explicitly delegate that judgment to the DM. Record this as a rule-backed adjudication, not as arbitrary state mutation.

**Delete the existing hard-coded check modifiers.** The current `performRoll()` uses fixed values like DEX +2 and WIS +1 independent of the character. That cannot remain authoritative.

## 9. Saving throws

Saving throws are generally responses to a spell, trap, poison, disease, feature, or other effect. The player does not simply elect to make one.

Represent a saving throw with:
- source/effect;
- required ability;
- DC from the source or adjudicated effect;
- authoritative character modifier/proficiency;
- advantage/disadvantage reasons;
- result.

Mandatory saves should resolve from the engine even if the player is temporarily absent; choosing whether to make the save is not a player decision.

## 10. Attacks

Minimum correct attack pipeline:

1. Validate a target and range/reach.
2. Determine attack modifier from weapon/spell/monster data.
3. Determine advantage/disadvantage and cover where represented.
4. Roll d20.
5. Natural 20 hits and is a critical hit.
6. Natural 1 misses.
7. Otherwise total >= AC hits.
8. Only on a hit, roll and apply the attack's damage/effect.

For weapon attacks:
- normally Strength for melee;
- normally Dexterity for ranged;
- finesse/thrown and feature rules may alter this;
- add proficiency only when proficient.

At minimum support a small, correct weapon/unarmed path before broadening the catalogue. Do not pretend to support every weapon/spell if the data is not present.

Ranged attacks in close combat:
- disadvantage if a hostile creature is within 5 feet, can see the attacker, and is not incapacitated.

Opportunity attack:
- optional reaction;
- triggered when a hostile creature the combatant can see moves out of reach;
- one melee attack;
- occurs immediately before leaving reach;
- Disengage prevents it;
- teleport and forced movement that does not use the target's movement/action/reaction do not provoke.

Do not auto-spend an absent player's reaction.

## 11. Dodge

Dodge lasts until the start of the dodging creature's next turn:
- attacks against it have disadvantage if it can see the attacker;
- it has advantage on Dexterity saves.

The benefit is lost if it becomes incapacitated or speed becomes 0.

Dodge is important to the no-response policy below.

## 12. Conditions must have mechanical effects

At minimum correctly represent the conditions needed by this slice:
- incapacitated;
- unconscious;
- prone;
- grappled;
- restrained;
- stunned;
- paralyzed;
- poisoned;
- blinded;
- invisible.

Do not make conditions cosmetic labels.

Incapacitated means no actions or reactions.

Unconscious includes incapacitated and additional effects such as:
- cannot move or speak;
- unaware;
- fails Strength and Dexterity saves;
- attacks against it have advantage;
- nearby hits can become critical hits according to the 2014 condition.

Build conditions as rule data/effects, not scattered prompt instructions.

## 13. Dropping to 0 HP and death saves

When damage reduces a PC to 0 HP:
- apply instant-death rules for excess damage;
- otherwise they become unconscious.

At the start of a turn at 0 HP, if not stable/dead:
- roll a death save;
- 10+ is one success;
- below 10 is one failure;
- three successes => stable;
- three failures => dead;
- natural 1 => two failures;
- natural 20 => regain 1 HP.

Damage at 0 HP causes death-save failures under the 2014 rules, with critical-hit behavior handled correctly.

Death saving throws are **mandatory start-of-turn resolution**. Do not hold the table waiting for a disconnected player to click "roll death save." Roll it authoritatively, expose the die result, append the event, and continue.

For ordinary monsters, the DM may have them die at 0 HP rather than use PC death saves. Preserve a per-combatant policy so important NPCs can opt into PC-like 0 HP handling later.

---

# No-response / absent-player table procedure

There is **no official 2014 5e rule that says "after N seconds, do X."**

Therefore this feature must be labeled in code/UI/docs as a **Lantern Table procedure**, not RAW.

Recommended first-pass default:

```text
combat turn timeout: 90 seconds
warning: 30 seconds remaining
on timeout:
  process any mandatory rules events;
  if the creature can legally take an action:
      take Dodge;
  take no movement;
  take no bonus action;
  take no free object interaction;
  end the turn.
```

Why Dodge:
- the rules explicitly allow a combatant to do nothing;
- both the combat rules and Sage Advice point to Dodge/Ready for an indecisive turn;
- Ready would require the missing player to choose a trigger/action, while Dodge is a conservative defensive default;
- this does not rewrite initiative.

Edge cases:

### Surprised
On the surprised creature's first turn it cannot move or act anyway. Process the turn and advance without waiting for a timeout.

### Incapacitated / unconscious / stunned / paralyzed
Do not wait for a choice the character cannot legally make. Resolve mandatory start/end-of-turn rules and advance.

### 0 HP
Resolve the death saving throw automatically at the start of the turn. If still unconscious, advance after mandatory events.

### Optional reactions
Opportunity attacks, a readied response, Shield-like future reactions, etc. are optional.

Default:
- present a short reaction window to a connected player when needed;
- if the player does not answer, **decline the reaction**;
- never auto-spend the reaction by default.

A future table setting may configure reaction-window duration. Keep this separate from the 90-second normal-turn timeout.

### Disconnected player
Do not immediately hand control to someone else merely because WebRTC drops.

Use the same active-turn deadline. The host may see that the player is disconnected, but rules behavior remains deterministic.

### Delegation
The app already has:
- `partyControlAbsent`
- `dmControlAbsent`

Wire those permissions into combat rather than creating duplicate settings.

If `partyControlAbsent` is enabled, an authorized party controller may submit an intent for the absent PC during their turn.

If `dmControlAbsent` is enabled, the host/DM may submit the intent.

**All delegated intents go through the exact same validator.** Delegation grants choice, not rules bypass.

If both are disabled, timeout -> Dodge/end turn.

### Stale responses
Every combat turn needs a `turnId`.

Reject a player action/reaction if its `turnId` is no longer active. This is essential for late WebRTC messages arriving after the timeout advanced initiative.

---

# Suggested state shape

Fit this into the current state model instead of doing a full rewrite.

Something along these lines is appropriate:

```js
combat: {
  active: false,
  combatId: null,
  round: 0,
  order: [
    {
      combatantId,
      entityId,
      ownerPlayerId,
      initiative,
      tieOrder,
      surprised
    }
  ],
  activeIndex: 0,
  turnId: null,
  turnStartedAt: null,
  turnDeadlineAt: null,
  reactionPrompt: null,
  readied: [],
}
```

Per-character/combatant mechanical state should cover:

```js
{
  hp,
  maxHp,
  ac,
  speed,
  abilityScores,
  proficiencyBonus,
  proficiencies,
  conditions,
  deathSaves: {successes, failures, stable},
  resources,
  equipment,
}
```

Turn-local state can be derived/reset:

```js
{
  movementRemaining,
  actionAvailable,
  bonusActionUsed,
  reactionAvailable,
  objectInteractionAvailable,
  disengaged,
  dodging,
}
```

Be precise with timing. For example:
- reaction availability resets at **start of that creature's turn**;
- Dodge expires at **start of its next turn**;
- surprise restriction ends when the creature's first turn ends;
- Ready expires before the creature's next turn if unused.

Avoid encoding all these as "until end of round."

---

# Event model

Mechanical changes should be emitted as auditable events.

Suggested shape:

```js
{
  eventId,
  eventType,
  at,
  sourceRule: 'srd5.1:combat:attack',
  sourceFeature: null,
  combatId,
  turnId,
  actorId,
  targetIds,
  intent,
  roll: {
    dice,
    raw,
    kept,
    modifiers,
    total,
    targetNumber,
    advantageReasons,
    disadvantageReasons,
  },
  outcome,
  mutations,
}
```

Not every event needs every property.

Examples:
- `combat_started`
- `initiative_rolled`
- `turn_started`
- `action_dodge`
- `attack_roll`
- `damage`
- `condition_added`
- `condition_removed`
- `death_save`
- `turn_timed_out`
- `turn_ended`
- `reaction_declined`
- `table_ruling`

Reuse the existing timeline for human-readable history, but keep enough structured event data that a reconnecting player and the AI DM can distinguish what mechanically occurred from narration.

The event must say **why** it was legal.

---

# Dice

Replace `Math.random()` for authoritative dice with a small local utility based on `crypto.getRandomValues`.

The result should record:
- each raw die;
- which die was kept for advantage/disadvantage;
- every modifier;
- total;
- DC/AC if applicable;
- success/failure/hit/miss.

The goal is not cryptographic casino fairness. The goal is:
- not using the generic weak PRNG;
- auditability;
- reproducible event structure;
- no model-fabricated dice.

Never let the model send "I rolled 17" as authoritative input.

---

# Fix the current DM tool contract

The current server exposes:
- `set_next_moves`
- `request_roll`
- `set_character_mechanics`
- `render_card`
- `propose_state_patch`
- `set_atmosphere`
- `suggest_visual_prompt`

The existing `request_roll` is too generic, and the current mechanics/state tools are too powerful.

## `request_roll`

Replace/augment it with a structured request that describes the rules context, not just a label + arbitrary DC.

Useful fields:

```json
{
  "kind": "ability_check | attack_roll | saving_throw | death_save | initiative | damage",
  "actor_id": "...",
  "target_id": "... or null",
  "ability": "STR | DEX | CON | INT | WIS | CHA | null",
  "skill": "stealth | perception | ... | null",
  "source_rule": "...",
  "source_feature": "... or null",
  "requested_dc": null,
  "reason": "..."
}
```

The engine decides whether a supplied DC is permitted. For example:
- an improvised uncertain task may allow a DM-set DC;
- a weapon attack must target AC;
- a spell/save whose feature defines the DC must use that feature;
- a death save uses the death-save rule, not an LLM-selected DC.

## `set_character_mechanics`

Do not allow this as a general mid-game mutation path.

It may remain temporarily for **initial character-sheet establishment/correction**, but:
- validate ranges and source;
- distinguish initialization from runtime events;
- preferably require host confirmation for corrections after play starts.

Combat damage/healing never goes through this tool.

## `propose_state_patch`

Remove `hp_delta` as a way to mechanically alter HP.

Scene title, journal notes, quest prose, and similar narrative metadata can remain patchable.

Mechanical mutations must come from validated rules events such as:
- resolved attack damage;
- resolved spell/effect damage;
- healing effect;
- rest/resource rule;
- explicit host correction.

Do not let the AI say "the trap hits you; -12 HP" and then apply `hp_delta= -12`.

The model can propose: "the pressure plate triggers the known dart trap against Character X."
The engine resolves the actual attack/save/damage rule.

---

# Rules strictness modes

The app currently has `Story first`, `Balanced`, and `Rules strict`.

Do not interpret those as:
- strict = rules
- other modes = hallucinated mechanics

All modes must use legal state transitions.

Recommended meaning:

## Rules strict
- Use SRD 5.1 mechanics as written.
- Improvised actions use only the adjudication the rules explicitly permit.
- No invented powers or mechanical exceptions.

## Balanced
- Same authoritative rules core.
- DM may make ordinary table rulings in gaps the 5e rules intentionally leave to the DM.
- Log a `table_ruling` event with the reason and relevant check/DC.

## Story first
- Same authoritative state engine.
- Be generous when deciding whether a creative attempt is possible and what check can resolve it.
- Never silently create mechanical abilities, extra actions, damage, conditions, spell effects, or resources that the character does not have.
- Any explicit rules exception must be visibly recorded as a house/table ruling and should not be the default.

This preserves creative D&D play without letting the LLM become a rules hallucination engine.

---

# Where to implement

The app is deliberately local-first. Do not move authoritative campaign state into the public server.

Prefer a focused browser-side rules module rather than turning `assets/app.js` into a larger monolith.

A reasonable shape is:

```text
assets/
  rules5e.mjs
  app.js
```

or another small module layout that fits the existing script style.

Responsibilities for the rules module:
- dice;
- modifiers;
- initiative;
- turn lifecycle;
- legal action checks;
- conditions;
- core action resolution;
- attack resolution;
- saves/checks;
- HP / 0 HP / death saves;
- timeout policy;
- event construction.

`app.js` should mostly:
- collect player intent;
- render UI;
- call the resolver;
- apply/broadcast accepted events;
- reject illegal/stale intents;
- feed validated outcomes to the DM.

Do not make the Python companion own the combat state. It may expose better AI tool schemas/instructions, but the host browser still owns the campaign.

---

# Multiplayer authority

The host is already the canonical authority. Preserve that.

Joining players should send:

```js
{
  type: 'player_intent',
  playerId,
  characterId,
  combatId,
  turnId,
  intent: {...}
}
```

The host:
- verifies ownership/delegation;
- verifies combat/turn IDs;
- resolves the intent;
- applies events;
- broadcasts resulting authoritative state/events.

A player replica never directly mutates HP, conditions, initiative, inventory resources, etc.

Reject:
- wrong player/character ownership;
- non-active turn actions;
- stale `turnId`;
- nonexistent target;
- action not granted by rules/feature;
- movement exceeding budget;
- second action without feature;
- second bonus action;
- reaction when unavailable;
- arbitrary HP/state patches.

---

# UI expectations for the first slice

Keep it small but playable.

In combat, show:
- round number;
- initiative order;
- active combatant;
- "Your turn" state;
- time remaining;
- action used/available;
- movement remaining;
- reaction availability;
- conditions that affect legal actions;
- clear 30-second warning before auto-Dodge;
- timeout result in transcript/timeline;
- any pending optional reaction with a short accept/decline affordance.

Do not disable ordinary transcript/chat visibility for non-active players. Only gate **mechanical turn intents**.

Outside combat, keep the current free-flowing interaction.

---

# First implementation slice

Do not attempt the entire spell/class/monster rules corpus in one pass.

Land a coherent core that is strict and extensible.

## Required for this pass

1. Freeplay vs combat phase.
2. Combat startup and initiative.
3. Per-creature surprise.
4. Round/turn advancement.
5. Movement/action/bonus/reaction bookkeeping.
6. Turn IDs and stale-intent rejection.
7. 90-second default inactive-turn procedure with Dodge fallback.
8. Existing party/DM absent-control permissions wired into delegation.
9. Optional reaction timeout defaults to decline.
10. Dodge, Dash, Disengage, Ready infrastructure.
11. Basic Attack resolution with authoritative AC/modifiers and critical 1/20 behavior.
12. Ability checks from real character stats/proficiencies.
13. Saving-throw resolver.
14. Conditions needed by the above.
15. HP changes only through mechanical events.
16. 0 HP / unconscious / death saving throws / stable/dead basics.
17. Structured event provenance.
18. DM tool restrictions/instructions updated to use the resolver instead of arbitrary mechanical patches.
19. Multiplayer host validation.
20. Tests.

If Hide/Search/Help/Use Object can fit without destabilizing the pass, add them. Otherwise expose them as typed intents that can be adjudicated using the general check/ruling path.

Spellcasting should have an extensible hook but does not need the entire SRD spell catalogue in this first pass. It is better to reject unsupported spell mechanics clearly than to fake them.

---

# Acceptance tests

Add deterministic tests around pure rules functions. Inject/override dice where needed so tests do not depend on randomness.

At minimum prove these:

### Phase / turn behavior
- Out-of-combat players are not initiative-locked.
- Combat order remains stable across rounds.
- Only active creature may take a turn action.
- A reaction can occur outside its owner's active turn when a legal trigger exists.
- A stale turn ID is rejected.

### Surprise
- Surprise is tracked per combatant.
- Surprised creature cannot move or act on first turn.
- It cannot react until that turn ends.
- It is normal afterward.
- No global "surprise round" flag skips an entire side.

### Action economy
- Move 10 ft -> act -> move remaining 20 ft is legal at speed 30.
- Movement beyond budget is rejected.
- A second ordinary action is rejected without a feature granting it.
- Bonus action cannot be used unless a feature/rule grants that specific bonus action.
- Second bonus action is rejected.
- Reaction can be used once, then resets at start of that creature's next turn.
- There is no Delay action.
- Ready consumes action and may later consume reaction.

### Timeout
- Connected/unconnected player who gives no answer reaches timeout.
- Legal/action-capable creature gets Dodge, no movement, no bonus action, then turn ends.
- Incapacitated creature does not incorrectly Dodge.
- Surprised first turn advances correctly.
- Timeout event is logged as Lantern Table procedure, not SRD rule.
- Late action from the timed-out turn is rejected.

### Reactions
- Optional opportunity attack can be declined.
- Reaction timeout declines rather than auto-attacks.
- Disengage suppresses opportunity attack.
- Forced movement/teleport does not create the normal opportunity-attack trigger.

### Checks
- Modifier derives from ability score.
- Proficiency applies only when relevant.
- Hard-coded DEX/WIS modifiers are gone.
- Advantage/disadvantage dice are auditable.
- DM-set DC is accepted only in a context where the DM is allowed to adjudicate it.

### Attack
- target out of range is rejected;
- total >= AC hits;
- natural 1 misses;
- natural 20 hits/criticals;
- damage only applies after hit;
- ranged close-combat disadvantage works when represented;
- HP changes are emitted by the resolved event, not arbitrary patch code.

### 0 HP
- drop to 0 causes unconscious if not instant death;
- death save happens at start of turn;
- 10+ success;
- third success stable;
- third failure dead;
- natural 1 counts as two failures;
- natural 20 restores 1 HP;
- stable character does not keep rolling death saves.

### Conditions
- incapacitated blocks action/reaction;
- unconscious composes incapacitated behavior;
- Dodge benefit disappears if incapacitated/speed 0;
- condition timing is not mistakenly implemented as blanket end-of-round expiration.

### Multiplayer
- player cannot mutate host mechanics directly;
- delegated absent-character action requires existing permission;
- delegated action still fails if mechanically illegal;
- host broadcasts resolved event/state;
- reconnect gets current combat/turn state.

### Regression
- `just validate`
- `just smoke-webrtc`
- existing freeplay/campaign creation still works;
- existing host/join connection flow still works.

---

# Important current-code findings to address

Inspect current files before changing anything, but expect these areas:

## `assets/app.js`

Current defaults already include:

- `partyControlAbsent`
- `dmControlAbsent`

Use them.

Current `act()`:
- players send a `player_action` to host;
- host records it and sends it to AI;
- this is the seam where a typed `player_intent` path should be introduced for combat.

Current `performRoll()`:
- uses hard-coded character modifiers;
- rolls locally and sends the textual result back through `act()`.

Replace this with authoritative character-derived roll state.

Current `applyPatch()`:
- can apply an AI-proposed HP delta.

Remove that mechanical authority.

Current `handleTool()`:
- handles `set_character_mechanics` and `propose_state_patch`.

Constrain these as described above.

## `dnd_chatgpt_server.py`

Current `dm_instructions()` correctly says not to fabricate dice, but it still grants the model too much mechanical authority.

Update the instructions so the DM:
- narrates only resolved mechanics as facts;
- proposes intents/rulings but never claims an unresolved hit/save/damage outcome;
- does not invent character features;
- may ask the engine for a legal roll/action;
- understands freeplay vs combat and active turn;
- does not invent a "surprise round";
- does not offer Delay;
- does not control absent PCs unless the appropriate campaign permission says so.

Update `DM_TOOLS` accordingly.

Keep presentation-only tools like atmosphere/cards/visual prompts separate from rules events.

---

# AI DM behavior contract

Add something equivalent to this to the DM instructions:

```text
MECHANICAL AUTHORITY
- You are not the mechanical state authority. The Lantern 5e resolver is.
- Never state that an attack hits, a save fails, damage is taken, HP changes, a condition applies, a resource is spent, or a creature dies until a validated rules event reports that outcome.
- Never invent a class feature, spell, item property, action, reaction, resistance, immunity, proficiency, AC, DC, movement speed, or damage expression that is not present in authoritative state/rule data.
- In combat, respect the active combatant and initiative order.
- 2014 5e has no standard Delay action. Use Ready for a creature intentionally waiting on a trigger.
- Surprise is per creature at the start of combat, not a surprise round.
- Outside combat, do not force initiative or turn order.
- Creative improvised actions are allowed. Adjudicate them using normal 5e checks/contests/attacks/saves where appropriate; do not invent a special mechanic.
- If the engine rejects an intent, explain the rules constraint and ask for another action rather than narrating the rejected action as successful.
- If a mechanical rule is not implemented, say the table cannot resolve that mechanic yet rather than making up a result.
```

Do not rely on these words alone. The validator is the real enforcement boundary.

---

# Source provenance

Use compact internal rule IDs such as:

```text
srd5.1:how-to-play
srd5.1:combat:initiative
srd5.1:combat:surprise
srd5.1:combat:turn
srd5.1:combat:bonus-action
srd5.1:combat:reaction
srd5.1:combat:dodge
srd5.1:combat:ready
srd5.1:combat:attack
srd5.1:combat:opportunity-attack
srd5.1:ability-check
srd5.1:saving-throw
srd5.1:condition:incapacitated
srd5.1:condition:unconscious
srd5.1:combat:death-save
lantern:procedure:turn-timeout
lantern:procedure:reaction-timeout
```

Put the source URL in a central rule metadata map rather than repeating URLs everywhere.

This will make timeline/debug dumps useful later and will let the AI distinguish RAW rules from Lantern Table procedure.

---


---

# Persistent character / NPC registry and returning-player memory

This is required alongside the rules work, not a later polish pass.

Lantern Table needs a durable registry for every meaningful persistent person it creates or encounters:
- player characters;
- NPCs;
- companions;
- recurring villains;
- recurring intelligent monsters;
- named retainers, patrons, rivals, merchants, quest-givers, etc.

Do not rely on prose history alone.

The goals are:
1. new players can quickly understand who someone is;
2. returning players can recover context after days/weeks away;
3. the DM model has stable identity references instead of reconstructing characters from recent chat;
4. the rules engine can target entities by ID rather than ambiguous display names;
5. portrait/art generation stays visually consistent over time.

## Entity identity

Every persistent person must have a stable ID.

Do not use display name as identity.

Suggested shape:

```js
{
  id: "npc_...",
  kind: "pc" | "npc" | "companion" | "villain" | "creature",
  name: "Branna",
  aliases: [],
  shortDescription: "A grease-streaked gnome mechanic with copper spectacles.",
  appearance: "...",
  personality: {
    traits: ["impatient", "protective", "technically obsessive"],
    mannerisms: ["taps tools against her palm while thinking"],
    voice: "rapid, dry, practical"
  },

  relationship: "Friendly mechanic and employer",

  firstMet: {
    eventId: "...",
    session: 2,
    locationId: "...",
    locationName: "The Cog and Hammer"
  },

  currentLocation: {
    locationId: "...",
    locationName: "The Cog and Hammer",
    status: "known" // known | last-known | unknown
  },

  lastSeen: {
    eventId: "...",
    session: 3,
    locationId: "...",
    locationName: "The Cog and Hammer"
  },

  notes: [],
  tags: [],

  imageAssetId: null,
  portraitPrompt: "...",

  createdAt: "...",
  updatedAt: "...",

  alive: true,

  // Mechanical link when applicable.
  mechanicsEntityId: "..."
}
```

Fit this to the current state model rather than forcing this exact schema if a better existing abstraction already exists.

## Creation must be visible in the timeline

Whenever the DM creates a meaningful persistent entity, emit a structured timeline event.

Examples:

```text
character_created
npc_created
character_met
character_arrived
character_departed
character_joined_party
character_left_party
character_relationship_changed
character_location_changed
character_died
character_missing
character_profile_updated
portrait_added
```

At minimum, first creation records:
- entity ID;
- display name;
- short description;
- creator (`DM`, `player`, imported character, etc.);
- session;
- scene/location;
- why the entity became persistent.

The first encounter should also be explicit:

```js
{
  eventType: "character_met",
  entityId: "...",
  locationId: "...",
  session: 2,
  summary: "The party met Branna at the Cog and Hammer."
}
```

Do not silently invent `firstMet` later from prose.

## Current location and last known location

The registry must distinguish:
- where the character actually is in authoritative campaign state;
- where the party/player last knew them to be.

This matters when an NPC leaves the party's view.

Do not leak omniscient information to players merely because the DM/world state knows it.

A useful distinction is:

```js
dmLocation: {...}
playerKnownLocation: {...}
```

or equivalent visibility-aware state.

If the app does not yet have information visibility layers, implement at least:
- `currentLocation`;
- `locationKnowledge: "known" | "last-known" | "unknown"`.

Do not tell players the villain is "currently in the crypt" if they only know the villain was last seen at the docks.

## Personality is durable state

The model may invent personality, but once established it becomes canonical campaign state.

Persist:
- core traits;
- goals/motivations when known;
- mannerisms;
- voice/speech style;
- attitude/relationship to the party;
- important loyalties;
- notable fears/desires when revealed;
- recurring visual details.

The model may develop a character over time, but changes should be explicit updates, not accidental drift between conversations.

Do not resend the entire biography on every DM turn. Use entity retrieval/context selectively.

## Rich entity references in narration

Known entity mentions should support a rich hover/focus treatment everywhere practical:
- DM transcript;
- timeline;
- quest text;
- journal;
- cards;
- combat tracker;
- location occupants;
- inventory ownership/history where relevant.

Do not solve this by blindly regex-linking matching text.

Names are ambiguous, aliases exist, and ordinary words can overlap character names.

Prefer structured entity references generated by the DM/tooling, for example an internal form such as:

```md
[[entity:npc_branna_123|Branna]]
```

The renderer converts this to a semantic entity link.

Desktop:
- hover and keyboard focus show the profile card.

Touch/mobile:
- tap opens the same information in a compact popover/bottom sheet.

The rendered text should still read naturally if entity enhancement fails.

## Rich hover/focus card

At minimum show:
- portrait if present;
- name;
- entity type;
- short description;
- personality traits;
- relationship to party/player;
- where first met;
- current or last-known location;
- last seen/session;
- key known notes;
- "View history" affordance.

Do not dump hidden DM-only notes into player hover cards.

A player's own PC card can expose richer mechanical information.

## Entity history

Allow `View history` to filter the existing timeline by entity ID.

Returning players should be able to answer:
- When did we first meet this person?
- Where?
- What did they ask us to do?
- When did we last see them?
- Did they travel with us?
- When did their relationship to the party change?

This should use structured timeline references, not an AI-generated summary as the only source.

The model may generate a concise recap from this history later, but the underlying timeline is canonical.

## Portrait workflow

Each persistent character should support:
- upload portrait;
- paste/drop portrait;
- replace portrait;
- remove portrait;
- copy portrait prompt.

Use the existing local asset/IndexedDB model. Do not put campaign images on the public signaling service.

The DM/host must be able to attach an uploaded image directly to the entity.

If players have portrait-change permission for their own PC, preserve that behavior.

## Copyable ChatGPT portrait prompt

Each entity should have an easy "Copy portrait prompt" action.

Generate the prompt from **canonical appearance and personality state**, not from fresh model improvisation each click.

Example output:

```text
Create a tabletop RPG character portrait of Branna, a compact middle-aged gnome mechanic with copper spectacles, soot-smudged cheeks, auburn hair tied back with wire, and a heavy leather workshop apron over practical dark-green clothes. She has a clever, impatient expression and the posture of someone always midway through solving a mechanical problem. Warm fantasy workshop lighting, shoulders-up composition, readable silhouette, neutral unobtrusive background, detailed painterly fantasy character art, no text, no frame.
```

The prompt should normally include:
- species/ancestry if known;
- apparent age;
- build;
- face;
- hair;
- eyes if known;
- clothing/armor;
- signature items;
- scars/tattoos/distinguishing features;
- usual expression/body language;
- personality cue;
- portrait framing;
- background simplicity;
- art direction appropriate to the current Lantern Table visual language.

Do not invent missing physical details merely to fill the prompt unless the DM explicitly establishes them.

If details are missing, omit them.

Persist the generated prompt or enough structured appearance data to recreate it consistently later.

## DM tools for entity memory

Add or adapt structured tools such as:

```text
create_entity
update_entity_profile
record_entity_encounter
move_entity
set_entity_relationship
set_entity_known_location
attach_entity_portrait_metadata
```

Exact names may differ.

The model proposes descriptive data.

Deterministic host code:
- generates/stabilizes IDs;
- validates references;
- timestamps the change;
- records session/location;
- writes timeline events;
- applies visibility rules;
- broadcasts authoritative state.

The model must not fabricate an existing entity ID.

## Duplicate prevention

Before creating a new entity, the DM should be shown/retrieved likely existing matches.

Do not create:
- "Branna"
- "Brana"
- "the gnome mechanic"

as three people because recent context was incomplete.

Entity creation should support:
- aliases;
- candidate matching;
- explicit `new entity` vs `existing entity`.

For model tools, include a stable context list of relevant known entities by ID/name/short description.

## Relationship to combat/rules engine

This registry is also rules infrastructure.

Combatants should point to stable entity IDs.

Do not target mechanical effects by free-text character name if a stable ID exists.

For example:

```js
{
  combatantId: "...",
  entityId: "npc_branna_123",
  ownerPlayerId: null,
  mechanicsEntityId: "mechanics_branna_123"
}
```

This prevents:
- wrong target due to duplicate names;
- accidental HP mutation of the current player's character;
- confusion between an NPC and PC with similar names;
- reconnect inconsistencies.

---

# Deterministic code vs model responsibility

This boundary is a core product requirement.

The guiding principle is:

> The model decides what the fiction means. Code decides what the mechanics do.

Lantern Table should be generous and creative about **intent interpretation**, while deterministic about **mechanical consequences**.

## Mechanical systems that should be deterministic

Once sufficient state exists, these should be code-owned:

- combat phase vs freeplay;
- initiative;
- initiative ordering;
- round advancement;
- active turn;
- surprise restrictions;
- movement budgets;
- action availability;
- bonus-action availability;
- reaction availability/reset timing;
- object-interaction bookkeeping;
- legal standard actions;
- Ready timing;
- Dodge timing/effects;
- Disengage;
- Dash;
- attack roll arithmetic;
- AC comparison;
- critical hit / natural 1 behavior;
- damage dice/effects for encoded attacks;
- ability modifiers;
- proficiency bonus;
- skill proficiency/expertise when represented;
- saving throw modifiers;
- advantage/disadvantage dice mechanics;
- conditions and their encoded effects;
- HP;
- temporary HP when added;
- 0 HP behavior;
- unconscious/stable/dead state;
- death saves;
- spell/resource consumption for encoded features;
- reaction consumption;
- opportunity attack trigger detection when positional data is sufficient;
- turn/reaction timeout procedure;
- ownership/delegation;
- permissions;
- stale turn rejection;
- entity IDs;
- timeline timestamps/session IDs;
- current authoritative location updates;
- mechanical event provenance.

Do not ask the model to calculate facts code already knows.

Examples the model should never decide:

```text
Does 17 + 5 hit AC 19?
How much movement does this creature have left?
Has this fighter already spent their reaction?
Does a natural 1 death save count as one or two failures?
Can this unconscious creature Dodge?
Does this character get proficiency on this save?
```

Code answers those.

## Areas where the model should remain important

The model should handle:

- understanding natural-language player intent;
- NPC dialogue;
- personality;
- motivations;
- scene description;
- worldbuilding;
- social interaction;
- interpreting unusual/improvised actions;
- deciding whether an uncertain fictional attempt calls for a check when the rules leave that to the DM;
- selecting the most appropriate ability/skill for an unusual attempt;
- setting a reasonable DM-adjudicated DC where 5e explicitly delegates that choice;
- deciding fictional consequences around a resolved mechanical result;
- determining whether an NPC becomes important enough to persist in the entity registry;
- generating concise descriptions/portrait prompts from canonical state;
- summarizing structured entity/timeline history for a returning player.

## Example boundary

Player:

> I jump from the balcony, grab the chandelier, swing over the guards, and kick the cultist into the brazier.

The model may determine:

```text
This is physically possible in the established scene.
Resolve it as a Dexterity (Acrobatics) check, DC 15.
```

The deterministic engine then does something equivalent to:

```text
DEX 16 => +3
Acrobatics proficient => +2
Total modifier => +5

d20 => 12
total => 17
DC => 15

success
```

The engine records the roll/event.

The model may then narrate the successful swing and kick.

The model may **not** independently add:

```text
The cultist takes 28 fire damage and is stunned for three rounds.
```

unless:
- a real encoded rule/effect produces that damage/condition; or
- the DM invokes an explicit table-ruling path that is logged as such and validated against allowed house-rule authority.

## Model adjudication is not arbitrary mutation

5e deliberately leaves many unusual actions to DM judgment.

Support that with a structured ruling path.

For example:

```js
{
  type: "table_ruling",
  rulesMode: "balanced",
  intent: "...",
  determination: "ability_check",
  ability: "DEX",
  skill: "Acrobatics",
  dc: 15,
  reason: "Swinging from the moving chandelier while avoiding the guards.",
  sourceRule: "srd5.1:ability-check"
}
```

The ruling chooses the legal resolution method.

The deterministic engine still performs the roll, modifiers, event, and state updates.

## Rules strictness does not change this authority boundary

`Story first`, `Balanced`, and `Rules strict` may influence how permissive the model is when interpreting fictional attempts.

They must **not** determine whether the LLM is allowed to bypass the engine.

In every rules mode:

```text
Model: intent/adjudication/narration
Code: mechanics/state authority
```

## Character memory follows the same pattern

The same architecture applies to campaign identity:

> The model invents Branna. Code remembers who Branna is.

The model may decide:
- Branna is impatient;
- Branna taps a wrench when thinking;
- Branna distrusts the duke;
- Branna has copper spectacles.

Code owns:
- `entityId`;
- when she was created;
- when/where she was first met;
- where she is/was last known;
- timeline links;
- portrait asset reference;
- which combatant/mechanics record belongs to her;
- which facts are player-visible;
- stable references in narration.

---

# Additional acceptance tests for entity memory

Add tests or deterministic fixtures proving:

## Creation/history
- Creating a persistent NPC produces one stable entity ID.
- Creation emits a timeline event.
- First encounter records session and location.
- Re-mentioning the NPC does not create another entity.
- Alias lookup resolves to the same entity.
- Two genuinely different entities may share a display name without identity collision.

## Location
- Entity movement updates authoritative location.
- Last-known player-visible location is retained appropriately.
- Hidden DM location is not exposed to player hover data.
- Timeline records important arrivals/departures.

## Rich references
- Structured entity links resolve to the correct ID.
- Unknown/missing entity references fail gracefully as plain text.
- Hover/focus card uses player-visible data only.
- Mobile tap path exposes the same core profile information.
- Timeline can filter by entity ID.

## Portraits
- Portrait asset attaches to the intended entity.
- Removing/replacing portrait does not alter identity/history.
- Copy portrait prompt is derived from persisted canonical appearance.
- Missing appearance fields are omitted rather than hallucinated.
- PC portrait permissions remain respected.

## Multiplayer
- Host-created entity gets stable ID before broadcast.
- Player replicas receive the same entity ID.
- Players cannot create arbitrary authoritative NPC records by spoofing a peer message.
- Combat targets use entity/combatant IDs, not untrusted names.

## Returning-player behavior
Given a fixture campaign with several sessions, the app can render for an NPC:
- description;
- personality;
- where first met;
- current/last-known location;
- last seen;
- timeline history;
- portrait/prompt when available.

The information must come from structured state/events, not only a model summary.


## Dedicated Characters UI

Lantern Table needs a first-class **Characters** view in the main app navigation.

This is required for both new and returning players.

The view should list every player-visible persistent character/entity known to the party:
- player characters;
- NPCs;
- companions;
- villains;
- recurring named creatures;
- patrons, merchants, quest-givers, rivals, etc.

Do not rely on hover cards as the only discovery mechanism.

### Character directory

The default Characters view should provide:
- search by name, alias, description, role, and known location;
- filters by entity type;
- filters such as:
  - party;
  - allies;
  - neutral;
  - hostile;
  - unknown/unclear relationship;
  - alive;
  - dead;
  - missing;
- optional location grouping/filtering;
- sort by:
  - recently seen;
  - first met;
  - name;
  - relationship;
- portrait thumbnail when available;
- name;
- short description;
- relationship/status;
- current or last-known location;
- last-seen session/time;
- compact personality tags.

The directory should remain useful with dozens or hundreds of characters.

Do not render all biography text in the list view.

### Character detail view

Selecting a character should open a rich detail panel/page/sheet.

At minimum show:

#### Identity
- portrait;
- name;
- aliases;
- type/role;
- short description;
- fuller appearance description;
- personality traits;
- mannerisms/voice;
- relationship to party;
- known affiliations/factions.

#### Campaign history
- where first met;
- session first met;
- current or last-known location;
- last seen;
- important known events;
- quests associated with them;
- timeline filtered to that entity.

#### Portrait / art actions
- upload portrait;
- paste/drop portrait;
- replace/remove portrait;
- copy portrait prompt.

#### Navigation
- jump to first meeting event;
- jump to most recent event;
- open full filtered timeline;
- jump to current/last-known location when location pages exist.

### Information visibility

The Characters view must use the player's **known** information, not hidden DM/world state.

For example, if the DM knows that a villain secretly moved from the docks to the crypt, but the party has not discovered this, the character directory should still say something like:

```text
Last known location: East Docks
Last seen: Session 6
```

not:

```text
Current location: Black Crypt
```

Host/DM mode may optionally expose hidden information in a clearly distinct DM-only section.

Never accidentally leak hidden notes through:
- search indexing;
- hover text;
- HTML attributes;
- client-side rendered hidden elements;
- multiplayer snapshots intended for players.

### Character navigation + entity references

Clicking/tapping any structured entity reference in:
- transcript;
- timeline;
- quest;
- journal;
- combat tracker;
- location page;

should be able to open the same Character detail UI.

Desktop hover/focus remains a quick preview.

The dedicated Characters page is the authoritative deeper view.

### Returning-player utility

The page should answer these questions without requiring AI:

- Who is this?
- Where did we meet them?
- What are they like?
- Are they friend or foe?
- Where are they now, as far as we know?
- When did we last see them?
- What important things have they done?
- Which quests or events involve them?
- Do we have a portrait?
- Can I quickly generate one?

The data for these answers must come from structured campaign state and timeline events.

A future model-generated recap may summarize them, but it should not be the sole source.

### Suggested UI arrangement

Keep the visual style aligned with Lantern Table.

Desktop:
- left: search/filter list;
- center/right: selected character detail;
- timeline/history section beneath or in a secondary panel.

Mobile:
- full-screen character list;
- selecting one opens a detail sheet/page;
- back returns to the previous filter/search state.

Do not require hover for any essential information.

### Empty and partial states

Handle incomplete character data gracefully.

Examples:
- no portrait -> initials/silhouette;
- unknown location -> "Location unknown";
- only last-known location -> clearly label it "Last known";
- no personality yet -> omit the section rather than invent details;
- no aliases -> omit aliases;
- no meaningful history yet -> show the creation/first-meeting event.

### Character creation from DM output

When the DM creates a persistent named character during play:
1. create/stabilize the entity;
2. append the creation/meeting timeline event;
3. make that character immediately discoverable in Characters;
4. entity-link future mentions;
5. allow portrait upload/prompt immediately.

The user should not need to manually "save" an NPC after the model introduces them if the DM has already decided they are persistent.

### Additional UI acceptance tests

Prove:

- Characters navigation is present.
- Directory contains known persistent entities.
- Search finds by name and alias.
- Filters work without revealing hidden entities/data.
- Selecting a character opens its detail view.
- Detail view shows first-met and last-seen history.
- Timeline filtering uses entity ID.
- A transcript entity link opens the correct character.
- Mobile interaction does not depend on hover.
- Portrait controls target the correct entity.
- Returning to the list preserves search/filter state.
- Hidden DM location/notes never appear in a player snapshot or UI.
- Hundreds of entities remain usable without rendering an enormous biography list.

# Definition of done for this handoff

Do not finish with only architectural notes.

Finish with:
- actual rules module(s);
- app integration;
- DM tool/instruction changes;
- state migration/defaults;
- combat UI sufficient to exercise it;
- tests;
- updated README documenting 2014 5e / SRD 5.1 baseline and timeout being a Lantern Table procedure;
- SRD attribution if SRD material is incorporated;
- clean validation output;
- concise summary of files changed;
- any intentionally unsupported rules explicitly listed.

If the existing working tree contains overlapping changes, integrate carefully and report what you avoided touching.

Do not deploy to production merely to prove the change. First make the local implementation and tests green. If the repo's established workflow explicitly requires a deployment smoke test and the working tree is safe for it, report the exact deployment action rather than silently changing production.

---

# Research rationale in one sentence

Lantern Table should be flexible about **what players attempt**, because 5e explicitly supports improvised actions, but strict about **how mechanical consequences occur**: initiative, action economy, attack/save/check math, conditions, HP, death, and reactions must all come through authoritative 2014 5e rules or an explicitly recorded table ruling.
