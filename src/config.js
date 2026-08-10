// config.js — single place for user-tunable and engine-tunable constants.
//
// Renderer, FlyControls and App read from here so settings (FOV, render
// distance, sensitivity, speeds, history depth) never have to be hunted
// through the codebase again.

export const CONFIG = Object.freeze({
  saveKey: 'voxelmap.save',
  itemSaveKey: 'voxelitem.items',
  equipSaveKey: 'voxelequip.items',
  npcSaveKey: 'voxelnpc.npcs',
  questSaveKey: 'voxelquest.quests',
  groundSpan: 16, // big voxels per side of the seeded ground plane
  camera: {
    fov: 70,
    near: 0.05,
    far: 2000,
  },
  lighting: {
    ambient: 0.55, // legacy, used by overlay lights only now
    sun: 0.85, // legacy, used by overlay lights only now
    dayNight: true,
    dayNightSpeed: 1 / 600, // cycles/sec — one full day/night cycle per 10 real minutes
    dayNightStart: 0, // starting point in the cycle: 0 = midday, 0.5 = midnight
    skyIntensity: 1, // current day/night multiplier (0..1)
    sunDirection: [0.5, 1.5, 0.4], // only the initial value; the day/night cycle steers it afterwards
    sunColor: [1.0, 0.95, 0.85],
    skyTint: [0.75, 0.82, 1.0], // cool sky bounce color
    blockTint: [1.0, 0.78, 0.45], // warm artificial light color
    ambientMin: 0.04, // floor so sealed rooms aren't pure black
    lightScale: 1.0, // overall light intensity multiplier
    sunStrength: 0.35, // directional sun shading strength
    emissiveBoost: 1.5, // self-emission strength of lamps/torches (>1 feeds bloom)
    nightSky: [0.05, 0.07, 0.15], // scene background at night
    fogColor: [0.66, 0.78, 0.9], // distance fog by day; lerps to nightSky at night
  },
  render: {
    // Chunk streaming: chunks beyond viewDistance (in chunks, 8 m each) from
    // the camera are not meshed, so worlds can grow far beyond what one
    // frame can draw. 0 disables streaming (everything stays loaded).
    viewDistance: 28,
    // Chunks unload only past this radius (hysteresis keeps the edge stable
    // while strafing). Must be >= viewDistance.
    unloadDistance: 30,
    // Max newly streamed chunk builds per frame (dirty rebuilds don't count).
    maxLoadsPerFrame: 4,
    // Distance fog hides the streaming edge; near/far in meters. fogFar <= 0
    // derives both from viewDistance.
    fogNear: 0,
    fogFar: 0,
    // Drawing-buffer scale relative to the CSS viewport (0.5..1]. 1 = native
    // resolution; lower values render smaller and upscale (cheaper fill rate,
    // slightly softer image). The HUD stays crisp either way.
    renderScale: 1,
  },
  postfx: {
    enabled: true, // polaroid grade + bloom; toggle with P in the editor
    // MSAA sample count of the post scene target (0 disables; 4 = old look).
    // 2 is near-indistinguishable on nearest-filtered voxel textures and
    // saves a good slice of GPU fill on high-resolution displays.
    msaa: 2,
    bloom: {
      threshold: 0.78, // brightness that starts blooming
      knee: 0.45, // soft rolloff below full bloom
      intensity: 0.85, // how much bloom is added back
    },
    polaroid: {
      exposure: 1.12,
      saturation: 0.84, // <1 fades toward print ink
      fade: 0.45, // lifted blacks / softened contrast
      vignette: 0.5, // corner darkening
      grain: 0.05, // animated film grain
      aberration: 0.0022, // radial chromatic fringing
    },
  },
  sky: {
    // visual sky (dome, sun, moon, clouds) — see engine/Sky.js
    sunDistance: 1350, // must stay below camera.far
    sunSize: 65,
    moonSize: 48,
    orbitTilt: 0.25, // z-lean of the sun/moon track so noon isn't dead overhead
    cloudHeight: 140, // world y of the cloud layer
    cloudHalfSize: 1600,
    cloudScale: 620, // world units per noise tile (bigger = larger clouds)
    cloudCoverage: 0.52, // noise threshold; higher = fewer clouds
    wind: [5.5, 2.0], // world units/sec cloud drift
    nightHorizon: [0.05, 0.07, 0.15], // matches lighting.nightSky
  },
  controls: {
    sensitivity: 0.0022,
    speed: 6, // m/s
    accel: 14,
    sprint: 4,
    minSpeed: 0.5,
    maxSpeed: 40,
  },
  player: {
    // test-run mode (F5): walk controller + AABB collision
    halfWidth: 0.25, // meters, half the x/z footprint (fits exactly one 0.5m cell)
    height: 1.8, // ≈ two 1m blocks
    eyeHeight: 1.62,
    crouchHeight: 1.5,
    crouchEye: 1.35,
    stepHeight: 0.5, // meters climbed automatically onto small (0.5m) blocks
    stepClimbTime: 0.18, // seconds to smoothly rise one step (vs snapping instantly)
    gravity: 24, // m/s^2
    walkSpeed: 4.5, // m/s (no sprint)
    crouchSpeed: 1.6,
    groundAccel: 12,
    airAccel: 4,
  },
  test: {
    // How far the F5 test run's E key reaches, in cells (2 cells = 1 m).
    // Matches the game's door reach (GameApp DOOR_RANGE).
    interactCells: 5,
  },
  history: {
    max: 10,
  },
});
