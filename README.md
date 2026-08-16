# Voxel Editor

A Minecraft-style voxel engine + map editor that runs entirely in the browser,
offline, from a single `index.html` — no server, no build step to play.

Voxels come in two sizes: **small (0.5 m)** for half-walls and fine detail, and
**big (1 m)** for standard blocks. Big voxels always align to the 1 m grid.

## Quick start

1. **Play:** open `index.html` (the editor) or `game.html` (the playable game).
   That's it. Each loads a prebuilt single classic script from `build/`, so
   both work from `file://`. (The editor persists through the dev server —
   `npm run server` — so run it there to save your work; the game is fully
   offline.)
2. **Develop:** edit the ES modules in `src/`, then run `npm run build` to
   regenerate `build/game.js`, and `npm test` to run the unit + editor tests.

## The game

**Maro 93.** Poland, 1993. The communists are gone and the country has dived
head-first into capitalism — kiosks, bazaars, imported junk, everyone
hustling. Maro is 45: ex-military, ex-mercenary, spent the PRL years hunting
communists in the shadows. He thought that chapter was over. Then the dead
started walking, and the transformation nobody signed up for arrived anyway.

**Setting:** the game takes place in Poland in the early-to-mid 1990s —
post-communist concrete estates, bazaars, kiosks and crumbling industry set
the visual tone for maps, blocks and decals.

Alongside the editor there is a playable game page (`game.html`, built to
`build/game-play.js`) that runs your world. Everything the editor authors is
**file driven** — it lives in `map/voxelbundle.json` (written via the dev
server), so the game picks up the latest map and objects after a refresh with
no browser storage in between.

- **Main menu:** **New Game** loads the current editor world (falling back to
  the bundled world) and spawns you at the map's spawn point.
- **Walk around:** `W A S D` move, `C` crouch, mouse to look
  (pointer-locked). Same physics/collision as the editor's F5 test run.
- **Player stats:** health (0–100) and armor (0–100), shown as bars in the HUD.
  Armor absorbs 60% of incoming damage first, the rest hits health.
- **Equipment:** four slots — primary, secondary, extra, injection — shown in
  the HUD. Select a slot with `1`–`4`. An empty slot means you fight with
  **fists**; `LMB` attacks with whatever is in hand (a melee swing — blocks are
  not destructible). `F` uses the injection if one is equipped (heals, consumes
  it).
- **Storage containers:** in the editor, click a placed object and tick
  **Storage container** — in game `E` opens its stash: a grid like the
  backpack (`B`) where you click or drag items and whole material stacks
  between the container, your backpack and your equipment slots (drop a stored
  weapon straight onto a slot to equip it). Contents ride with the save slots,
  so furniture in your base works as a persistent hoard.
- **Save / Load (3 slots):** `Esc` opens the pause menu with three slots. A
  save snapshots the whole world (map + objects) plus your position/orientation
  **and** health/armor/equipment and every storage container's stash, so
  loading a slot restores exactly what was saved. Slots live in `localStorage`
  under `voxelgame.save.0..2`.

To share data between the editor and the game, run both off the dev server:
`npm run server`, then `http://localhost:4173/index.html` (editor) and
`http://localhost:4173/game.html` (game). Both read and write the same
`map/voxelbundle.json`, so a save in the editor shows up in the game on
refresh. Only the player's save slots stay in the browser (`localStorage`),
since a deployed static build has no filesystem to put them in.

## Shipping a map with the game

The editor is **fully file driven**: the world (map + placeable objects,
equipment, NPCs and quests) lives in `map/voxelbundle.json` and the editor
reads/writes it through the dev server — there is no `localStorage` shadow
copy, so nothing desyncs across browsers or after a deploy.

1. **Run the dev server:** `npm run server`, then open `http://localhost:4173`.
   The editor autosaves as you work (debounced) and `Ctrl+S` / **Save File**
   write immediately.
2. Build your map + objects in the editor.
3. Run `npm run build`, then deploy `index.html` + `build/` (+ the rest of the
   repo) as usual.

On startup the editor loads the world from the server file; a fresh checkout
without one falls back to the build-baked bundle, then the seeded ground. The
game loads the live world file when served, else the bundle embedded at build
time — so a fresh deployment is your authored map: blocks, placed objects,
catalogue, spawn and all.

### The editor server

`server.mjs` is a dependency-free Node server that serves the game over HTTP
and exposes a tiny filesystem API the editor uses to read/write the world file
directly on disk:

| Route | Method | Purpose |
|---|---|---|
| `/` and any static path | GET | serve `index.html`, `build/game.js`, etc. |
| `/api/world` | GET | read `map/voxelbundle.json` |
| `/api/world` | PUT | write the editor's world + objects to `map/voxelbundle.json` |
| `/api/worlds` | GET | list the world library (`map/worlds/`) as a tree |
| `/api/worlds/<path>` | GET / PUT / DELETE | read / write / delete a library world (folders delete recursively) |
| `/api/worlds-ops` | POST | `{op:'mkdir', path}` or `{op:'move', from, to}` — organize the library |
| `/api/splash` | GET / PUT | read / write `map/splash.json`, the menu's splash-screen manifest |
| `/api/editor-state` | GET / PUT | read / write `map/editor.json` (which library world is open) |

`node server.mjs [port]` (default `4173`). The API is only reachable over
http(s). The editor always runs on this server (it is never deployed); without
it edits stay in memory and Export/Import is the manual persistence path. The
game is static-friendly: with no server it plays the world baked into the
build. Later the game reads the same `map/voxelbundle.json` (via the build or
the server) to simulate the authored world.

### The world catalogue (Worlds button, `F7`)

**Worlds…** in the sidebar opens a tree browser over `map/worlds/` for building
more than one map — campaign levels, splash-screen scenes, sandboxes. Save the
current world under a name (into the selected folder), load one with a click,
create folders, rename inline (**Ren**), and drag a world onto a folder — or
onto the heading for the root — to move it. Deleting is a two-step confirm;
deleting a folder removes everything inside it. The library lives on disk, so
it needs the dev server (`npm run server`); worlds are ordinary
`voxelbundle.json` files you can also commit, diff and copy around.
`map/voxelbundle.json` stays the deploy target: **Save** still decides what
ships as the playable world.

### Splash screens (F8)

The game's main menu plays a camera shot over a world instead of a static
image. Shots are authored in the editor: fly the editor camera into a nice
angle and press `F8` — the pose is stored **in the world** as a splash camera
(a small cyan camera gizmo marks it; `Shift`+`F8` deletes the nearest one
within 10 m). When the world is saved in the library, `F8` also registers the
shot in `map/splash.json`. The menu then plays each shot for ~3 seconds and
cuts to the next, picked pseudo-randomly (a shuffle bag: every shot appears
before any repeats, and the same shot never plays twice in a row). Clicking a
camera gizmo in the editor opens its **motion picker** — Orbit (slow circle
around the framed spot, the default), Static (subtle sway), Zoom out or Zoom
in. With no authored shots the menu falls back to the procedural flyover over
the current map.

While developing, the menu fetches splash worlds live from the server — a
fresh `F8` shows up on the next menu visit without a rebuild. For deployments,
`npm run build` runs `tools/pack_splash.mjs`, which inlines the referenced
worlds into `map/splashpack.json` and bakes it into `build/game-play.js`, so
static hosting shows the same shots.

## Controls

| Input | Action |
|---|---|
| Click the canvas | Lock the pointer |
| `W` `A` `S` `D` | Move on the camera plane |
| `Space` / `C` | Up / Down |
| `Shift` | Sprint |
| Mouse wheel | Adjust move speed |
| Left click | Place the selected block |
| Right click | Remove the block under the cursor |
| `Right click` (hold) + sweep | Erase every block the crosshair moves onto; the whole sweep is one undo step |
| `Shift` + `Right click` | Erase a straight line from the last removed voxel |
| Middle click | Pick the block under the cursor (sets the current block + size) |
| Left click on a door | Open the door's settings: lock/unlock it, gate it on a game flag (it stays locked until a quest raises the flag — see the quest editor's Flags fields), and pick which jamb it hinges on and which way it swings. Every door draws an architectural plan arc showing that choice (red when locked). `Shift` + left click builds there instead |
| `Shift` + `Left click` | Draw a line from the last placed voxel |
| `Tab` | Hold for the radial tool selector (release to pick); tap to cycle |
| Paint tool: `Left click` (hold) + sweep / `Right click` (hold) + sweep | Repaint every block face the crosshair crosses with the selected block's texture / strip them back to their own (see **Face paint** below) |
| `Left click` (hold) + drag | Square tool: start on a voxel, drag, release to place. Orientation follows the camera — look down for a horizontal square, look forward for a vertical one; it can extend into empty space from the starting voxel |
| `Right click` (hold) + drag | Square tool: erase a rectangle on the clicked voxel's layer, release to apply (one undo step) |
| Spawn tool: `Left click` / `Right click` | Place/move the player spawn point / clear it |
| `1`–`9`, `0` | Select block or placeable object (10-slot hotbar) |
| `B` | Toggle 0.5 m / 1 m voxel size |
| `R` | Rotate the selected placeable object 90° around its vertical axis |
| `E` | Open inventory — hover a block **or placeable object** and press `1`–`9`/`0` to assign it to that hotbar slot; click to select it directly |
| `I` | Open the **item catalogue** — browse, place, edit, export or delete saved objects |
| `F7` | Open the **world catalogue** — save, load and organize worlds in `map/worlds/` (see above) |
| `F2` | Item editor — build a placeable object from colored micro voxels (see below) |
| `F5` | Toggle **test run**: walk at the player spawn (`C` crouch, `Space` idle) |
| `F8` / `Shift`+`F8` | Capture the current view as a **menu splash screen** / delete the nearest splash camera |
| `P` | Toggle the **polaroid filter** — bloom on bright lights + film grain, vignette and faded print colors |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | Undo / Redo (last 10 actions) |
| `Ctrl`+`S` | Save the world to `map/voxelbundle.json` |
| `Ctrl`+`Alt`+`N` | **New world** — discard the open world and start on bare ground (press twice to confirm) |
| `Ctrl`+`O` / `Ctrl`+`E` | Load a `.json` map or bundle from disk / export the map as `.json` |
| `` ` `` | Hide / show the sidebar |
| `Esc` | Release the pointer |

### The sidebar

Every editor action lives in the left sidebar, grouped **World** (New, Worlds…,
Save, Load file…, Export), **Edit** (Undo/Redo), **Libraries** (Items…,
Prefabs…, Object editor, Equipment, NPCs & quests) and **Play** (Test run);
each button shows its shortcut. The card at the top names the world open from
the catalogue, with an amber dot while there are unsaved edits. Pinned to the
bottom is the **inspector** — block in hand, size, tool, camera position, fly
speed, FPS and the world's voxel/object/mob/NPC counts. `` ` `` collapses the
whole panel to a chevron for a clean view of the world.

**New** empties the world and drops the catalogue link, so the next save can't
silently overwrite the world that was open; it keeps the item, equipment and
NPC catalogues, which are the author's toolbox rather than part of one map.
It takes two presses to fire.

**Save** writes the world **plus** its objects straight to
`map/voxelbundle.json` (the editor also autosaves as you work), **Load file…**
reads a `.json` map or `voxelbundle.json` back, and **Export** downloads a
plain `voxelmap.json`.

## Item editor (F2)

`F2` switches to the **placeable object editor** — its own clean scene (solid
dark background, no day/night cycle, no world terrain). An 8×8×8 build grid
floats above the world origin, and its **bottom face is gridded** into the
8×8 micro-voxel columns (scaling with the item size), so the canvas "floor" is
always visible. The grid's X/Z centre lines and a green vertical axis mark the
world's centre axes, so you always know where the object is aligned. You build
a small voxel sculpture out of colored micro-voxels, then save it.

**Saving is handled by the editor.** `Save` (or `Ctrl`+`S`) adds the object to
the **item catalogue** — persisted in the world file (`map/voxelbundle.json`)
and listed in the inventory's *Placeable Objects* — without producing a
separate file. The catalogue
(the sidebar's **Items…** button / `I`, or **Catalogue** in the item editor) lets you
browse saved objects, click one to place it, **Edit** it back into the item
editor, **Export** it to a `voxelitem.json` file when you want to share it, or
**Delete** it (which also removes any copies already placed in the world). Item
files can be re-imported into the catalogue via **Import item file**.

To place a saved object in the world, open the inventory (`E`) and click it
under **Placeable Objects**, or assign it to a hotbar slot (hover it, press a
number) and use that slot key. Then `LMB`/`RMB` places/removes it like a block.
Press `R` to rotate the selected object 90° around its vertical axis before
placing — the preview and the placed copy show the rotation, and each copy in
the world keeps the rotation it was placed with (saved in the map file).
`R` works for blocks too: with a block in hand it spins the pending voxel's
textures in quarter turns (rotate a road marking, a crack, wood grain...) —
the top face rotates, side tiles swap around the block, the shape never
changes. Placed rotations persist in the map file (an additive `rotation`
field, omitted when 0) and middle-click picking copies a block's rotation
along with its type and size. The
item placement tool shows a translucent preview with a green/red footprint
box. Items occupy their footprint (blocks can't be placed through them), render
as independent colored meshes (not chunk geometry — coplanar micro-voxel
faces are greedily merged into rectangles, so furnished rooms stay cheap),
are **lit by the same light engine as chunks** (per-vertex sky/block light, so
they darken in sealed rooms and at night), and are saved in the map file. Placing or removing a
light-emitting object **bakes its light into the surrounding chunks
immediately** — no rebuild delay.

Each object has a world footprint: **small (0.5 m)** or **big (1 m)** — pick it
with `B` or the Size buttons. The micro-voxels scale to fit, so a big object
has chunkier voxels. The object can also be a **light source**: enable it with
`L`, pick a light color and a strength in game meters (0.5–7.5 m). Placed
lights feed the block-light channel, so they genuinely brighten the world.

Objects are either **Blocking** (default) or **Traversable** — set it with the
Collision buttons (or by re-editing the object). Blocking objects are solid in
test run (F5): the player collides with their footprint, so use them for walls,
rocks and furniture. Traversable objects let the player walk straight through —
use them for rugs, signs, plants and other props. Changing the setting is
saved with the object, and every copy already placed in the world updates
immediately.

Both editors share a tool strip (one active tool at a time — the status bar at
the bottom of the panel always shows the active tool and what the mouse will
do), an inline palette with a custom color picker + recent colors, camera view
presets (Front / Side / Top / Iso) and a live isometric preview thumbnail.

| Item editor input | Action |
|---|---|
| `LMB` drag / `MMB` drag / wheel | Orbit / pan / zoom the camera |
| `LMB` click | Apply the active tool (Paint by default) — aiming at a placed voxel the ghost sticks to the face you're looking at (red when blocked); aiming at empty space paints the deepest cell along your aim, so a fresh grid fills from the back toward you |
| `RMB` click | Always erases the voxel under the cursor |
| `MMB` click | Pick the color of the voxel under the cursor |
| `Shift`+`LMB` drag | Stroke of the active tool (paint or erase); `Shift`+`RMB` drag always erases a stroke |
| `P` / `E` | Paint / Erase tool (a tool's key again returns to Paint) |
| `V` | Box tool — click two corners to fill a cuboid (`RMB` erases the box, `Esc` cancels the pending corner) |
| `F` | Fill tool — click to recolor the connected same-color region |
| `X` | Mirror painting across the volume centre (off → X → Z → XZ) |
| Arrow keys | Nudge the whole model in X/Z (`Shift`+`↑`/`↓` moves it up/down) |
| `1`–`9`, `0` | Quick-select a palette color (palette strip + custom color input in the panel) |
| `L` | Light source settings (on/off, color, strength) |
| `B` | Toggle the object's world size (0.5 m / 1 m) |
| Collision buttons | Blocking (solid in test run) vs Traversable (walk-through) |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | Undo / redo micro-voxel edits |
| `Ctrl`+`S` | Save the object to the item catalogue (no file) |
| `Catalogue` | Browse, edit, export or delete saved objects |
| `F2` / `Esc` | Back to the world editor (`Esc` first cancels the box corner / returns to Paint) |

### Equipment build volumes (F3)

The F3 items editor sculpts inside a per-item **build volume** (`grid`,
default 8×8×8 cells at a fixed 6.25 cm cell) instead of one fixed size. The
Volume presets cover the common silhouettes — Sidearm 8×8×8 (0.5 m), Long gun
8×8×16 (1 m — shotguns, rifles), Spear 8×8×24 (1.5 m), Axe 8×16×8 (1 m tall) —
and the Cells steppers allow any 4–32 cells per axis (Z is the direction the
weapon points). Like the prefab editor, the ◧/◨ toggles beside each stepper
pick which wall a resize moves (the sculpture stays anchored to the still
wall) and **Crop** shrinks the volume to the painted voxels; a shrink the
content wouldn't survive is refused, never silently cropped. Held-item
rendering is grip-relative, so long weapons aim, fire and swing correctly;
old item files without a `grid` load as the classic 8×8×8. The F3 editor also
has Grip (`G`) and Muzzle (`M`) tools plus `R` to rotate the forward
direction.

Placed in the world, an equippable item takes its **resting pose**: the art
is cropped to its painted voxels and laid flat on the surface (its thinnest
axis turns upright — a pistol lies on its side), and its footprint follows
that pose. Aiming at it in the game draws a shader halo around the item's
silhouette; `E` picks it up.

### Moving art between the two catalogues

Objects (`F2`) and equippable items (`F3`) are the same art — colored
micro-voxels on the same 6.25 cm lattice — in two different envelopes, so a
sculpture can be sent either way without rebuilding it. Every catalogue card
carries the transfer button:

* **To Items** (Object Catalogue) copies a placeable object into the equipment
  catalogue as a **quest item**, so a piece of scenery — a veg box, a toolbox —
  becomes something the player can be sent to fetch. The build volume shrinks
  to the sculpture's bounding box, which then sits centred on the volume floor;
  open it in `F3` to change the kind (weapon / ammo / armor / material), set the
  grip and tune the stats.
* **To Objects** (Equipment Catalogue) copies an equippable item into the object
  catalogue as a blocking prop on the smallest whole-cell footprint that holds
  it — a way to dress a scene with the weapons and gear you already sculpted.

Both directions **copy**: the original stays in its own catalogue and the copy
gets a fresh id, unique across both (world placements resolve ids in one shared
space). What the other side cannot express is dropped, and the toast says so —
an object's light has no equipment equivalent, and a shape longer than the
32-cell equipment volume is cropped to fit.

To place a saved object in the world, open the inventory (`E`), click it under
**Placeable Objects**, then `LMB`/`RMB` places/removes it like a block. The
item placement tool shows a translucent preview with a green/red footprint box.
Items occupy their footprint (blocks can't be placed through them), render as
independent colored meshes (not chunk geometry), and are saved in the map file.


## Prefabs (F6)

Prefabs are reusable buildings: a bounded box of world blocks, placed objects,
decals and face paint that you build once and stamp anywhere. `F6` (or the **Prefabs**
button) opens the library; each card shows a screenshot thumbnail, the build
volume in meters and the content size.

**Building one.** *New Prefab* (or *Edit* on a card) swaps the editor onto a
scratch volume: the current world is stashed in memory, a concrete baseplate
appears under a cyan wireframe of the build volume, and every world tool works
exactly as usual — blocks, the square tool, decals, placed objects, undo. The
panel on the right holds the name and the volume's W×H×D cell steppers; grow
or shrink them at any point (shrinking refuses while content would stick out,
so a save can never silently clip your build). Each stepper is flanked by two
side buttons (`◧`/`◨`) picking WHICH wall the number moves.

**Resizing by hand.** `Tab` → **Resize** turns the six sides of the cyan box
into grab handles. Aim at a side (it lights up), hold `LMB` and pull: the wall
tracks the mouse along its own axis with an orange ghost box showing where it
lands, the panel counting the cells live. Release commits, `RMB` cancels.
Pulling a min wall (−X/−Y/−Z) grows the volume that way and slides the whole
build — and the camera — by the same amount, so the box's corner stays at the
origin while, on screen, only the wall moves. A wall stops where the content
starts, so a pull can never cut a block off. Every resize, dragged or typed, is
ONE history entry: `Ctrl+Z` puts the volume, the content and the view back.
The baseplate is scaffolding —
anything below y=0 never saves. `Ctrl+S` or *Save* writes the prefab to the
server library (`map/prefabs/<id>.json`) together with a thumbnail framed on
the content; `F6` goes back to the world, asking first when there are unsaved
changes.

**Stamping one.** Click a library card and the Prefab tool arms with a
translucent full-mesh preview (built by the regular chunk mesher, so it looks
exactly like the pasted result). The content footprint centers on the
crosshair and stands on the clicked face; `R` spins it in quarter turns —
block texture rotations, door footprints, item yaws and decal faces all turn
together. The outline is green when the area is free and orange when some
cells are occupied; `LMB` stamps (occupied cells keep their existing content,
the skipped count is reported), `RMB` puts the prefab away. A paste is ONE
history entry — `Ctrl+Z` removes the whole building.

The on-disk format (`format: "voxelprefab"`) mirrors the map file's entries
(`PrefabSerializer.js` / `PrefabStamp.js`); `server.mjs` serves the library
under `/api/prefabs`. Cards also Export/Import prefab `.json` files for
sharing, and `tools/make_kiosk_prefab.mjs` shows how to author one from a
script.

## Test run

`F5` drops a walk controller at the player spawn (feet at the bottom of the
spawn cell). Gravity and AABB-vs-voxel collision come from the pure engine
module `src/engine/Physics.js`; the player walks flat on the camera-yaw plane,
`C` crouches (only stands back up when there is headroom), there is no jump or
sprint, and small 0.5 m blocks are climbed automatically — as a
smooth rise over `CONFIG.player.stepClimbTime` seconds rather than an instant
snap. The player box is exactly one cell wide (`halfWidth: 0.25`) so it fits
flush against walls and 0.5 m steps without clipping, which keeps auto-step
reliable. Test run is **walk-only**: clicks are ignored, so you can't place or
remove blocks/objects while playtesting. `F5` again restores the editor camera
and UI. If no spawn point is set, you spawn above the world-center column (or
`[0, 4, 0]` in an empty world), bumped up until the standing box fits. Player
dimensions and physics tunables live in `CONFIG.player` in `src/config.js`.

## Architecture

The internal grid unit is one **small cell = 0.5 m**. A big voxel is a 2×2×2
block of cells anchored at even coordinates; the mesh builder expands it into a
1 m cube automatically.

```
index.html                 editor entry; UI overlay + loads build/game.js
game.html                  game entry; loads build/game-play.js (no server needed)
server.mjs                 dev/deploy server: static files + /api/world (filesystem access)
map/voxelbundle.json       the world + objects shipped with the game (edited via Save File)
src/
  game/
    GameApp.js             playable game: reads the world file/bundle, walk, stats, attack, save/load
    PlayerStats.js         PURE player model: health/armor, 4 equipment slots, damage/heal
    weapons.js             PURE attack profiles (fists default + equipped items)
    SaveSlots.js           PURE 3-slot save/load (world snapshot + player + stats)
    gameMain.js            thin bootstrap for game.html
  App.js                   composition root (construction, input, restore, loop)
  GameLoop.js              rAF loop with clamped delta
  PersistenceService.js    save/load/export (files + bundles + server API; no localStorage)
  bundledWorld.js          embeds map/voxelbundle.json into the build
  config.js                central tunables (camera, controls, history depth)
  engine/
    Space.js               single source of world-unit constants + transforms
    World.js               sparse voxel store, dirty-chunk tracking, chunk index
    LightField.js          PURE dense sky/block light field (typed arrays, heightmap,
                           full recompute + bounded incremental re-flood)
    chunkShader.js         custom ShaderMaterial for lit chunk meshes
    VoxelShape.js          data-driven size -> span/parity rule
    VoxelTypes.js          data-driven block registry
    VoxelRaycaster.js      DDA grid traversal (re-exports Space)
    Physics.js             PURE AABB-vs-voxel collision (test-run movement)
    ChunkMeshBuilder.js    PURE meshing: culling, big-voxel expansion, AO, light
    ChunkMesh.js           three.js mesh wrapper for one chunk
    Renderer.js            scene/camera/lights + chunk mesh cache
  textures/
    TextureAtlas.js        PURE procedural tile generator + atlas builder
    AtlasTexture.three.js  three.js texture adapter (kept separate for purity)
  editor/
    EditorState.js         observable selection state (block id + size)
    History.js             capped undo/redo stack (Command objects)
    commands.js            Place/Remove/MultiPlace command factories
    Tool.js / ToolRegistry.js   tool interface + registry
    tools/
      BuildTool.js         place/remove + Shift-line drawing
      SquareTool.js        drag rectangle on the clicked face's plane
      CubeDeleteTool.js    pick two corner voxels, delete the cuboid between them
      SpawnTool.js         place/move/clear the player spawn point
      ItemTool.js          place/remove registered placeable objects
      PaintTool.js         sweep-repaint block faces with another block's texture
    items/
      MicroVoxelEditor.js  shared editor core: orbit camera, painting, undo, box/mirror/fill tools
      microOps.js          PURE grid ops (mirror, box, flood fill, translate)
      ItemEditor.js        F2 object editor: size / collision / light aspect
      EquipmentEditor.js   F3 equipment editor: grip / muzzle / stats aspect
      itemSwatch.js        2D iso previews for the inventory
    itemPick.js            raycast that also hits placed items + player-collision facade
    ItemRenderer.js        meshes + lights for placed items
    ItemGeometry.three.js  three.js adapter for the pure item geometry
    Input.js               single input dispatcher + held-key tracking
    Keybindings.js         declarative keybinding table
    ToolRing.js            Tab radial tool selector (hold + move, release to pick)
    FlyControls.js         pointer-lock FPS camera
    WalkControls.js        pointer-lock walk controller (gravity + collision) for F5 test run
    SelectionGhost.js      in-world placement/removal/line/square/spawn preview
    SpawnMarker.js         persistent cyan beacon at the player spawn
    Notice.js              structured info/warn/error channel
    Toolbar.js / Inventory.js / UI.js / Swatches.js   DOM overlay
  persistence/
    WorldSerializer.js     PURE versioned JSON save/load
    WorldBundle.js         PURE map + item-registry bundle save/load
  engine/
    ItemTypes.js           PURE item data model (grid, palette, light, solidity, serialization)
    ItemRegistry.js        PURE runtime registry of saved items
    ItemMeshBuilder.js     PURE geometry for a micro-voxel item (greedy coplanar merge)
  main.js                  thin bootstrap (new App().start())
  test/                    node:test suites (unit, editor, e2e)
```

### Key design points

- **Pure core, thin renderer.** `World`, `ChunkMeshBuilder`, `VoxelRaycaster`,
  `VoxelShape`, `Space`, `LightField` and `WorldSerializer` have no three.js or
  DOM dependency and are unit tested directly in Node. `TextureAtlas.js` is
  pure; only the texture adapter (`AtlasTexture.three.js`) touches the DOM/three.
- **One draw call per chunk.** Each 16³-cell chunk is a single `BufferGeometry`
  with a shared atlas material; only exposed faces are emitted and simple
  vertex AO darkens corners. Chunks with transparent voxels (glass) get a
  second transparent `BufferGeometry` rendered in a blended pass. Cutout
  shapes (chain-link, bars, boards) stay in the opaque pass with their holes
  discarded in the shader — they write depth, so overlapping panes sort
  correctly instead of alpha-blend ghosting.
- **Flood-fill lighting.** `LightField` precomputes two 0–15 channels per cell
  — *skylight* (light pours straight down open shafts, fades 1 per horizontal
  cell, stops at opaque blocks) and *block light* (emissive light sources —
  stamped per source with line-of-sight occlusion, so walls cast hard
  shadows and light never wraps around thin geometry onto its far side —
  fading 1 per cell in every
  direction). It is stored in dense typed arrays over the world bounds and
  seeded from a per-column heightmap, so a full recompute costs milliseconds.
  The mesher bakes each channel per vertex (smoothed across the 4 surrounding
   cells) into a `light` attribute; the custom `chunkShader.js` material
   multiplies the texture by it. Sealed rooms go dark, light falls through
   windows/roof holes, placed light objects glow warm. Emissive blocks also set
   a per-vertex `emissive` flag so the shader keeps them bright (past 1.0) and
   the bloom pass picks them up. A configurable day/night
   cycle drives the `uSkyIntensity` uniform, lerps the sky color, and now steers
   the chunk shader's directional sun (direction + warm dawn/dusk tint) to match
   the sun actually drawn in the dome. The scene's
   `AmbientLight`/`DirectionalLight` only affect the editor overlays now.
   Half slabs block light by their real shape, not by their cell: a slab cell
   still holds light in its open half (a slab floor is lit on top, a slab roof
   catches the sky) while the solid half seals the side it sits on, so the
   room underneath stays dark. A BIG slab's carved-away cell layer is fully
   open.
 - **Chunk streaming for huge worlds.** `World` keeps a voxel index
   (`anchorKey -> voxel`) and a per-chunk occupancy counter, so counting,
   bounds and chunk enumeration cost O(#voxels)/O(#chunks) instead of O(#cells).
   The renderer only meshes chunks within `CONFIG.render.viewDistance` of the
   camera (nearest first, a few per frame) and disposes those beyond the unload
   radius; distance fog hides the streaming edge. A standing-still frame pays
   nothing for streaming. The mesher also prefetched the chunk + a 1-cell halo
   into a flat array so neighbor/AO probes are O(1) index reads.
 - **Post-processing.** `PostFX.js` renders the frame to an HDR target, blooms
   the bright pass at quarter resolution, then composites with a polaroid grade
   (film curve, warm highlights / cool shadows, faded saturation, vignette,
   animated grain, subtle chromatic aberration). Toggle with `P`; pure
   three.js core, no examples/jsm imports.
  - **Edits mark a 27-chunk neighborhood dirty** so face culling and AO stay
   correct across chunk borders. Small edits re-flood only bounded boxes around
   the edited cells (via `recomputeEdit`), keeping per-edit cost independent of
   world size; far-apart edits get separate boxes and emission-only edits
   (blinking lights swapping lit/dark phases, same opacity) skip the sky
   re-flood and only re-stamp block light. Big batches fall back to a full
   recompute. Chunk rebuilds are time-sliced by a millisecond budget: chunks
   touched by a player edit rebuild the same frame, soft edits (blinkers) and
   plain dirty chunks rebuild within budget over the next frames, so the game
   never freezes on a single placement.
- **Data-driven blocks.** Blocks and tiles are plain data in `VoxelTypes.js`
  and `TextureAtlas.js`; everything else reads from the registry. Block defs
  accept optional `opacity` (255 = opaque, 0 = lets light through), `light`
  (0–15 block light emitted), and `transparent` (render in the blended pass).
- **Command pattern + capped history.** Every world edit is a `{ do, undo }`
  Command pushed onto `History` (depth 10). Undo/redo work across single
  placements, lines, squares and whole cube deletions.
- **Tool registry.** Tools implement a small lifecycle (`onActivate`,
  `onMouseDown/Up`, `update`). BuildTool, SquareTool and SpawnTool are the
  tools today; new tools just register themselves.
- **Special nodes.** The player spawn is a point entity stored separately from
  voxels (`World.spawn`), rendered as a beacon, persisted in saves, and not
  part of chunk meshing. Loading a map with a spawn frames the camera there.
- **Single input owner.** `Input.js` owns every key/mouse/wheel listener and
  emits semantic actions from the `Keybindings.js` table.
- **One world-copy path.** `World.copyFrom(other)` is the only way a loaded
  world replaces a live one (editor map load and game boot both use it), so
  a new voxel/world field — rotation, decals — is threaded once and can
  never silently vanish on one of the paths.

## Adding a new block

1. Add an entry to the `BLOCKS` array in `src/engine/VoxelTypes.js` with an
   `id`, `name`, and a `tiles` value — either a single tile name (used on every
   face, the default look) or a map from face (`py/ny/px/nx/pz/nz`) to a tile
   name for per-face textures.
2. Add a tile generator function to the `GENERATORS` object in
   `src/textures/TextureAtlas.js` (signature `(x, y, size, rng) -> [r, g, b]`,
   or `[r, g, b, a]` when the tile has transparent pixels, e.g. glass or the
   chain-link fence — alpha 0 texels are cut out entirely in the shader).

Optional fields on the block def:
- `opacity: 0..255` — default 255. Blocks with `opacity < 255` let light pass
  through them (glass, fences) and don't block mob line-of-sight.
- `light: 0..15` — block light emitted by this block (lamp = 15, neon = 9;
  placed light objects work too).
- `emitFaces: ['ny', ...]` — directional emission: the block seeds light
  only into the open cells beyond the listed faces (a ceiling panel shines
  down, a neon tube sideways), so a light embedded flush in a wall or roof
  never lights the far side. A sealed emit face emits nothing. Omit for
  omnidirectional glow.
- `blink: 'flicker'` + `blinkOff: <id>` — the block strobes between itself
   and its hidden dark phase (`hidden: true` keeps that state out of the
   palette), in the game AND the editor (`engine/Blinkers.js`). The toggle
   swaps the voxel type in place and pushes a soft light edit (rebuilt on the
   deferred budget, capped at ~10 Hz per lamp), so the surroundings really
   flicker — horror-movie cadence: lit stretches with the odd dip, broken by
   fits of rapid erratic chatter. Saves and middle-click picking normalize a
   mid-blink dark phase back to the lit id.
- `transparent: true` — render in the alpha-blended pass (needed when the
  tiles have transparent pixels, and keeps glass-on-glass faces culled).
- `shape: 'pane'` — instead of cube faces, mesh a single quad centered in
  the block (chain-link fence, metal bars, barricade boards); `R` turns it
  (0°/180° = along x, 90°/270° = along z). Panes render as depth-written
  alpha cutouts in the opaque pass, so overlapping see-through blocks never
  blend in the wrong order. The block still occupies its full cell for
  collision.
- `shape: 'cross'` — two crossed diagonal cutout quads spanning the block
  (bushes, plants): the same X the grass ground cover sprouts, as a placeable
  block. No rotation (the X is symmetric); occupies its full cell for
  collision; takes no decals, paint or slab variants.
- `shootThrough: true` — attack rays (bullets and melee swings) pass through
  the block and hit whatever is behind it; movement is still blocked. Used
  with `shape: 'pane'` (fences, barricades) and `shape: 'cross'` (bushes) so
  you can fight through them.

It then appears in the hotbar, inventory, meshing and save files
automatically. Old maps that reference unknown ids load with a warning.

## Decals

Decals are cutout tiles pinned onto one face of a placed block — blood
splatter, cracks, bullet holes — picked from the **Decals** section of the
inventory (`E`, assignable to hotbar slots like blocks). With a decal in
hand, LMB pins it to the face under the crosshair, RMB peels it off, and `R`
spins it in quarter turns; the ghost previews the decal texture on the exact
face it will land on. A decal has no collision or light interaction: it is
meshed into the chunk as one extra quad a hair off its face (only when that
face is visible), reuses the face's baked AO/light, and its holes are
alpha-discarded. One decal per face; removing the block removes its decals.
`shape: 'pane'` blocks take decals too — a lace curtain on a glass window, a
poster on a barricade — but only on the two flat sides the pane looks along
(the edge-on faces and a door's faces accept nothing, see `decalFacesFor`).
There the quad rides the pane's own plane, centered in the block, rather than
the cell boundary in front of it, and joins the pane's render pass (blended
for glass, cutout for fences).
Decals persist in the map file as an additive `decals` array (`{ id, x, y,
z, face, rotation? }`). Adding a new decal = one entry in `DECALS`
(`VoxelTypes.js`) plus an RGBA tile generator in `TextureAtlas.js`.

Decals can be **bigger than one block**: a `span: [w, h]` on the decal def
(graffiti 4x2, STOP road text 4x4, road arrow 2x4) makes the footprint cover
w x h cells — the anchor is the cell you click, every covered cell needs a
backing block, and the art is `span * 16px` so texel density matches blocks.
The atlas packs multi-slot art on shelves below the regular tiles, the
mesher emits one sub-rect quad per covered face (so culling, AO and light
stay per-face), and `decalFootprint()` keeps the artwork's width horizontal
on every wall. One footprint = one decal: removing it from any covered cell
(or breaking any backing block) removes the whole thing.

**Text signs** are decals authored in the editor: the "＋ New Sign…" card in
the Decals section opens a dialog (text, band height 1–2 cells, width auto
or fixed 1–8, text/background colors, or transparent background for painted
lettering) with a live preview. Text renders through a 5x7 pixel font
(`textures/PixelFont.js`) with Polish diacritics (SKLEP, RZEŹNIK, KWIATY…);
`engine/TextDecals.js` registers the sign as a runtime decal + runtime atlas
tile (content-addressed id, so the same spec is reused), and the atlas
texture is rebuilt in place. Signs persist as an additive `textDecals` array
of specs next to the `decals` placements and re-register on load — in the
editor, the game, and save-slot bundles alike.

## Face paint

Every block face can show a **different texture**. `Tab` → **Paint**: the block
selected in the palette is the brush, holding `LMB` paints every face the
crosshair sweeps across, holding `RMB` strips faces back to the block's own
texture. Each stroke is one undo step. The ghost previews the brush tile on
the exact face it will land on, with the voxel that takes it outlined — a 1 m
block paints a whole side at a time, not the 0.5 m cell you happened to hit.

Paint is **purely visual**: the voxel keeps its own type, opacity, emitted
light, collision and shape. Only full cube blocks take paint — panes and doors
mesh their art as a whole slab, so there is no per-face tile to swap. A
painted face is not permuted by the voxel's yaw (the painter picked what they
saw), and it still culls, shades and takes decals like any other face — a face
buried behind a neighbour costs nothing at all.

**Cost: zero.** Painting emits no extra geometry, no extra draw call and no
extra material — `buildChunkMesh` simply samples a different atlas tile for
that quad, so a fully repainted world renders exactly as fast as a bare one.
The mesher's only added work is one map lookup per meshed voxel (not per
face), and even that is skipped entirely while `world.paintCount` is 0, which
it is for every unpainted world. Nothing runs per frame.

Paint lives in `World.paint` (cell key -> `{ face: blockId }`) and persists as
an additive `paint` array (`{ x, y, z, face, type }`) in both the map file and
prefabs — omitted when empty, so untouched files stay byte-identical. Removing
a block strips its paint; stamping a rotated prefab turns each painted face
with the building, and never repaints a block the stamp could not place.

## Voxel-size rules

- Placement targets the cell adjacent to the face you click.
- Small voxels snap to any cell (0.5 m precision).
- Big voxels snap to even anchors (the 1 m grid). A big block placed against a
  face that lies on an odd 0.5 m plane is rejected (shown red) — physically you
  cannot butt a 1 m cube against a half-meter-offset face.

## Save format

```json
{
  "format": "voxelmap",
  "version": 1,
  "cellSize": 0.5,
  "spawn": [2, 4, 6],
  "blocks": [{ "x": 0, "y": 0, "z": 0, "size": "big", "type": "grass" }],
  "items": [{ "itemId": "lamp", "x": 2, "y": 4, "z": 2, "cells": [1, 1, 1], "rotation": 1.5707963267948966 }],
  "paint": [{ "x": 0, "y": 0, "z": 0, "face": "py", "type": "brick" }]
}
```

`spawn` is the player spawn cell (`[x, y, z]`, or `null`). `items` lists placed
placeable objects (referencing registered item ids); `rotation` is the object's
yaw in radians about its vertical axis (default `0`). `paint` lists per-face
texture overrides (see **Face paint**) and is omitted when nothing is painted.
All are additive — older maps without them load fine.

Item files use their own format (`voxelitem`):
```json
{
  "format": "voxelitem",
  "version": 2,
  "id": "lamp",
  "name": "Lamp",
  "cells": [1, 1, 1],
  "solid": true,
  "microVoxels": [{ "x": 0, "y": 0, "z": 0, "color": [255, 200, 50] }],
  "light": { "x": 0, "y": 0, "z": 0, "color": [255, 220, 150], "strength": 3 }
}
```
`cells` is the item's world footprint in 0.5 m cells `[w, h, d]` (1–8 per
axis — a kitchen chair is `[1, 2, 1]`, a big closet `[2, 4, 1]`), and the
micro-voxel build volume is `cells × 8` at a uniform 0.0625 m resolution.
Version-1 files stored `size: "small"|"big"` instead; they load fine —
`small` maps to 1×1×1 and `big` to 2×2×2 with micro-voxels upscaled ×2
(visually identical). Placed items with a non-square footprint swap their
w/d span on odd 90° rotations, like doors.
The item registry ships inside the world bundle (`map/voxelbundle.json`), so
saved objects persist across sessions and machines. `solid` (default `true`)
marks whether a placed object blocks the player in test run. To ship your
objects to other players, use **Save File** and rebuild — the bundled item
registry is loaded automatically for visitors (see "Shipping a map with the
game").

### Bundle format

A **world bundle** (`voxelbundle.json`) packages a map together with every
object it uses, so one file is enough to ship a whole world:
```json
{
  "format": "voxelbundle",
  "version": 1,
  "map": { "...voxelmap content..." },
  "items": [ "...ItemDefs..." ]
}
```
It is produced by **Save File** (written to `map/voxelbundle.json` via
`server.mjs`, no download), embedded into `build/game.js` from that file, and
loaded automatically when a visitor has no browser save — the deployed game's
default world.

## Tooling

```sh
npm test        # unit + editor tests (fast, no browser needed)
npm run build   # regenerate build/game.js + build/game-play.js from src/ (esbuild)
npm run build:editor   # editor bundle only
npm run build:game     # game bundle only
npm run server  # run the editor server on http://localhost:4173 (static files + /api/world)
```

The e2e suite (`test/e2e.test.js`) boots the real page in headless Chromium
against a throwaway dev server and asserts the render loop, chunking and
file persistence work. It is skipped automatically when Chromium isn't
available.
