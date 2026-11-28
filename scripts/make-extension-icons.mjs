// Erzeugt die PNG-Symbole der Chrome-Erweiterung (extension/icons/*.png) ohne Abhängigkeiten.
// Ein Schlüssel auf einem abgerundeten Quadrat in der Farbe des Projekt-Symbols.
//   node scripts/make-extension-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0xc0, 0x26, 0xd3];
const FG = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Form in Einheitskoordinaten 0..1: Hintergrund (abgerundetes Quadrat) und Schlüssel. */
function inRoundRect(x, y, r) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function inKey(x, y) {
  const ring = Math.hypot(x - 0.36, y - 0.5);
  const head = ring <= 0.2 && ring >= 0.09;
  const shaft = x >= 0.5 && x <= 0.8 && y >= 0.47 && y <= 0.55;
  const tooth1 = x >= 0.66 && x <= 0.72 && y >= 0.55 && y <= 0.66;
  const tooth2 = x >= 0.75 && x <= 0.81 && y >= 0.55 && y <= 0.64;
  return head || shaft || tooth1 || tooth2;
}

function png(size) {
  const samples = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (inRoundRect(x, y, 0.22)) {
            bg++;
            if (inKey(x, y)) fg++;
          }
        }
      }
      const total = samples * samples;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const keyShare = bg ? fg / bg : 0;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] * (1 - keyShare) + FG[i] * keyShare);
      raw[o + 3] = Math.round((bg / total) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 Bit, RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('extension/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`extension/icons/${size}.png`, png(size));
console.log('extension/icons/{16,32,48,128}.png geschrieben');
