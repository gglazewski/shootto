// gameMain.js — thin bootstrap for the playable game page (game.html).

import { GameApp } from './GameApp.js';

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const game = new GameApp();
    game.start();
    window.__voxelgame = game;
  });
}
