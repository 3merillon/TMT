/** Pixel-size-specific vector masters: do not downsample the detailed title emblem. */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

function master(size) {
  const tiny = size === 16;
  // At 16 px leave a full visible gap around the hub, and omit surface wear.
  const inner = tiny ? 3.4 : 3.2, outer = 7, hub = 1.5;
  const angle = 58 * Math.PI / 180;
  const x = r => (r * Math.cos(angle)).toFixed(4), y = r => (r * Math.sin(angle)).toFixed(4);
  const d = `M${x(outer)} ${y(outer)}A${outer} ${outer} 0 0 1 -${x(outer)} ${y(outer)}L-${x(inner)} ${y(inner)}A${inner} ${inner} 0 0 0 ${x(inner)} ${y(inner)}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}">
<title>Tiny Metal Tank</title><defs>
<linearGradient id="paint" x2=".2" y2="1"><stop stop-color="#ffcc45"/><stop offset="1" stop-color="#f1a318"/></linearGradient>
<linearGradient id="steel" x2=".3" y2="1"><stop stop-color="#f4f3e9"/><stop offset=".5" stop-color="#d7ddd8"/><stop offset="1" stop-color="#a7b5af"/></linearGradient>
<path id="blade" d="${d}"/>
<g id="trefoil"><use href="#blade"/><use href="#blade" transform="rotate(120)"/><use href="#blade" transform="rotate(240)"/></g>
</defs><g transform="translate(8 8)" stroke-linejoin="round">
<use href="#trefoil" fill="url(#paint)" stroke="#37433f" stroke-width="${tiny ? .8 : .75}"/>
<use href="#trefoil" fill="none" stroke="url(#steel)" stroke-width="${tiny ? .4 : .38}"/>
<circle r="${hub}" fill="url(#paint)" stroke="#37433f" stroke-width=".7"/>
<circle r="${hub}" fill="none" stroke="url(#steel)" stroke-width=".35"/>
</g></svg>\n`;
}

const sizes = [16, 32, 48], frames = [];
for (const size of sizes) {
  const png = await sharp(Buffer.from(master(size))).png().toBuffer();
  writeFileSync(new URL(`../public/brand/tmt-favicon-${size}.png`, import.meta.url), png);
  // A standard 32-bit Windows DIB keeps tab icons compatible with browsers that
  // don't render PNG-compressed small ICO entries reliably.
  const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
  const maskStride = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const from = (y * size + x) * 4, row = size - 1 - y, to = 40 + (row * size + x) * 4;
    dib[to] = rgba[from + 2]; dib[to + 1] = rgba[from + 1]; dib[to + 2] = rgba[from]; dib[to + 3] = rgba[from + 3];
    if (!rgba[from + 3]) dib[40 + size * size * 4 + row * maskStride + (x >> 3)] |= 128 >> (x & 7);
  }
  frames.push(dib);
}
// ICO with native-size frames: browser tabs can select an exact device-pixel match.
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = sizes[i];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += frames[i].length;
}
writeFileSync(new URL('../public/favicon.ico', import.meta.url), Buffer.concat([header, ...frames]));
writeFileSync(new URL('../public/brand/tmt-mark.svg', import.meta.url), master(32));
console.log(`Favicons: native ${sizes.join(', ')} px PNGs and ${offset}-byte ICO.`);
