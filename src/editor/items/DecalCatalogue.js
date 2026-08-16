// DecalCatalogue.js — the editor's browser of custom decals.
//
// A modal listing every runtime-registered decal: drawn pixel decals (the
// inventory's "New Decal…" editor) and text signs ("New Sign…"). Clicking a
// card puts the decal in hand; Delete removes it from the registry, the
// inventory and the world (placements are stripped first, so no saved map
// ends up referencing an unknown id). Built-in decals live in source
// (VoxelTypes DECALS) and are not listed — they can't be deleted from here.
//
// The panel chrome (search, count, keyboard, two-step delete confirm) lives
// in CatalogueModal; this subclass only supplies the decal list, the flat
// 2D swatch and the meta line.

import { CatalogueModal } from './CatalogueModal.js';
import { listPixelDecalIds } from '../../engine/PixelDecals.js';
import { listTextDecalIds } from '../../engine/TextDecals.js';
import { getDecal } from '../../engine/VoxelTypes.js';
import { buildDecalSwatch } from '../Swatches.js';

export class DecalCatalogue extends CatalogueModal {
  /**
   * @param {object} deps
   * @param {Document} [deps.doc]
   * @param {HTMLElement} deps.container  the modal root (#decal-catalogue)
   * @param {import('../../engine/World.js').World} deps.world  placement counts
   * @param {object} [deps.callbacks]  { onCard(id), onDelete(id) }
   */
  constructor({ doc = document, container, world, callbacks = {} } = {}) {
    super({
      doc,
      container,
      callbacks,
      title: 'Decal Catalogue',
      emptyText: 'No custom decals yet — draw one or make a text sign from the inventory',
      cardHint: 'click to put in hand',
    });
    this.world = world;
  }

  _filters() {
    return [
      { id: 'all', label: 'All', test: () => true },
      { id: 'drawn', label: 'Drawn', test: (d) => !!d.pixelSpec },
      { id: 'signs', label: 'Signs', test: (d) => !!d.textSpec },
    ];
  }

  _list() {
    return [...listPixelDecalIds(), ...listTextDecalIds()].map((id) => getDecal(id));
  }

  _swatch(decal) {
    return buildDecalSwatch(decal.id);
  }

  _meta(decal) {
    const [w, h] = decal.span ?? [1, 1];
    let placed = 0;
    this.world?.forEachDecal((d) => { if (d.decalId === decal.id) placed++; });
    return [
      decal.textSpec ? 'text sign' : 'drawn',
      `${w}×${h} cell${w * h > 1 ? 's' : ''}`,
      placed ? `${placed} placed` : 'not placed',
    ].join(' · ');
  }
}
