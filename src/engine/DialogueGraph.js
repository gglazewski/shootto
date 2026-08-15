// DialogueGraph.js — a small branching-conversation data shape shared by
// quests (the "about the quest" tree) and plain NPC small talk.
//
// Shape:
//   { prompt?: string,       // the player's hub reply that opens the tree
//     start: nodeId,
//     nodes: { [nodeId]: {
//       say: [line, ...],    // the NPC speaks these in order…
//       choices: [{ label, next: nodeId|null }, ...],
//                            // …then the player picks a reply
//       pos?: [x, y] } } }   // editor map placement — the runtime ignores it
//
// A node with no choices drops back to the conversation hub after its lines;
// a choice whose `next` is null (or names no surviving node) ends the tree
// the same way — so every path through a graph terminates. The runtime that
// walks this lives in game/Dialogue.js; the editor in
// editor/npc/DialogueGraphEditor.js.
//
// Pure module (no three.js/DOM) so it unit tests in Node.

function cleanLines(v) {
  return (Array.isArray(v) ? v : [])
    .filter((l) => typeof l === 'string' && l.trim().length)
    .map((l) => l.trim());
}

/** Coerce a candidate graph into a valid one, or null when it has no usable
 *  nodes. Empty nodes (nothing said, no choices) are dropped; choices whose
 *  `next` names a missing node become tree-enders (`next: null`); `start`
 *  falls back to the first surviving node. */
export function normalizeDialogueGraph(g) {
  if (!g || typeof g !== 'object' || !g.nodes || typeof g.nodes !== 'object') return null;
  const nodes = {};
  for (const [rawId, n] of Object.entries(g.nodes)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;
    const say = cleanLines(n?.say);
    const choices = (Array.isArray(n?.choices) ? n.choices : [])
      .map((c) => {
        const label = typeof c?.label === 'string' ? c.label.trim() : '';
        if (!label) return null;
        const next = typeof c?.next === 'string' && c.next.trim() ? c.next.trim() : null;
        return { label, next };
      })
      .filter(Boolean);
    if (!say.length && !choices.length) continue;
    const pos = Array.isArray(n?.pos) && n.pos.length === 2 && n.pos.every((v) => Number.isFinite(Number(v)))
      ? n.pos.map((v) => Math.round(Number(v)))
      : null;
    nodes[id] = { say, choices, ...(pos ? { pos } : {}) };
  }
  // A choice pointing at a dropped/unknown node ends the tree instead.
  for (const n of Object.values(nodes)) {
    n.choices = n.choices.map((c) => (c.next && nodes[c.next] ? c : { ...c, next: null }));
  }
  const ids = Object.keys(nodes);
  if (!ids.length) return null;
  const start = typeof g.start === 'string' && nodes[g.start.trim()] ? g.start.trim() : ids[0];
  const prompt = typeof g.prompt === 'string' && g.prompt.trim() ? g.prompt.trim() : null;
  return { ...(prompt ? { prompt } : {}), start, nodes };
}
