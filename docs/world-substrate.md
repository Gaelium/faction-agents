# World substrate

`bots/world/` is the layer between mineflayer and the agent's tools: moving,
seeing, fighting, and the mining/crafting/placing primitives, plus the data
the tools reason with (recipes, prices, protected zones, faction state).
Nothing here talks to a model; every module takes a mineflayer `bot` and
returns plain objects or `{ stop, done }` handles. The tools in
[tools.md](tools.md) are thin wrappers that add the cancel token, the
uniform result shape and the hints.

| Module | Used by | Log events to watch |
|---|---|---|
| `movement.js` | every tool that walks | `path_update`/`goal_reached` are mineflayer's; the tools log the outcome |
| `perception.js` | `look`, `scan`, the nerves | none |
| `combat.js` | `attack`, the nerves' flee | `engage_begin`, `disengage`, `combat_stalled`, `combat_engagement_end`, `pot_*` |
| `primitives.js` | `mine`, `craft`, `smelt`, `place`, `dig`, `equip`, `store`, `withdraw`, `light_area`, the door step, `farm` | `mine_*`, `craft_*`, `smelt_*`, `tool_auto_crafted`, `deposit_failed`, `workstation_skip_protection` |
| `txnRetry.js` | primitives | none (reasons pass through) |
| `zones.js` | `leave_spawn`, `goto`, `build`, `mine`, the prompt | `zones_loaded_from_server`, `zones_server_truth_unavailable` |
| `minecraft.js`, `economy.js` | `craft`, `recipes`, `sell`, `inventory`, the build selector | none |
| `factions.js` | `f`, `board`, `pay`, the prompt | `balance_updated`, `balance_set_from_query`, `faction_ally_observed`, `faction_create_confirmed` |

## Movement (`movement.js`)

`new Movement(bot, { memory })` owns the pathfinder configuration; the bot
loads mineflayer-pathfinder in `core/bot.js`.

```js
const h = movement.goTo({ x, y, z }, { timeoutMs: 30000, range: 0 });  // { stop, done }
const r = await h.done;   // { reached: true } | { reached: false, reason: 'noPath' | 'timeout' | 'cancelled' | 'set_goal_error:…' }
movement.follow(entity, 3);          // dynamic goal, timeoutMs 0 = forever
movement.flee(from, 20, { timeoutMs });
movement.cancel();                   // stops whatever is running
```

`goTo` with `range` 0 targets the exact block (`GoalBlock`), otherwise
`GoalNear`. Every call cancels the previous one first, and the tools' cancel
token calls `stop()`, which resolves `done` with `cancelled`. Three or more
`noPath` answers without the bot moving raise `consecutiveNoPath`, the
signal that the bot is walled in rather than badly routed.

The `Movements` config (`_buildMovements`) is rebuilt only when something
changes:

| Setting | Value and why |
|---|---|
| `canDig` | true, but `updateDigPermission` sets it false inside or within 8 blocks of a protected zone, and a per-block break exclusion makes every protected column unbreakable for planning, so routes go around spawn instead of tunnelling and spamming denials |
| own walls | `makeBaseStructureExclusion` refuses to break any cell in the base set (see below); the door is in `blocksCantBreak` and `openable`, so the route goes through it |
| `blocksCantBreak` | chests, workstations, beds, ores, wool, logs, every door type |
| `digCost` 10, `allow1by1towers` false | prefer walking around; no pillaring (looks non-human, griefs claims) |
| `maxDropDown` 2, `allowParkour` false | short hops only; a bigger drop near a pool can carry into lava on 1.8. **Bootstrap mode** (`setBootstrapMode(true)`, used by `leave_spawn`) allows a 16-block drop and parkour so a fresh bot can leave the spawn platform |
| lava | `makeLavaExclusion`: stepping or placing onto or over lava is forbidden (weight 200); cells beside lava cost 80, so a one-wide corridor past lava is still possible as a last resort. The pathfinder would otherwise "bridge" a pool with one scaffold block, which fails on 1.8 |
| deep water | `makeDeepWaterExclusion`: water over water is forbidden from land (weight 100) and merely expensive when already swimming (20), so `unstick swim` can still path out; one-deep water is free. The pathfinder clears jump every tick on 1.8 and sinks the bot otherwise |
| scaffolding | cobblestone removed from the pathfinder's scaffold list (visible litter) |

**Own-structure registry.** `setBaseStructureCells(cells)` replaces the
protected set (persisted in KV `base_structure_cells`, re-read after a
reconnect) and re-arms wall protection; `notePlacement(pos)` records a block
the bot just placed for two minutes so an escape never digs out the block
under its own feet; `isOwnBlock(pos)` answers both. `mine` refuses to descend
from a spot on the bot's own block or within 12 blocks of home
(`too_close_to_home`), and `safeFindBlock` skips base cells.
`setBaseExclusionSuppressed(true)` is the safety valve for a bot entombed
by its own protection: the next pathfind may break a wall; a reached goal
re-arms it.

Every tool that moves gets the door macro for free
([building.md](building.md#the-door-macro)): `wrapMovementWithDoor` keeps
the original as `movement._rawGoTo`.

## Perception (`perception.js`)

`new Perception(bot, { combat })`; `read()` is a synchronous snapshot built
from mineflayer state, sized for a prompt:

| Field | Content |
|---|---|
| `position`, `health`, `food`, `heldItem`, `timeOfDay` | rounded position; `day`/`night` label from the world time |
| `nearbyPlayers` | up to 5 within 24 blocks: name, distance, compass direction, health |
| `nearbyMobs` | up to 5 within 16 blocks, hostile set flagged (zombie, skeleton, creeper, spider, witch, slime, enderman, …) |
| `nearbyBlocks` | which of the interest types exist within 8 blocks: water, lava, chests, workstations, wheat, cactus, sugar cane, ores |
| `isUnderground`, `inventorySummary` | roof over the head; weapons, armor, food count, block count, tools |
| `combatState`, `pathfinderState` | whether a fight or a path is running |
| `recentChat` | the module's ring buffer (5 lines, 60 s window). Nothing feeds it any more: `feedChat` has no caller in the agent loop, so this list is always empty; the nerves keep their own chat |

The `look` tool reads this snapshot and adds the spawn-protection state;
`scan` runs block searches by name through `bot.findBlock`.

## Combat (`combat.js`)

`new Combat(bot, { profile, log, movement, bus })`; `engage(entity)` starts
a fight, `disengage(reason)` ends it, `fleeIfLow(movement)` disengages and
flees 24 blocks when health is at or below `flee_at_hp`. The `attack` tool
calls these and is shielded from mob and player damage interrupts so a hit
never hands control back to the model mid-swing; lava, fire and drowning
still interrupt.

Rules are 1.8's, not later versions': no shields (the only block is a sword
right-click, about half damage), no offhand, no attack cooldown (the cap is
the 20 Hz tick), no axe-specific critical hits (jump crits apply to every
weapon and are not modelled). Axes are preferred by some profiles for their
higher base damage and mcMMO's armor-impact, at the cost of not being able
to block-hit while held.

Per-profile knobs (`profile.combat`, see [profiles.md](profiles.md)):
`reaction_ms_min/max` (delay before the first swing), `aim_error_deg`
(gaussian aim noise), `aim_lag_ms` (the bot aims at where the target was,
from an 8-sample buffer, so evasive players produce real misses), `cps`,
`block_hit_rate` (sword only), `pot_at_hp` and `pot_success_rate`
(golden apple or potion), `combo_follow_rate` (sprint reset after a hit),
`flee_at_hp`, `preferred_weapon`. The header of the file lists presets per
skill tier.

Combat ticks on its own `setInterval`, not mineflayer's `physicsTick`,
because mineflayer silences `physicsTick` whenever the position has a
non-finite axis or the chunk under the bot is unloaded, both routine during
knockback; a listener-bound tick would stop swinging exactly when it matters.
Movement toward the target has a deadband around the 3.6-block reach so the
controls do not flicker every tick. Each fight ends with one
`combat_engagement_end` record: opponent, outcome (`win`, `loss`,
`disengage`, `draw`), duration, hp left, hits landed and taken, weapon.

## Primitives (`primitives.js`)

Every primitive returns `{ stop, done }`; `done` resolves with
`{ success, reason, ...extra }` and never rejects (a thrown error becomes
`reason: "exception:<msg>"`, the handle's safety timer `max_duration`,
`stop()` gives `cancelled`). The tools convert this to their result shape
with `fromPrimitive` and add progress: a `mine` that got 5 of 16 is
`partial`, not `failed`.

| Export | Tool | What it does |
|---|---|---|
| `countInventory(bot)` | many | `{ name: count }` of the inventory |
| `targetSubmerged(bot, pos)`, `standingWouldDrown(bot)` | `look`, `mine` | water-column checks that keep the bot out of drowning spots |
| `safeFindBlock(bot, name, maxDistance, yRange, drownSpots, baseCells)` | `mine`, `withdraw`, `light_area`, crafting-table lookup | `bot.findBlock` with the safety filters: not inside a protected zone, no lava behind any face, not submerged, not a known drowning spot, not an own base cell; `log`/`log2` and `dirt`/`grass` are aliases |
| `mineBlock(bot, { blockName, count, maxSearchRadius, yRange, targetY, finishVein })` | `mine` | find, walk, equip the right tool (crafting a wooden or stone one from what is carried, `tool_auto_crafted`), dig, collect; ore and stone targets descend to a target y with a floor of 12 (`MIN_MINING_Y`, the lava-lake level); after an ore block, `mineConnectedVein` clears the whole vein up to 32 blocks; when the inventory is full, junk (dirt, gravel, sand, cobble variants, flint, rotten flesh, leaves) is dropped keeping 8 placeable blocks for emergencies, else `inventory_full`; skips cells with lava behind a face (`mine_skip_lava_adjacent`), submerged cells, protected zones; wanders in steps when nothing is found and resolves `block_not_found` |
| `craftItem(bot, { recipeName, count })` | `craft`, and `smelt`/`mine` for tools | resolves the recipe from `minecraft.js` and mineflayer, walks to or places a crafting table, crafts through `withTransactionRetry`; the mixed-plank rescue crafts a same-wood batch of planks from any log when 1.8's metadata-strict recipe rejects mixed planks (`craft_plank_variant_rescue`); reasons `missing_ingredients`, `unknown_recipe`, `no_crafting_table_placed` |
| `smeltItem(bot, { itemName, count, fuel })` | `smelt` | places or finds a furnace, loads input and fuel (`FUEL_VALUES`; mines coal when short, `smelt_auto_mining_fuel`), waits, takes the output; `not_enough_input`, `not_enough_fuel`, `no_furnace_placed` |
| `placeWorkstation(bot, itemName, log)` | `craft`, `smelt`, `jobs` | puts a crafting table or furnace on a solid cell beside the bot, trying each cardinal direction, never inside protection |
| `placeBlockAt(bot, { position, blockName })` | `place`, `light_area`, the door step | one block at one cell through `placeGuard.placeAndVerify`; `no_reference_block`, `cell_occupied`, `entity_in_cell`, `place_failed` |
| `digBlockAt(bot, { position })` | `dig` | one cell, with the lava, protection and own-wall checks (`protected`, `cant_dig`, `lava_adjacent`) |
| `equipItem(bot, { itemName, destination })` | `equip`, `wear_armor` | hand or armor slot, through the transaction retry |
| `storeItems(bot, { items, chest })` | `store` | opens the chest and deposits, `deposited` per item; `no_chest`, `deposit_failed` |

**Transactions on 1.8** (`txnRetry.js`). Every window click (crafting
grid, equipping, chest deposit) is a transaction the server may reject, and
mineflayer then diverges from the server's view of the inventory. `withTransactionRetry(bot, fn, { verify })` retries only transaction errors
(`isTransactionError`), drops the stale cursor and waits for the server's
`set_slot` between attempts (`recoverInventoryState`), and trusts only the
caller's `verify` postcondition, never the presence or absence of a throw.
Genuine failures such as `missing_ingredients` pass straight through.

**Stalls.** The `mine` tool wraps its handle in `withStallWatchdog`: 90 s
with no inventory change stops the primitive and reports `no_progress`
instead of waiting out the whole time budget.

## Zones (`zones.js`)

Server-enforced protection the bot must not build, dig or mine in. Three
shapes: a circle `{ center, radius }`, a WorldGuard cuboid
`{ min, max }`, and Factions chunk claims `{ chunks: ['cx,cz', …] }`.

| Function | Use |
|---|---|
| `loadServerZones({ serverDir })` | at boot, reads `plugins/WorldGuard/worlds/world/regions.yml` and `mstore/factions_board/world.json` (only `warzone` and `safezone` claims; player claims are politics, not protection) and installs them, logging `zones_loaded_from_server` with the list; with neither file readable it keeps the built-in circle (radius 200 around 420, 220) and warns `zones_server_truth_unavailable` |
| `isInProtectedZone(pos)`, `isNearProtectedZone(pos, buffer)`, `findProtectedZone(pos)` | every placement, dig and block search; `Movement.updateDigPermission` |
| `pushOutsideProtection(pos, padding)`, `pushClearOfProtection(pos, buffer)` | `leave_spawn`'s exit target (the second handles a bot that spawned just outside the box but inside the margin, which once produced thousands of zero-length hops) |
| `describeProtectedZones()` | the prompt's zone paragraph |
| `setProtectedZones(list)`, `getProtectedZones()` | tests and manual overrides |

Where the files come from and what to do on a new world is in
[server.md](server.md).

## Data modules

**`minecraft.js`** is pure data for 1.8.9, all frozen: `RECIPES` (item →
ingredients, required tool, output count; furnace recipes carry a smelt
time), `INGREDIENT_ALIASES` and `countIngredient` (a `log` recipe accepts
`log2`, so acacia counts), `TOOL_REQUIREMENTS` (block → minimum tool),
`BLOCK_HARDNESS`, `SMELTABLE`, `FUEL_VALUES` (items smelted per fuel item),
`FARMABLE_CROPS` and `WILD_CROP_SOURCE`, `GEAR_TIERS`, `SPECIAL_BLOCKS`
(things that are neither crafted nor farmed, with how to obtain them). The
`recipes` tool and the build selector read it; `craft` and `smelt` use it to
decide what is possible before touching mineflayer.

**`economy.js`** is the selling policy: `RESERVES` (what to keep before
`/sell hand`: crops sell out, 64 cobble, 64 iron ingots, diamonds never),
`MIN_SELL_STACK` (16), `BUILD_MATERIALS` (held back while a build is
active), `computeSellable(inventory, { buildActive, buildNeeds })` and
`totalSellableSurplus`. The `sell` tool applies it; prices themselves come
from the server's `worth.yml` through `bots/agent/prices.js`.

**`factions.js`** keeps one bot's faction state persistent and in step
with the server. `new Factions({ profile, memory, log })` loads
`state` (`ourFaction`, `foundedAt`, `allies`, `enemies`, `memberships`,
`balance`) from the SQLite KV key `faction_state`; the `f` and `board`
tools mutate `state` directly and call `_persist()`. `_wireBus(bus)`
follows BotBridge events: `economy_transaction` keeps a running balance
tally (`balance_updated`, corrected by every parsed `/balance` and board
query through `setBalance`), `faction_event` records observed ally/enemy
relations and confirms the bot's own `create`
(`faction_create_confirmed`). Commands are issued by the tools, not here;
see [botbridge.md](botbridge.md) for the events.

## Doors, fences and water

- **Door physics** (`bots/core/doorPhysics.js`): prismarine-block's 1.8
  table gives every door state one hitbox, a panel on the west face, so open
  doors block east-west walks. The module tells the client the panel the
  server actually uses for the door's facing, hinge and open bits, and clears
  the hitbox of open gates. Details and the walking macro are in
  [building.md](building.md#the-door-macro).
- **Fence tops.** A bot standing on a fence, wall or gate (1.5 blocks tall)
  has no pathfinder move at all and every `goto` times out. `unstick` detects
  it (`on_fence`) and steps off onto a neighbouring free cell
  (`unstick_off_fence`); the `farm` tool reaches plot cells from 3 blocks away
  so the outer rows are worked from outside the fence, and farm blueprints
  carry a gate.
- **Water.** A bucket only fills from a source block (metadata 0) while the
  bot stands on a dry cell beside it; the use-item packet must go out two
  ticks after the look packet or the server ray-traces with the old heading
  (`_fillBucketAt`). Pouring aims at the top face of the block below the
  target, because 1.8 pours where the look ray hits, then waits up to 1.5 s
  for the block update (`_placeWaterCell`, mirrored by the `place water`
  tool). Deep water is avoided by the pathfinder (above) and escaped by
  `unstick swim`, which holds jump until the head is clear and swims to the
  nearest shore; drowning damage does not interrupt that swim.

## Tests

```bash
npm test -- world             # bots/world/test_*.js: dig protection, gapple eat, lava bridge,
                              # own-structure exclusion, plank rescue, spawn protection,
                              # submerged target, transaction retry, vein mining, zones, minecraft, economy
node bots/agent/test_agent.js # door physics against prismarine-physics, the tools over stub bots
```

All of them run against mock worlds; none needs a server or an API key.
