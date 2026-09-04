/**
 * Распаковка zip средствами Node.
 *
 * Своя, а не через внешнюю утилиту, потому что ни одной подходящей нет во всех
 * трёх местах, где это запускается. `tar` в Git Bash — GNU 1.34, и zip он не
 * читает совсем; он же принимает «C:\...» за имя удалённого хоста. `unzip` есть
 * в образе и в Git Bash, но не в голой Windows. PowerShell — наоборот. Полсотни
 * строк здесь дешевле, чем три ветки по платформам и отказ на четвёртой.
 *
 * Поддерживается ровно то, что встречается в архивах глифов: хранение без
 * сжатия и deflate. Zip64 не поддержан намеренно — он начинается за 4 ГБ и за
 * 65535 файлами, а архив начертаний на два порядка меньше по обоим счётам.
 */
import { inflateRawSync } from 'node:zlib';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Находит запись «конец центрального каталога» — она в хвосте файла. */
function findEocd(buf) {
  // Комментарий архива может быть до 64 КБ; дальше искать незачем.
  const from = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('это не zip: не найден конец центрального каталога');
}

/**
 * Разбирает центральный каталог: имя, метод сжатия, размеры и смещение данных.
 * Читается именно он, а не локальные заголовки подряд, потому что у локального
 * размеры могут стоять нулями со ссылкой на дескриптор после данных.
 */
function* entries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error(`повреждённый центральный каталог на записи ${i}`);
    }
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);

    yield { name, method, compressed, localAt };
    at += 46 + nameLength + extraLength + commentLength;
  }
}

/** Данные одной записи, распакованные. */
function read(buf, entry) {
  // Длины имени и «extra» в локальном заголовке свои — у центрального они
  // часто другие, и брать их оттуда значит промахнуться мимо начала данных.
  const nameLength = buf.readUInt16LE(entry.localAt + 26);
  const extraLength = buf.readUInt16LE(entry.localAt + 28);
  const from = entry.localAt + 30 + nameLength + extraLength;
  const raw = buf.subarray(from, from + entry.compressed);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${entry.name}: неподдерживаемый метод сжатия ${entry.method}`);
}

/**
 * Распаковывает в `destination` те записи, чьё имя принимает `accept`.
 *
 * Возвращает число распакованных файлов. Каталоги внутри архива не создаются
 * сами по себе — только под файлы, которые действительно нужны.
 */
export async function unzipInto(zipPath, destination, accept = () => true) {
  const buf = await readFile(zipPath);
  let written = 0;

  for (const entry of entries(buf)) {
    if (entry.name.endsWith('/')) continue;
    if (!accept(entry.name)) continue;

    // Имя внутри архива — это данные, а не путь, которому можно верить: запись
    // вида «../../что-нибудь» вышла бы за каталог назначения.
    const target = path.resolve(destination, entry.name);
    const inside = path.relative(destination, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new Error(`запись «${entry.name}» выводит за пределы каталога распаковки`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, read(buf, entry));
    written += 1;
  }

  return written;
}
