import fs from 'node:fs';

// Landed hits before breaking. Imp zombies have 30 hp, so the 18-dmg bat
// kills one in 2 hits — durability 6 = exactly 3 zombies.
const DURABILITY = {
  bejsbol: 6,
  balisong: 9,
  tulipan: 8,
  kastet: 12,
  tonfa_pr24: 15,
};

for (const file of process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let patched = 0;
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      if (o.id in DURABILITY && o.stats && typeof o.stats === 'object' && o.weapon) {
        o.stats.durability = DURABILITY[o.id];
        patched++;
      }
      Object.values(o).forEach(walk);
    }
  })(data);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(file, '->', patched, 'weapons patched');
}
