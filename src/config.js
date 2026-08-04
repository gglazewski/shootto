// config.js — single place for user-tunable and engine-tunable constants.
//
// Renderer, FlyControls and App read from here so settings (FOV, render
// distance, sensitivity, speeds, history depth) never have to be hunted
// through the codebase again.

export const CONFIG = Object.freeze({
  saveKey: 'voxelmap.save',
  itemSaveKey: 'voxelitem.items',
  equipSaveKey: 'voxelequip.items',
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
    dayNightSpeed: 0.05, // cycles/sec
    skyIntensity: 1, // current day/night multiplier (0..1)
    sunDirection: [0.5, 1.5, 0.4],
    sunColor: [1.0, 0.95, 0.85],
    skyTint: [0.75, 0.82, 1.0], // cool sky bounce color
    blockTint: [1.0, 0.78, 0.45], // warm artificial light color
    ambientMin: 0.04, // floor so sealed rooms aren't pure black
    lightScale: 1.0, // overall light intensity multiplier
    sunStrength: 0.35, // directional sun shading strength
    nightSky: [0.05, 0.07, 0.15], // scene background at night
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
  history: {
    max: 10,
  },
});
