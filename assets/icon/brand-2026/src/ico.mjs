// Минимальный упаковщик .ico из готовых PNG (Windows Vista+ читает PNG внутри ICO).
import { readFileSync, writeFileSync } from 'node:fs';
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => readFileSync(`png/${s}.png`));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const p = 6 + 16 * i;
  head.writeUInt8(s === 256 ? 0 : s, p);      // ширина (0 = 256)
  head.writeUInt8(s === 256 ? 0 : s, p + 1);  // высота
  head.writeUInt8(0, p + 2); head.writeUInt8(0, p + 3);
  head.writeUInt16LE(1, p + 4); head.writeUInt16LE(32, p + 6);
  head.writeUInt32LE(pngs[i].length, p + 8);
  head.writeUInt32LE(offset, p + 12);
  offset += pngs[i].length;
});
writeFileSync('icon.ico', Buffer.concat([head, ...pngs]));
console.log('icon.ico:', sizes.join(','), '—', offset, 'байт');
