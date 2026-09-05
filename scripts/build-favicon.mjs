/**
 * Собирает web/public/favicon.ico из того же рисунка, что и favicon.svg.
 *
 * Зачем вообще .ico, если есть SVG: Safari до 16 и старый Edge SVG-иконку не
 * понимают и оставляют вкладку пустой. Растровая копия нужна только им.
 *
 * Почему рисунок здесь повторён кодом, а не конвертируется из SVG: любой
 * конвертер — это внешний бинарник или пакет ради одной иконки 32x32 из пяти
 * фигур. Фигуры описаны в SHAPES, и при правке favicon.svg их надо править
 * следом — это единственное место, где два файла обязаны совпадать.
 *
 * Формат — BMP внутри ICO, а не PNG внутри ICO: PNG понимают не все читатели
 * .ico, а ради них всё и затевалось.
 *
 *   node scripts/build-favicon.mjs
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'web', 'public', 'favicon.ico');

/** Размеры, которые кладутся в файл. 48 — для плиток и списков Windows. */
const SIZES = [16, 32, 48];

/** Радиус скругления плитки в координатах SVG (rx="7" при viewBox 32). */
const CORNER = 7;

/** Кольца изофон снаружи внутрь; фон плитки — первый элемент без радиуса. */
const SHAPES = [
  { r: Infinity, color: '#cfe4cc' },
  { r: 13, color: '#e3f2bf' },
  { r: 9.5, color: '#f4c683' },
  { r: 6, color: '#cd463f' },
  { r: 2.6, color: '#430a4a' },
];
const CX = 13.5;
const CY = 18;

const rgb = (hex) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/** Внутри ли точка скруглённого квадрата 32x32. */
function insideTile(x, y) {
  const dx = Math.max(CORNER - x, x - (32 - CORNER), 0);
  const dy = Math.max(CORNER - y, y - (32 - CORNER), 0);
  return dx * dx + dy * dy <= CORNER * CORNER;
}

function colorAt(x, y) {
  if (!insideTile(x, y)) return null;
  const d2 = (x - CX) ** 2 + (y - CY) ** 2;
  let picked = SHAPES[0];
  for (const shape of SHAPES) if (d2 <= shape.r * shape.r) picked = shape;
  return rgb(picked.color);
}

/**
 * Рисует иконку размера `size` в RGBA, сглаживая четырёхкратной выборкой:
 * скруглённый угол и внешнее кольцо на 16 px иначе выходят рваными.
 */
function render(size) {
  const SS = 4;
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size) * 32;
          const v = ((y + (sy + 0.5) / SS) / size) * 32;
          const c = colorAt(u, v);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      const i = (y * size + x) * 4;
      if (covered === 0) continue;
      px[i] = Math.round(r / covered);
      px[i + 1] = Math.round(g / covered);
      px[i + 2] = Math.round(b / covered);
      px[i + 3] = Math.round((covered / (SS * SS)) * 255);
    }
  }
  return px;
}

/**
 * Одно изображение ICO: BITMAPINFOHEADER, строки BGRA снизу вверх и маска
 * прозрачности. Маска для 32-битных иконок не используется, но её отсутствие
 * ломает часть читателей, поэтому она пишется нулями.
 */
function dib(size, px) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND, как требует формат
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = (y * size + x) * 4;
      xor[to] = px[from + 2];
      xor[to + 1] = px[from + 1];
      xor[to + 2] = px[from];
      xor[to + 3] = px[from + 3];
    }
  }

  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(maskRow * size)]);
}

const images = SIZES.map((size) => ({ size, data: dib(size, render(size)) }));

const dir = Buffer.alloc(6 + images.length * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(images.length, 4);

let offset = dir.length;
images.forEach((image, index) => {
  const at = 6 + index * 16;
  dir.writeUInt8(image.size, at);
  dir.writeUInt8(image.size, at + 1);
  dir.writeUInt16LE(1, at + 4);
  dir.writeUInt16LE(32, at + 6);
  dir.writeUInt32LE(image.data.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += image.data.length;
});

const ico = Buffer.concat([dir, ...images.map((image) => image.data)]);
await writeFile(OUTPUT, ico);
console.log(`${OUTPUT}: ${SIZES.join(', ')} px, ${ico.length} байт`);
