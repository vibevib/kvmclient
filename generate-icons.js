// Renders assets/icon.svg into everything the packagers want:
// the PNG ladder, icon.icns for macOS and icon.ico for Windows.
//
//     node generate-icons.js
//
// This used to stop at the PNG and tell you to run `npx electron-icon-builder`,
// which drags in an abandoned phantomjs toolchain with critical advisories. The
// two formats it produced are easy enough to write here: .icns is one iconutil
// call, and .ico is a 6-byte header plus a directory of embedded PNGs.
//
// iconutil is macOS-only, so .icns is skipped elsewhere; everything else is
// cross-platform.

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ASSETS = path.join(__dirname, 'assets');
const OUT = path.join(ASSETS, 'icons');
const svgPath = path.join(ASSETS, 'icon.svg');

// The ladder main.js and the packagers reach for. 1024 is the retina 512.
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

// .icns wants Apple's naming, where @2x is the same pixel count as the next rung.
const ICNS_SLOTS = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
];

// .ico stores a size in one byte, so 256 is the ceiling and is written as 0.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const render = (svg, size) =>
  sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

function ico(entries) {
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0);                 // reserved
  dir.writeUInt16LE(1, 2);                 // 1 = icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e);      // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2);              // palette size: none, it is truecolour
    dir.writeUInt8(0, e + 3);              // reserved
    dir.writeUInt16LE(1, e + 4);           // colour planes
    dir.writeUInt16LE(32, e + 6);          // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
}

async function main() {
  const svg = fs.readFileSync(svgPath);
  fs.mkdirSync(OUT, { recursive: true });

  const pngs = new Map();
  for (const size of PNG_SIZES) {
    const buf = await render(svg, size);
    pngs.set(size, buf);
    fs.writeFileSync(path.join(OUT, `${size}x${size}.png`), buf);
  }
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngs.get(1024));
  console.log(`PNGs: ${PNG_SIZES.join(', ')}`);

  fs.writeFileSync(path.join(OUT, 'icon.ico'),
    ico(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))));
  console.log(`icon.ico: ${ICO_SIZES.join(', ')}`);

  if (os.platform() !== 'darwin') {
    console.log('icon.icns: skipped (iconutil is macOS-only)');
    return;
  }
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'icns-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const [name, size] of ICNS_SLOTS) fs.writeFileSync(path.join(set, name), pngs.get(size));
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')]);
  fs.rmSync(path.dirname(set), { recursive: true, force: true });
  console.log('icon.icns: ' + ICNS_SLOTS.map(([, s]) => s).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
