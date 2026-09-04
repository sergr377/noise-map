/**
 * Собирает подложку: векторные тайлы, глифы и стиль — всё, что раздаёт
 * `serveTiles` из каталога TILES_DIR.
 *
 * Три шага, каждый пропускается, если результат уже на месте:
 *
 *   1. planetiler.jar        — 89 МБ, кладётся в .tools/
 *   2. <регион>.pmtiles      — Planetiler по экстракту Geofabrik, обрезанному
 *                              рамкой региона; самый долгий шаг
 *   3. глифы Noto Sans       — из релиза openmaptiles/fonts, распаковываются
 *                              только нужные начертания
 *
 * Стиль (basemap/style.json) просто копируется: он лежит в репозитории, потому
 * что это исходник, а не результат сборки.
 *
 * Использование:
 *   node scripts/build-tiles.mjs                 # всё, чего не хватает
 *   node scripts/build-tiles.mjs --force         # пересобрать тайлы заново
 *   node scripts/build-tiles.mjs --skip-tiles    # только глифы и стиль
 *
 * Переменные окружения: TILES_DIR (куда класть), TILES_AREA и TILES_BOUNDS
 * (что собирать), PLANETILER_XMX (сколько кучи давать JVM).
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, copyFile, readdir, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Импорт ради побочного эффекта: lib.mjs поднимает HTTPS_PROXY в fetch, который
// иначе его игнорирует. Без прокси на этой машине не открывается ничего.
import './lib.mjs';
import { unzipInto } from './unzip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TILES_DIR = path.resolve(ROOT, process.env.TILES_DIR ?? 'tiles');
const TOOLS_DIR = path.join(ROOT, '.tools');

/**
 * Что собираем. Geofabrik режет Россию по федеральным округам, отдельного
 * экстракта на Краснодарский край у него нет, поэтому берётся Южный ФО и
 * обрезается рамкой края — Planetiler умеет это на входе, и в тайлы лишнее
 * просто не попадает.
 */
const AREA = process.env.TILES_AREA ?? 'russia/south-fed-district';
/** запад,юг,восток,север — Краснодарский край с небольшим запасом. */
const BOUNDS = process.env.TILES_BOUNDS ?? '36.5,43.3,41.9,46.8';
const OUTPUT_NAME = process.env.TILES_NAME ?? 'basemap.pmtiles';

const PLANETILER_JAR = path.join(TOOLS_DIR, 'planetiler.jar');
const PLANETILER_URL =
  'https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar';

const FONTS_URL = 'https://github.com/openmaptiles/fonts/releases/download/v2.0/noto-sans.zip';
/**
 * Начертания, которые называет стиль. Распаковывается только они: в архиве их
 * втрое больше, а каждое — это сотни файлов по диапазонам кодов.
 */
const FONT_FACES = ['Noto Sans Regular', 'Noto Sans Bold'];

const args = new Set(process.argv.slice(2));
const force = args.has('--force');

const log = (...parts) => console.log(...parts);

async function exists(file) {
  return (await stat(file).catch(() => null)) !== null;
}

/** Скачивает в файл через временное имя: оборванная закачка не должна выглядеть
 *  как готовый файл при следующем запуске. */
async function download(url, target) {
  const partial = `${target}.part`;
  log(`  качаю ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url} -> HTTP ${res.status}`);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  await rename(partial, target);
  const info = await stat(target);
  log(`  готово: ${(info.size / 1048576).toFixed(1)} МБ`);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} вышел с кодом ${code}`)),
    );
  });
}

/**
 * Настройки прокси для JVM.
 *
 * Planetiler качает и экстракт, и вспомогательные слои сам, а Java, как и Node,
 * переменные окружения про прокси не читает — их надо передать системными
 * свойствами. Без этого шаг загрузки выглядит как недоступный Geofabrik.
 */
function javaProxyArgs() {
  const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!raw) return [];
  const url = new URL(raw);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const nonProxy = (process.env.NO_PROXY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('|');
  const flags = [
    `-Dhttps.proxyHost=${url.hostname}`,
    `-Dhttps.proxyPort=${port}`,
    `-Dhttp.proxyHost=${url.hostname}`,
    `-Dhttp.proxyPort=${port}`,
  ];
  if (nonProxy) flags.push(`-Dhttp.nonProxyHosts=${nonProxy}`);
  return flags;
}

async function buildTiles() {
  const output = path.join(TILES_DIR, OUTPUT_NAME);
  if (!force && (await exists(output))) {
    log(`тайлы уже собраны: ${output} (--force, чтобы пересобрать)`);
    return;
  }

  if (!(await exists(PLANETILER_JAR))) {
    log('Planetiler:');
    await download(PLANETILER_URL, PLANETILER_JAR);
  }

  await mkdir(TILES_DIR, { recursive: true });
  const work = path.join(TOOLS_DIR, 'planetiler-tmp');

  log(`\nсборка тайлов: ${AREA}, рамка ${BOUNDS}`);
  log('это надолго — десятки минут и несколько гигабайт временных файлов\n');

  await run('java', [
    `-Xmx${process.env.PLANETILER_XMX ?? '4g'}`,
    ...javaProxyArgs(),
    '-jar',
    PLANETILER_JAR,
    '--download',
    `--area=${AREA}`,
    `--bounds=${BOUNDS}`,
    // Максимальный зум тайлов. Дальше карта дотягивает overzoom'ом — на 17,
    // куда упирается zoomForDisc, векторные тайлы z14 растягиваются без
    // видимой потери: геометрия остаётся геометрией, а не пикселями.
    '--maxzoom=14',
    `--tmpdir=${work}`,
    `--output=${output}`,
    '--force',
  ]);

  // Временные файлы Planetiler — это гигабайты, и после успешной сборки они
  // не нужны. На машине, где под всё про всё десяток гигабайт, это не уборка
  // из аккуратности, а условие следующего запуска.
  await rm(work, { recursive: true, force: true });

  const info = await stat(output);
  log(`\nтайлы: ${output}, ${(info.size / 1048576).toFixed(1)} МБ`);
}

async function buildGlyphs() {
  const glyphs = path.join(TILES_DIR, 'fonts');
  // Готовность проверяется по начертанию, а не по каталогу: каталог создаётся
  // до распаковки, и оборвавшийся запуск оставил бы пустую папку, которую
  // следующий принял бы за готовые глифы.
  if (!force && (await exists(path.join(glyphs, FONT_FACES[0])))) {
    log(`глифы уже на месте: ${glyphs}`);
    return;
  }

  const zip = path.join(TOOLS_DIR, 'noto-sans.zip');
  if (!(await exists(zip))) {
    log('глифы:');
    await download(FONTS_URL, zip);
  }

  const unpacked = path.join(TOOLS_DIR, 'fonts-unpacked');
  await rm(unpacked, { recursive: true, force: true });

  // Из архива достаются только названные начертания: в нём их втрое больше, а
  // каждое — это сотни файлов по диапазонам кодов.
  const written = await unzipInto(zip, unpacked, (name) =>
    FONT_FACES.some((face) => name.includes(`${face}/`)),
  );
  if (written === 0) {
    throw new Error(
      `в архиве не нашлось ни одного из начертаний ${FONT_FACES.join(', ')} — ` +
        'проверьте FONT_FACES и содержимое архива',
    );
  }

  // Начертания лежат либо в корне архива, либо в одном вложенном каталоге.
  const top = await readdir(unpacked, { withFileTypes: true });
  const base =
    top.length === 1 && top[0].isDirectory() && !FONT_FACES.includes(top[0].name)
      ? path.join(unpacked, top[0].name)
      : unpacked;

  await mkdir(glyphs, { recursive: true });
  for (const face of FONT_FACES) {
    const from = path.join(base, face);
    if (!(await exists(from))) throw new Error(`в архиве нет начертания «${face}»`);
    await rm(path.join(glyphs, face), { recursive: true, force: true });
    await rename(from, path.join(glyphs, face));
    log(`  ${face}`);
  }

  await rm(unpacked, { recursive: true, force: true });
  log(`глифы: ${glyphs} (${written} файлов)`);
}

async function copyStyle() {
  const from = path.join(ROOT, 'basemap', 'style.json');
  const to = path.join(TILES_DIR, 'style.json');
  await mkdir(TILES_DIR, { recursive: true });
  await copyFile(from, to);
  log(`стиль: ${to}`);
}

if (!args.has('--skip-tiles')) await buildTiles();
await buildGlyphs();
await copyStyle();

log('\nподложка собрана. Сервер отдаёт её из TILES_DIR по /tiles/.');
