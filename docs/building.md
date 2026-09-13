# Building

How a bot turns a blueprint into a structure: the JSON format, the registry
and selector that pick one, the site survey, the block-by-block builder,
the placement rules for blocks you cannot hold (farmland, water, crops),
and the door macro that lets a bot use the house it just built. All of it
lives in `bots/building/`; the model reaches it through three tools,
[`blueprints`, `survey_site` and `build`](tools.md#build-botsagenttoolsbuildjs).

```
model ── build tool ──▶ BlueprintRegistry (bots/building/blueprints/*.json)
              │              │ canAfford / materialsNeeded
              │         surveySite (flat, clear, outside protection)
              ▼
        BlueprintBuilder ── placement list (rotation, order, door pairs)
              │             ├─ placeGuard: classify cell, verify by polling
              │             ├─ placement.js: place | till | water | plant
              │             └─ scaffolds, site prep, no-progress detector
              ▼
        completion scan ──▶ home cells, wall cells → Movement, door macro
```

## Blueprint JSON

One file per blueprint in `bots/building/blueprints/`. The registry reads
these fields (`blueprintRegistry.js`, `_validate`):

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | stable name the tools use (`build blueprint=cobble_hut`) |
| `name`, `description` | no | shown by the `blueprints` tool |
| `category` | yes | one of `base`, `farm`, `trap`, `storage`, `wall`, `tower`; a finished `base` becomes the bot's home |
| `tier_min`, `tier_max` | no (1, = min) | skill tiers; the registry only enforces the floor (a tier-3 bot may build a tier-1 hut) |
| `archetypes` | no | which profile archetypes the selector offers it to |
| `placement` | no (`surface`) | `surface`, `underground`, `sky`, `any`; underground anchors are forced to y 12 and the survey is skipped |
| `dimensions` | yes | `{x, y, z}`; must match the layer grid exactly |
| `layers` | yes | `y` layers, each `z` rows of `x` characters, bottom layer first |
| `token_map` | yes | character → block name; `null` means air (the cell is cleared, not placed) |
| `materials` | no | block name → count; drives `canAfford`; a soft warning logs when the sum differs from the cell count |
| `substitutions` | no | block name → inventory items that satisfy it (`cobblestone: [stone, mossy_cobblestone]`); `[]` means "never blocks the build" |
| `build_order` | no (`bottom_up`) | `bottom_up`, `walls_first` (perimeter of each layer first), `inside_out` |
| `interior` | no | `[{ token, offset: {x, y, z} }]`; placed after the shell, `token` may be a map key or a raw block name |
| `anchor_y_offset` | no (0) | added to the anchor's y |

Annotated example (the starter home, trimmed to two layers):

```json
{
  "id": "cobble_hut", "category": "base", "tier_min": 1, "tier_max": 2,
  "archetypes": ["builder", "pvper", "farmer", "grinder", "ratter", "diplomat"],
  "placement": "surface", "dimensions": { "x": 7, "y": 4, "z": 7 },
  "materials": { "cobblestone": 96, "planks": 49, "wooden_door": 1, "chest": 1, "crafting_table": 1, "torch": 4 },
  "substitutions": { "cobblestone": ["stone", "mossy_cobblestone"], "planks": ["wood", "log"] },
  "token_map": { ".": null, "C": "cobblestone", "P": "planks", "D": "wooden_door" },
  "layers": [
    ["CCCCCCC", "CCCCCCC", "CCCCCCC", "CCCCCCC", "CCCCCCC", "CCCCCCC", "CCCCCCC"],
    ["CCCCCCC", "C.....C", "C.....C", "D.....C", "C.....C", "C.....C", "CCCCCCC"]
  ],
  "build_order": "bottom_up",
  "interior": [ { "token": "chest", "offset": { "x": 1, "y": 1, "z": 5 } },
                { "token": "torch", "offset": { "x": 1, "y": 2, "z": 1 } } ]
}
```

Rules the builder applies to the grid:

- **Doors are one cell in the file.** A door is two blocks tall; `_healDoorPairs`
  turns the cell directly above any door cell into the door's top half, so the
  roof pass never digs the door out again.
- **Interior entries win over air.** A chest sits in a cell the layer map calls
  air; the air entry is dropped so a resume pass does not dig the chest.
- **Rotation** is one of 0, 90, 180 or 270 degrees around the footprint
  (`_rotate`); the build tool picks the rotation whose south side faces spawn
  so doors open toward the world (`rotationTowardSpawn`). Farm blueprints put
  a `fence_gate` in the middle of the south fence for the same reason.
- **Optional blocks** never block a build or count toward completion:
  water and all seed/crop blocks (`placement.js`, `isOptionalBlock`), plus
  non-solid attach blocks such as torches and buttons (`NON_SOLID_PLACEABLES`),
  which are still attempted.

## Registry and selector

`BlueprintRegistry` (`blueprintRegistry.js`) loads every JSON once at boot,
logs `blueprints_loaded` with the count, and skips a malformed file with one
of the `blueprint_invalid_*` warnings instead of aborting.

| Method | What it does |
|---|---|
| `all()`, `get(id)` | the loaded list, one blueprint |
| `query({category, archetype, tier, placement})` | filter, sorted by total block count ascending |
| `canAfford(bp, inventory)` | `{affordable, missing}`; counts direct matches, then `substitutions`, then loose name matches (`oak_planks` satisfies `planks`); farmland is satisfied by dirt (it is tilled, never held); optional blocks are skipped |
| `materialsNeeded(bp, inventory)` | the `missing` map alone; the `blueprints` tool shows it per blueprint |

`BlueprintSelector` (`blueprintSelector.js`) is the old stack's chooser and
is not called by the agent's tools, which let the model choose from the
`blueprints` listing; it is kept because `isMaterialObtainable` and its
tests document what "obtainable" means. Its rules: resume an in-progress
build first, filter by category, archetype and tier, drop blueprints
blacklisted in the last 30 minutes (KV `blueprint_blacklist`), prefer
unbuilt over built, lower tier, surface over underground, then the cheapest
whose every missing material has a source (recipe, mineable, trivial
terrain, farmable, or producible such as farmland).

## Site survey

`surveySite` (`siteSurvey.js`) scans a `step`-pitch grid in rings around a
preferred spot, reads only `bot.blockAt`, and grades each footprint:

- every column must have ground within the scan window (10 up, 12 down) and no
  fluid; vegetation and tree blocks count as clearable, not as ground;
- ground variance across the footprint at most `maxHeightDelta` (2);
- no corner within `protectionMargin` (16) of a protected zone
  ([world-substrate.md](world-substrate.md#zones)); a footprint that touches
  the boundary gets its placements rejected;
- cost = earthwork + 0.5 × vegetation + 0.15 × distance; the scan stops early
  once a ring yields a flat, clear site.

It returns `{ anchor, ground, earthwork, vegetation, cost, scanned }` with
`anchor.y = ground + 1`, so the floor sits on the surface, and logs
`site_survey_result` or `site_survey_empty`. The `survey_site` tool exposes it;
`build` runs it itself when no anchor is given.

## The builder

`BlueprintBuilder.build(blueprint, anchor, rotation)` (`blueprintBuilder.js`)
returns a `{ stop, done }` handle; `done` resolves with
`{ placed, skipped, already_correct, missing, total, reason, skip_reasons }`.
The run:

1. **Placement list.** Layer cells (air cells included, so they get cleared)
   plus interior items, rotated, door pairs healed, deduped, then sorted by
   `build_order`; shell before interior; underground builds excavate their
   air cells first so there is somewhere to stand.
2. **Resume.** Progress is saved to KV `build_progress` every 5 cells and on
   every hard stop; a later call skips to the lowest unprocessed index and
   cells that already read correct (`_isAlreadyCorrect`, which accepts any
   substitution).
3. **Site prep.** Occupied cells that are not already correct are dug first,
   highest first (`blueprint_site_prep`, `blueprint_site_prep_done`). Digging
   never touches containers, ores, doors or valuables (`_isSiteClearProtected`)
   and never opens a cell with lava behind a face (`blueprint_dig_skip_lava`).
4. **Per cell.** Pick an item (name, substitution or loose match), find a
   standing cell, walk there (10 s pathfind budget; cells sharing a standing
   position are batched, `blueprint_batched`), equip, then place according to
   the cell's method:

   | Method (`placement.js`) | Blocks | How |
   |---|---|---|
   | `place` | everything else | `placeAndVerify` against a reference face; non-solid blocks are verified by name |
   | `till` | `farmland` | lay dirt if the cell is empty, then hoe it; waits up to 1.5 s for the block update |
   | `water` | `water` | fill a bucket at a source within 16 blocks, aim at the top face of the block below the cell, use the bucket one tick after the look packet, wait up to 1.5 s, one retry; at most 4 sources per build (one hydrates a 9×9) |
   | `plant` | seeds and crops | right-click the seed onto the farmland below; only if a seed is in hand |

   A cell with no solid neighbour to place against gets a temporary scaffold
   from cobble/dirt/netherrack/stone (`_tryScaffold`, logged
   `blueprint_scaffold_placed`), which is dug back out afterwards. The bot
   steps aside when its own body fills the cell and steps out of the
   footprint before placing floor cells.
5. **Stopping early.** Eight consecutive site-level failures
   (`server_rejected`, `protected_zone`, `cell_occupied`, `pathfind_failed`)
   abort with `reason: site_rejected` (`blueprint_site_rejected`). A run in
   which every placement failed ends with `no_progress`
   (`blueprint_build_no_progress`). The handle's safety timer ends a run with
   `max_duration` (10 minutes); the build tool stops it earlier with its own
   `max_minutes`.
6. **Completion.** `scanCompletion` re-reads every required cell from the
   world and returns `{ correct, total, pct, missing, unloaded, reliable }`;
   `reliable` is false when a chunk was not loaded, and no decision is made on
   an unreliable scan. A finished blueprint id is appended to KV
   `built_blueprints` and the progress record cleared.

`placeGuard.js` is what every placement goes through: `classifyCell`
(`air`, `replaceable`, `occupied`, `unloaded`), `entityInCell` (`self`,
`other`, null), `withinPlaceReach` (4.5 blocks), and `placeAndVerify`, which
issues `bot.placeBlock` and polls the world every 150 ms for up to 2.5 s
instead of trusting mineflayer's block-update event. Failures come back as
`self_collision`, `entity_in_cell`, `cell_occupied`, `out_of_reach`,
`protected_zone`, `server_rejected` or `unverified`.

Progress is visible in the log: `blueprint_build_start`, `blueprint_progress`
every 5 placements, a heartbeat every 15 s even when nothing lands, and one of
`blueprint_build_done`, `blueprint_build_partial`, `blueprint_build_no_progress`
or `blueprint_site_rejected` at the end. Per-cell problems log as
`blueprint_place_failed`, `blueprint_no_standing`, `blueprint_no_reference`,
`blueprint_cell_occupied`, `blueprint_entity_in_cell`, `water_*`, `till_*`.

## The build tool

`bots/agent/tools/build.js` adds the checks the model would otherwise learn
the hard way:

- **Anchor.** Explicit `x, y, z`, else the last anchor for the same blueprint
  (`state.lastBuild`), else a fresh survey around the bot; refuses within 16
  blocks of protection (`too_close_to_spawn_protection`) or with no flat site
  (`no_flat_site`).
- **Materials.** `missing_materials` before walking anywhere, unless a scan
  shows at least 5 % already built (a resume). Farms need a hoe
  (`need_hoe`) and, unless `allow_dry` is passed, a bucket (`need_bucket`),
  because water is best-effort in the builder and dry farmland reverts to
  dirt.
- **Getting there.** Walks to within 5 blocks of the anchor first;
  `site_unreachable` if that fails.
- **Result.** Adds `completion_pct` from a fresh scan, `failed_cells` with a
  `fix` hint for the most common reason (`CELL_HINTS`), `water: {placed,
  cells}` for farms, and `faction_perm_denied` (with faction and permission)
  when the nerves saw a Factions denial and nothing was placed.
- **On completion.** `homeCells` finds the door, the interior box, the chest
  and workstations; a `base` becomes `state.home` (KV `agent_home`), so
  `goto named home` and `store named home` work. `registerBaseCells` hands
  every verified solid cell to `Movement.setBaseStructureCells` so the
  pathfinder routes through the door instead of tunnelling a wall and `mine`
  never harvests the house; it declines (`base_cells_skip_no_door`) unless
  every door cell reads as a door.

Statuses map as: `done` → `ok`, `partial` and `max_duration` → `partial`
(call again with the same anchor), `no_progress` and `site_rejected` →
`failed`. See [tools.md](tools.md#build) for the schema.

## The door macro

mineflayer-pathfinder 2.4.5 cannot pass a two-block door: its `openable`
handling covers the feet cell only (right for a fence gate), so the top half
is a solid block to it and a finished house is a sealed box. Two pieces fix
that:

**`bots/core/doorPhysics.js`** corrects what the client believes.
prismarine-block's 1.8 collision table gives every door state the same
hitbox, a thin panel on the west face of the cell, so a bot walking east or
west through an open door stops dead. `installDoorPhysics` wraps
`bot.blockAt`: open gates report no hitbox, and doors report the exact panel
the server uses for their current state (`doorPanel`, from the lower half's
facing and open bits and the upper half's hinge bit, mirroring 1.8's
`BlockDoor`). It installs on `inject_allowed` because mineflayer defines
`bot.blockAt` one tick after `createBot`; the log line is
`door_physics_installed`. `doorState(lower, upper, axis)` says whether the
panel is across the doorway (`blocked`) or a rail along one side, and the
sideways `offset` of the free lane.

**`bots/agent/tools/door.js`** does the walking. `wrapMovementWithDoor`
replaces `movement.goTo` for every tool: when the bot is inside its home and
the target is outside (or the reverse), it runs `passDoor` first. The pass:

1. checks the cell behind the door is free (`inside_blocked` if a furnace or
   block was dropped there) and that there is somewhere to stand in front
   (`outside_unreachable`);
2. going in, if the floor is two or more blocks above the standing level,
   builds a one- or two-block step from dirt or cobble (`ensureDoorStep`,
   `no_step_block`);
3. stands on the approach cell, reads the panel, toggles the door once if the
   panel is across the doorway (`agent_door_geometry` logs what it saw;
   `door_stuck` if it is still across);
4. walks straight down the free lane, then to the far cell; if the walk
   stalls it toggles once more and retries (`agent_door_retry`), and closes
   the door on a failed pass so mobs cannot follow (`walk_failed`);
5. puts the panel back across the doorway and reports `{ ok, direction,
   toggles, closed, step }`; every pass logs `agent_door_pass`.

`unstick` inside the house does nothing (`inside_home`) and never digs the
bot's own walls without `force`.

## Adding a blueprint

1. Copy the closest JSON in `bots/building/blueprints/`, give it a new `id`,
   and keep `dimensions` equal to the grid (the registry rejects any
   mismatch with `blueprint_layers_y_mismatch` and friends).
2. Model doors as one cell with a solid block above; put the door on the
   south side (row index `z = dims.z - 1`) so the spawn-facing rotation
   opens toward the world; leave `fence_gate` cells out of walls.
3. List `materials` for the required cells only; add `substitutions` for
   inventory aliases (they are matching aliases, not gather recipes);
   optional water and seeds may stay in `materials`.
4. Run the building suite, which loads every JSON through the registry and
   exercises the builder against a mock world:

```bash
npm test -- building          # bots/building/test_*.js (11 files)
node bots/agent/test_agent.js # includes the build tool, door macro and water pour
node scripts/dead_code.mjs    # unchanged: blueprints are data, not imports
```

`test_build_footprint`, `test_door_pairs`, `test_completion_scan` and
`test_site_survey` are the ones a new blueprint most often breaks.

## When it fails

| Symptom | Where to look |
|---|---|
| `build` returns `missing_materials` for a farm the bot can afford | `canAfford` counts dirt for farmland and skips water; the missing map names blueprint blocks, not items |
| `no_flat_site` everywhere | `site_survey_empty` in the log: raise `radius`, or the bot stands in hills or next to protection (16-block margin) |
| every cell `pathfind_failed` | the anchor is unreachable from where the bot stands; `site_unreachable` should have fired, check the anchor's y |
| `site_rejected` with `server_rejected` | placements inside a WorldGuard region or another faction's claim; `faction_perm_denied` names the faction when BotBridge saw the denial |
| torches keep the structure below 100 % | they are not required cells; a scan that stays below 100 % is missing solid blocks, see `missing` in the result |
| door vanishes or house is sealed | `_healDoorPairs` handles the top half; a blueprint with a solid block directly above a modelled top half would still be dug; check `agent_door_pass` and `agent_door_geometry` |
| farm built but dry | `water: {placed: 0}` and `water_hint`: no source within 16 blocks, or no bucket (`allow_dry` was set) |
| the bot digs its own walls | wall cells are registered only after a verified completion with a door; `base_cells_registered` count in the log, `base_cells_skip_no_door` otherwise |
