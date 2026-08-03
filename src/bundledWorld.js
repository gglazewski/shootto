// bundledWorld.js — the world shipped with a deployment.
//
// The build embeds map/voxelbundle.json (a WorldBundle) into game.js. On
// startup the app loads this bundled world when the visitor has no browser
// save, so a deployed game always contains the author's map and objects —
// nothing depends on the browser's localStorage.
//
// To ship a new map: export a voxelbundle.json from the editor, save it over
// map/voxelbundle.json, and rebuild.

import bundledWorld from '../map/voxelbundle.json';

/** @type {object|null} parsed WorldBundle data, or null when absent */
export const BUNDLED_WORLD = bundledWorld;
