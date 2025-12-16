const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const svgPath = path.join(__dirname, 'assets', 'icon.svg');
const pngPath = path.join(__dirname, 'assets', 'icon.png');

async function generateIcons() {
  console.log('Converting SVG to PNG...');

  const svgBuffer = fs.readFileSync(svgPath);

  await sharp(svgBuffer)
    .resize(1024, 1024)
    .png()
    .toFile(pngPath);

  console.log('PNG created at:', pngPath);
  console.log('Run: npx electron-icon-builder -i assets/icon.png -o assets --flatten');
}

generateIcons().catch(console.error);
