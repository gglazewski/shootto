// main.js — thin bootstrap. All wiring lives in App.js.

import { App } from './App.js';

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', async () => {
    const app = new App();
    await app.start();
    window.__voxelgame = app.debugHandle;
  });
}
