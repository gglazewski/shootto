import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, registerBlock } from '../src/engine/VoxelTypes.js';
import { LightField, MAX_LIGHT } from '../src/engine/LightField.js';
import { toggleDoor } from '../src/engine/Doors.js';

// The game no longer ships an emissive block (torches are placed objects now),
// but the engine still supports emissive voxels — register one for these tests.
registerBlock({ id: 'torch', name: 'Test Torch', tiles: 'concrete', light: 15, opacity: 0, transparent: true });

// Build a hollow box of opaque blocks: x,z in [-span,span], y in [bottom,top].
// Returns the world.
function hollowBox(span = 2, bottom = 1, top = 5) {
  const w = new World();
  for (let x = -span; x <= span; x++) {
    for (let z = -span; z <= span; z++) {
      for (let y = bottom; y <= top; y++) {
        const wall = Math.abs(x) === span || Math.abs(z) === span || y === bottom || y === top;
        if (wall) w.place('concrete', SIZE.SMALL, x, y, z);
      }
    }
  }
  return w;
}

test('empty world: recompute is a no-op and get returns zeros', () => {
  const w = new World();
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.region, null);
  assert.deepEqual(lf.get(0, 0, 0), { sky: 0, block: 0 });
  assert.deepEqual(lf.get(100, 5, -3), { sky: 0, block: 0 });
});

test('sealed room interior gets no skylight', () => {
  const w = hollowBox();
  const lf = new LightField(w);
  lf.recompute();
  // hollow interior cells
  for (const [x, y, z] of [[0, 3, 0], [-1, 2, 1], [1, 4, -1]]) {
    assert.equal(lf.get(x, y, z).sky, 0, `interior (${x},${y},${z}) should be dark`);
  }
  // roof cells are exposed to sky
  assert.equal(lf.get(0, 6, 0).sky, MAX_LIGHT);
  assert.equal(lf.get(3, 3, 0).sky, MAX_LIGHT);
});

test('open shaft in the roof lets light pour straight down', () => {
  const w = hollowBox();
  w.remove(0, 5, 0); // punch a hole in the roof
  const lf = new LightField(w);
  lf.recompute();
  // the whole open column under the hole is lit at full brightness
  assert.equal(lf.get(0, 6, 0).sky, MAX_LIGHT);
  assert.equal(lf.get(0, 5, 0).sky, MAX_LIGHT); // the hole cell itself
  assert.equal(lf.get(0, 4, 0).sky, MAX_LIGHT);
  assert.equal(lf.get(0, 3, 0).sky, MAX_LIGHT);
  assert.equal(lf.get(0, 2, 0).sky, MAX_LIGHT);
  // light fades by 1 per horizontal step
  assert.equal(lf.get(1, 3, 0).sky, MAX_LIGHT - 1);
  assert.equal(lf.get(-1, 3, 0).sky, MAX_LIGHT - 1);
  assert.equal(lf.get(1, 2, 1).sky, MAX_LIGHT - 2);
  // a far interior corner is dimmer
  assert.ok(lf.get(-1, 2, 1).sky < lf.get(0, 3, 0).sky);
});

test('glass window lets light through into the interior', () => {
  const w = hollowBox();
  w.remove(2, 3, 0); // clear the +x wall cell
  w.place('glass', SIZE.SMALL, 2, 3, 0);
  const lf = new LightField(w);
  lf.recompute();
  // outside sky, through the glass, into the room, each step decays once
  assert.equal(lf.get(3, 3, 0).sky, MAX_LIGHT);       // outside
  assert.equal(lf.get(2, 3, 0).sky, MAX_LIGHT - 1);   // glass
  assert.equal(lf.get(1, 3, 0).sky, MAX_LIGHT - 2);   // just inside
  assert.equal(lf.get(0, 3, 0).sky, MAX_LIGHT - 3);
});

test('torch emits block light that decays uniformly', () => {
  const w = new World();
  w.place('torch', SIZE.SMALL, 0, 0, 0);
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(0, 0, 0).block, MAX_LIGHT);
  assert.equal(lf.get(1, 0, 0).block, MAX_LIGHT - 1);
  assert.equal(lf.get(2, 0, 0).block, MAX_LIGHT - 2);
  assert.equal(lf.get(0, 0, 3).block, MAX_LIGHT - 3);
  assert.equal(lf.get(14, 0, 0).block, 1);
  assert.equal(lf.get(15, 0, 0).block, 0);
});

test('block light cannot pass through opaque walls', () => {
  const w = new World();
  // a full yz plane wall at x=0, taller and wider than the 15-step light radius
  // so the light cannot wrap around any edge
  for (let y = -16; y <= 16; y++) {
    for (let z = -16; z <= 16; z++) w.place('concrete', SIZE.SMALL, 0, y, z);
  }
  w.place('torch', SIZE.SMALL, -1, 0, 0);
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(-1, 0, 0).block, MAX_LIGHT);
  assert.equal(lf.get(0, 0, 0).block, 0, 'opaque wall blocks torch light');
  assert.equal(lf.get(1, 0, 0).block, 0);
  assert.equal(lf.get(3, 2, 2).block, 0);
});

test('recompute is idempotent', () => {
  const w = hollowBox();
  w.place('torch', SIZE.SMALL, 0, 3, 0);
  const lf = new LightField(w);
  lf.recompute();
  const first = Array.from(lf.lightData);
  lf.recompute();
  assert.deepEqual(Array.from(lf.lightData), first);
});

test('big emissive voxel seeds block light from all its cells', () => {
  const w = new World();
  w.place('torch', SIZE.BIG, 0, 0, 0);
  const lf = new LightField(w);
  lf.recompute();
  // every sub-cell of the big voxel is a light source
  for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 1]]) {
    assert.equal(lf.get(x, y, z).block, MAX_LIGHT, `sub-cell (${x},${y},${z})`);
  }
  // light reaches outside the big voxel
  assert.equal(lf.get(2, 0, 0).block, MAX_LIGHT - 1);
});

// --- incremental edits ---

function cloneWorld(w) {
  const w2 = new World();
  w.forEachVoxel((v) => w2.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2], v.rotation ?? 0, v.variant ?? null));
  return w2;
}

// An incremental edit must leave the light field identical to a full recompute
// on the same final world — compared cell-by-cell over the (possibly smaller)
// region that a fresh recompute would allocate. The incremental field may keep
// stale cells beyond the new world bounds, but those are never rendered.
function assertEditMatchesFull(editFn, setup = () => {}) {
  const w = new World();
  setup(w);
  const lf = new LightField(w);
  lf.recompute();

  editFn(w);
  const edits = w.drainEdits();
  lf.recomputeEdit(edits);

  const ref = new LightField(cloneWorld(w));
  ref.recompute();
  const { min, max } = ref.region;
  for (let x = min[0]; x <= max[0]; x++) {
    for (let y = min[1]; y <= max[1]; y++) {
      for (let z = min[2]; z <= max[2]; z++) {
        assert.deepEqual(lf.get(x, y, z), ref.get(x, y, z), `cell (${x},${y},${z})`);
      }
    }
  }
}

test('incremental: placing a block in a room matches full recompute', () => {
  assertEditMatchesFull((w) => {
    w.place('concrete', SIZE.SMALL, 2, 3, 0);
  }, (w) => {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        for (let y = 1; y <= 5; y++) {
          const wall = Math.abs(x) === 2 || Math.abs(z) === 2 || y === 1 || y === 5;
          if (wall) w.place('concrete', SIZE.SMALL, x, y, z);
        }
      }
    }
    w.place('torch', SIZE.SMALL, 0, 3, 0);
  });
});

test('incremental: punching a roof hole matches full recompute', () => {
  assertEditMatchesFull((w) => {
    w.remove(0, 5, 0);
  }, (w) => {
    const box = hollowBox();
    box.forEachVoxel((v) => w.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2]));
  });
});

test('incremental: removing a torch matches full recompute', () => {
  assertEditMatchesFull((w) => {
    w.remove(1, 0, 0);
  }, (w) => {
    w.place('torch', SIZE.SMALL, 0, 0, 0);
    w.place('torch', SIZE.SMALL, 1, 0, 0);
  });
});

test('incremental: placing a torch in a sealed room matches full recompute', () => {
  assertEditMatchesFull((w) => {
    w.place('torch', SIZE.SMALL, 0, 3, 0);
  }, (w) => {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        for (let y = 1; y <= 5; y++) {
          const wall = Math.abs(x) === 2 || Math.abs(z) === 2 || y === 1 || y === 5;
          if (wall) w.place('concrete', SIZE.SMALL, x, y, z);
        }
      }
    }
  });
});

test('directional lamp lights only the side its face opens into', () => {
  const w = new World();
  // A large flat ceiling (11x11) with the lamp embedded flush in its center.
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      if (x === 0 && z === 0) continue;
      w.place('concrete', SIZE.SMALL, x, 2, z);
    }
  }
  w.place('lamp', SIZE.SMALL, 0, 2, 0); // emitFaces: ['ny'] -> shines down
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(0, 1, 0).block, MAX_LIGHT, 'full light below the panel');
  assert.equal(lf.get(0, 0, 0).block, MAX_LIGHT - 1);
  // Above the ceiling only a faint wrap-around remnant may arrive (the flood
  // walking around the 11x11 slab), never direct light through the panel.
  assert.ok(lf.get(0, 3, 0).block <= 2, `above the panel stays dark (got ${lf.get(0, 3, 0).block})`);
});

test('directional lamp goes dark when its emit face is sealed', () => {
  const w = new World();
  w.place('lamp', SIZE.SMALL, 0, 1, 0);
  w.place('concrete', SIZE.SMALL, 0, 0, 0); // block under the panel
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(1, 1, 0).block, 0, 'no sideways spill from a sealed panel');
});

test('block light casts real shadows: only a dim bounce fill behind a small wall', () => {
  const w = new World();
  // a small 3x3 wall right in front of the light — with flooding, light
  // would wrap around it and light the back almost fully; with LOS
  // stamping the space behind gets only the faint indirect fill of the
  // bounce pass, far dimmer than the lit side and fading with depth
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) w.place('concrete', SIZE.SMALL, 2, y, z);
  }
  w.place('torch', SIZE.SMALL, 0, 0, 0);
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(1, 0, 0).block, MAX_LIGHT - 1, 'lit in front of the wall');
  const behind = lf.get(3, 0, 0).block;
  assert.ok(behind > 0, 'the shadow is no longer pitch black (bounce fill)');
  assert.ok(behind <= 4, `the fill stays dim (got ${behind})`);
  assert.ok(lf.get(5, 0, 0).block < behind, 'the fill fades deeper into the shadow');
  assert.equal(lf.get(8, 0, 0).block, 0, 'the deep shadow stays dark');
});

test('closed door blocks light; opening it lets light through', () => {
  // Sealed box with a 2x4 doorway in the +x wall, filled by a closed door.
  const w = hollowBox(2, 0, 6);
  for (let y = 1; y <= 4; y++) {
    w.remove(2, y, 0);
    w.remove(2, y, 1);
  }
  w.place('door_wood', SIZE.DOOR, 2, 1, 0, 1); // rotation 1: spans z 0..1
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(3, 3, 0).sky, MAX_LIGHT, 'outside the door is open sky');
  assert.equal(lf.get(1, 3, 0).sky, 0, 'closed door seals the interior');

  // Toggle it open; the incremental edit path must let light pour in.
  w.drainEdits();
  toggleDoor(w, w.get(2, 3, 0));
  lf.recomputeEdit(w.drainEdits());
  assert.equal(lf.get(2, 3, 0).sky, MAX_LIGHT - 1, 'light passes the open leaf');
  assert.equal(lf.get(1, 3, 0).sky, MAX_LIGHT - 2, 'light enters the room');

  // And closing it again seals the room back up.
  toggleDoor(w, w.get(2, 3, 0));
  lf.recomputeEdit(w.drainEdits());
  assert.equal(lf.get(1, 3, 0).sky, 0, 're-closed door seals again');
});

// --- half slabs (a cell that is only half solid) ---

/** Swap the inner 3x3 of a hollow box's roof for slabs of `variant`. */
function slabRoof(w, variant) {
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      w.remove(x, 5, z);
      w.place('concrete', SIZE.SMALL, x, 5, z, 0, variant);
    }
  }
  return w;
}

test('a lower-slab roof takes sky into its own cell but still shadows the room', () => {
  const solid = new LightField(hollowBox());
  solid.recompute();
  assert.equal(solid.get(0, 5, 0).sky, 0, 'a full roof block is dark');

  const lf = new LightField(slabRoof(hollowBox(), 'lower'));
  lf.recompute();
  assert.equal(lf.get(0, 5, 0).sky, MAX_LIGHT, 'the air above the slab is open sky');
  assert.equal(lf.get(0, 4, 0).sky, 0, 'the room below stays sealed');
});

test('an upper-slab roof blocks sky at its own cell', () => {
  const lf = new LightField(slabRoof(hollowBox(), 'upper'));
  lf.recompute();
  // the solid half is on top: no direct sky, and nothing floods down past it
  assert.equal(lf.get(0, 5, 0).sky, 0);
  assert.equal(lf.get(0, 4, 0).sky, 0);
});

test('sky lands on a slab floor and stops at its solid half', () => {
  // open-air plate at y=0: a full ring around an inner 3x3 of lower slabs
  const w = new World();
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      const slab = Math.abs(x) <= 1 && Math.abs(z) <= 1;
      w.place('concrete', SIZE.SMALL, x, 0, z, 0, slab ? 'lower' : null);
    }
  }
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(0, 0, 0).sky, MAX_LIGHT, 'the slab cell is lit, not blacked out');
  assert.equal(lf.get(2, 0, 0).sky, 0, 'the full block beside it still is not');
});

test('block light crosses a slab cell but not its solid half', () => {
  const w = new World();
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) w.place('concrete', SIZE.SMALL, x, 0, z, 0, 'lower');
  }
  w.place('torch', SIZE.SMALL, 0, 1, 0); // standing on the slab floor
  const lf = new LightField(w);
  lf.recompute();
  assert.equal(lf.get(0, 0, 0).block, MAX_LIGHT - 1, 'the slab top is lit');
  // The solid half transmits nothing; only a faint bounce remnant creeps
  // around the platform edge (light spilling off a table edge).
  assert.ok(lf.get(0, -1, 0).block <= 3, 'the underside gets bounce spill at most');
  assert.equal(lf.get(0, -3, 0).block, 0, 'deeper below stays dark');
});

test('a lower and an upper slab side by side do not share light', () => {
  // The upper slab is walled in on every side but the lower slab next to it,
  // so that step is the only way light could get there.
  const w = new World();
  for (let x = -1; x <= 2; x++) {
    for (let z = -1; z <= 1; z++) w.place('concrete', SIZE.SMALL, x, 0, z);
  }
  w.place('concrete', SIZE.SMALL, 0, 1, 0, 0, 'lower'); // open to the sky
  w.place('concrete', SIZE.SMALL, 1, 1, 0, 0, 'upper');
  for (const [x, y, z] of [[1, 1, -1], [1, 1, 1], [2, 1, 0], [1, 2, 0]]) {
    w.place('concrete', SIZE.SMALL, x, y, z);
  }
  const lf = new LightField(w);
  lf.recompute();
  // sky pours onto the lower slab's open top; the upper slab's open half is
  // underneath its own solid lid, so the light cannot step sideways into it
  assert.equal(lf.get(0, 1, 0).sky, MAX_LIGHT);
  assert.equal(lf.get(1, 1, 0).sky, 0);
});

test('incremental: placing and removing a slab matches full recompute', () => {
  const roomWithHole = (w) => {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        for (let y = 1; y <= 5; y++) {
          const wall = Math.abs(x) === 2 || Math.abs(z) === 2 || y === 1 || y === 5;
          if (wall && !(y === 5 && x === 0 && z === 0)) w.place('concrete', SIZE.SMALL, x, y, z);
        }
      }
    }
  };
  assertEditMatchesFull((w) => { w.place('concrete', SIZE.SMALL, 0, 5, 0, 0, 'lower'); }, roomWithHole);
  assertEditMatchesFull((w) => { w.place('concrete', SIZE.SMALL, 0, 5, 0, 0, 'upper'); }, roomWithHole);
  assertEditMatchesFull((w) => { w.remove(0, 5, 0); }, (w) => {
    roomWithHole(w);
    w.place('concrete', SIZE.SMALL, 0, 5, 0, 0, 'lower');
    w.drainEdits();
  });
});

test('incremental: world growth falls back to a full recompute', () => {
  const w = new World();
  w.place('grass', SIZE.SMALL, 0, 0, 0);
  const lf = new LightField(w);
  lf.recompute();
  // place a block far beyond the current region (+MARGIN) -> must recompute
  w.place('concrete', SIZE.SMALL, 40, 0, 0);
  const edits = w.drainEdits();
  lf.recomputeEdit(edits);
  const ref = new LightField(cloneWorld(w));
  ref.recompute();
  assert.deepEqual(Array.from(lf.lightData), Array.from(ref.lightData));
});
