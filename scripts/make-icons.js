// Builds the app icons from build/logo-source.png:
//   build/icon.png (1024), build/icon.icns (macOS), build/icon.ico (Windows), src/assets/logo.png (in-app)
// Run: npm run build:icons
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const src = path.join(root, 'build', 'logo-source.png');

async function cleaned() {
  // The artwork has a faint, speckled glow outside the rounded square; drop nearly-transparent pixels
  // so the Dock / taskbar icon has crisp edges.
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    data[i] = a < 130 ? 0 : a > 235 ? 255 : Math.round(((a - 130) / 105) * 255);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
}

(async () => {
  const base = await cleaned();
  // trim the transparent margin, then add a small even one so every platform's mask sits right
  const trimmed = await base.clone().png().toBuffer();
  const box = await sharp(trimmed).trim().toBuffer({ resolveWithObject: true });
  const side = Math.max(box.info.width, box.info.height);
  const pad = Math.round(side * 0.04);
  const square = await sharp(box.data)
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const png = (size) => sharp(square).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), await png(1024));
  fs.writeFileSync(path.join(root, 'src', 'assets', 'logo.png'), await png(256));

  // macOS .icns via iconutil
  if (process.platform === 'darwin') {
    const set = path.join(root, 'build', 'icon.iconset');
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), await png(s));
      fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), await png(s * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'build', 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
  }

  // Windows .ico (16–256)
  const pngToIco = require('png-to-ico');
  const sizes = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(png));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), await (pngToIco.default || pngToIco)(sizes));
  console.log('icons written to build/ and src/assets/logo.png');
})();
