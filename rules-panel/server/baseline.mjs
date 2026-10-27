import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { PanelError } from './workspace-service.mjs';

export const MAX_BASELINE_BYTES = 8 * 1024 * 1024;
const fail = message => { throw new PanelError(422, message); };
const clean = value => String(value ?? '').trim();

function xml(bytes, handlers = {}) {
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => fail('Plik zawiera niedozwolone deklaracje XML.'));
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler);
  const text = strFromU8(bytes);
  for (let offset = 0; offset < text.length; offset += 65536) parser.write(text.slice(offset, offset + 65536));
  parser.close();
}
const attr = (node, name) => Object.values(node.attributes).find(item => item.name === name || item.local === name)?.value;

function dateValue(value, date1904, numericAllowed = false) {
  const text = clean(value);
  let result;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    if (!numericAllowed) return null;
    const serial = Number(text);
    if (serial < 1 || serial > 200000 || !Number.isInteger(serial)) return null;
    result = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + serial * 86400000).toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z?)?$/.test(text)) result = text.slice(0, 10);
  else {
    const match = text.match(/^(\d{2})-(\d{2})-(\d{2}|\d{4})$/);
    if (match) result = `${match[3].length === 2 ? '20' : ''}${match[3]}-${match[2]}-${match[1]}`;
  }
  if (!result || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) return null;
  return result;
}

export function decodeBaseline(input) {
  if (!input || typeof input.filename !== 'string' || !/\.xlsx$/i.test(input.filename) || input.filename.length > 240 || /[\x00-\x1f\\/]/.test(input.filename)) fail('Wybierz plik Excel .xlsx.');
  if (typeof input.content !== 'string' || input.content.length > Math.ceil(MAX_BASELINE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) fail('Nieprawidlowy plik lub rozmiar przekraczajacy 8 MB.');
  let bytes;
  try { bytes = Uint8Array.from(atob(input.content), character => character.charCodeAt(0)); }
  catch { fail('Nieprawidlowe kodowanie pliku.'); }
  if (!bytes.length || bytes.length > MAX_BASELINE_BYTES) fail('Plik jest pusty lub przekracza 8 MB.');
  return bytes;
}

export async function inspectBaseline(bytes, documents, { allowUnknownZones = false } = {}) {
  let files;
  let expanded = 0;
  const names = new Set();
  try {
    files = unzipSync(bytes, { filter: entry => {
      if (names.has(entry.name) || entry.name.includes('..') || entry.name.startsWith('/')) fail('Nieprawidlowa struktura archiwum XLSX.');
      names.add(entry.name); expanded += entry.originalSize;
      if (expanded > 64 * 1024 * 1024 || names.size > 1000) fail('Plik jest zbyt zlozony do kontroli w panelu.');
      if (/vbaProject|externalLinks/i.test(entry.name)) fail('Plik zawiera makra lub zewnetrzne polaczenia.');
      return /\.xml$|\.rels$|\.vml$/.test(entry.name);
    } });
    for (const data of Object.values(files)) xml(data);
  } catch (error) { if (error instanceof PanelError) throw error; fail('Plik XLSX jest uszkodzony. Otworz go w Excelu i zapisz ponownie.'); }
  for (const name of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) if (!files[name]) fail('Brakuje wymaganych czesci pliku XLSX.');
  const defaultTypes = new Map(); const overrideTypes = new Map();
  xml(files['[Content_Types].xml'], { opentag: node => {
    if (node.local === 'Default') defaultTypes.set(attr(node, 'Extension'), attr(node, 'ContentType'));
    if (node.local === 'Override') overrideTypes.set(attr(node, 'PartName'), attr(node, 'ContentType'));
  } });
  const contentType = part => overrideTypes.has(`/${part}`) ? overrideTypes.get(`/${part}`) : defaultTypes.get(part.slice(part.lastIndexOf('.') + 1));
  if (contentType('xl/workbook.xml') !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') fail('Brak prawidlowej deklaracji skoroszytu XLSX.');
  for (const [name, data] of Object.entries(files)) if (name.endsWith('.rels')) {
    const base = `https://xlsx.invalid/${name.slice(0, name.lastIndexOf('_rels/'))}`;
    xml(data, { opentag: node => {
      if (node.local !== 'Relationship' || attr(node, 'TargetMode') === 'External') return;
      const target = attr(node, 'Target');
      if (!target) fail('Puste powiazanie wewnatrz XLSX.');
      const resolved = new URL(target, base);
      if (resolved.origin !== 'https://xlsx.invalid' || !names.has(resolved.pathname.slice(1))) fail('Plik XLSX odwoluje sie do brakujacego elementu.');
    } });
  }
  let sheetId;
  let date1904 = false;
  xml(files['xl/workbook.xml'], { opentag: node => {
    if (node.local === 'sheet' && attr(node, 'name') === 'Sheet1') sheetId = attr(node, 'r:id');
    if (node.local === 'workbookPr') date1904 = ['1', 'true'].includes(attr(node, 'date1904'));
  } });
  if (!sheetId) fail('Brak arkusza Sheet1.');
  let target;
  xml(files['xl/_rels/workbook.xml.rels'], { opentag: node => {
    if (node.local === 'Relationship' && attr(node, 'Id') === sheetId && attr(node, 'TargetMode') !== 'External' && attr(node, 'Type') === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet') target = attr(node, 'Target');
  } });
  const sheetPath = target?.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!files[sheetPath] || contentType(sheetPath) !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml') fail('Nie mozna odczytac arkusza Sheet1.');
  const formats = new Map(); const dateStyles = []; const stack = [];
  if (files['xl/styles.xml']) xml(files['xl/styles.xml'], {
    opentag: node => {
      if (node.local === 'numFmt') formats.set(Number(attr(node, 'numFmtId')), attr(node, 'formatCode'));
      if (node.local === 'xf' && stack.at(-1) === 'cellXfs') {
        const id = Number(attr(node, 'numFmtId'));
        const format = (formats.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
        dateStyles.push([14, 15, 16, 17, 22].includes(id) || /[dy]/i.test(format));
      }
      stack.push(node.local);
    }, closetag: () => { stack.pop(); },
  });
  const strings = [];
  if (files['xl/sharedStrings.xml']) {
    let value = ''; let capture = false;
    xml(files['xl/sharedStrings.xml'], {
      opentag: node => { if (node.local === 'si') value = ''; if (node.local === 't') capture = true; },
      text: text => { if (capture) value += text; },
      closetag: node => { if (node.local === 't') capture = false; if (node.local === 'si') strings.push(value); },
    });
  }
  const groups = new Set(); const zones = new Set(); const pairs = new Set();
  const expectedGroups = [...new Set([...documents.excel.apply_groups, ...documents.excel.excluded_groups])];
  const expectedZones = (documents.locations.locations ?? documents.locations).flatMap(location => location.zones);
  const headers = ['Group', 'Description', 'Rate code', 'Zone', 'Booking start date', 'Booking end date', 'Pickup start date', 'Pickup end date', ...Array(6).fill('Per day')];
  const minimums = [1, 2, 3, 5, 8, 21]; const maximums = [1, 2, 4, 7, 20, 35];
  let row = {}; let rowDateStyles = {}; let rowNumber; let cell; let type; let style; let value = ''; let capture = false; let formula = false;
  let rowCount = 0; let firstDate; let lastDate; let previousRow = 0; const seenHeaders = new Set();
  const consumeRow = () => {
    if ([2, 3, 4].includes(rowNumber)) {
      seenHeaders.add(rowNumber);
      if (rowNumber === 4 && headers.some((header, index) => clean(row[String.fromCharCode(65 + index)]) !== header)) fail('Uklad kolumn nie odpowiada plikowi importowemu (A-N).');
      if (rowNumber < 4 && (rowNumber === 2 ? minimums : maximums).some((days, index) => Number(row[String.fromCharCode(73 + index)]) !== days)) fail('Nieprawidlowe przedzialy najmu. Wymagane: 1, 2, 3-4, 5-7, 8-20, 21-35.');
    }
    if (rowNumber < 5 || Object.values(row).every(value => clean(value) === '')) return;
    const group = clean(row.A); const zone = clean(row.D);
    if (!expectedGroups.includes(group)) fail(`Nieznana klasa ${group || '(pusta)'} w wierszu ${rowNumber}. Najpierw uzgodnij klasy w zasadach.`);
    if (!expectedZones.includes(zone) && !(allowUnknownZones === true && /^[A-Z0-9]{2,12}$/.test(zone))) fail(`Nieznana lokalizacja ${zone || '(pusta)'} w wierszu ${rowNumber}.`);
    const dates = Object.fromEntries(['E', 'F', 'G', 'H'].map(column => [column, dateValue(row[column], date1904, rowDateStyles[column])]));
    for (const column of ['E', 'F', 'G', 'H']) if (!dates[column]) fail(`Nieprawidlowa data w ${column}${rowNumber}.`);
    const pickup = dates.G; const end = dates.H;
    if (pickup > end || dates.E > dates.F) fail(`Poczatek okresu jest pozniejszy od konca w wierszu ${rowNumber}.`);
    for (const column of ['I', 'J', 'K', 'L', 'M', 'N']) if (!clean(row[column]) || !Number.isFinite(Number(row[column])) || Number(row[column]) <= 0) fail(`Brak dodatniej stawki w ${column}${rowNumber}.`);
    if ((documents.excel.omitted_group_zones?.[zone] ?? []).includes(group)) fail(`Klasa ${group} jest wykluczona z lokalizacji ${zone}.`);
    groups.add(group); zones.add(zone); pairs.add(`${group}/${zone}`); rowCount++;
    if (!firstDate || pickup < firstDate) firstDate = pickup;
    if (!lastDate || end > lastDate) lastDate = end;
  };
  xml(files[sheetPath], {
    opentag: node => {
      if (node.local === 'row') {
        row = {}; rowDateStyles = {}; rowNumber = Number(attr(node, 'r'));
        if (!Number.isInteger(rowNumber) || rowNumber <= previousRow) fail('Nieprawidlowa kolejnosc wierszy arkusza.');
        previousRow = rowNumber;
      }
      if (node.local === 'c') {
        cell = attr(node, 'r'); type = attr(node, 't'); style = Number(attr(node, 's') ?? 0); value = ''; formula = false;
        if (!/^[A-Z]+[1-9]\d*$/.test(cell ?? '') || Number(cell.match(/\d+$/)[0]) !== rowNumber) fail('Nieprawidlowe adresy komorek.');
      }
      if (node.local === 'f') formula = true;
      if (node.local === 'v' || node.local === 't') capture = true;
    },
    text: text => { if (capture) value += text; },
    closetag: node => {
      if (node.local === 'v' || node.local === 't') capture = false;
      if (node.local === 'c') {
        if (formula) fail(`Formula w ${cell}. Baza musi zawierac wartosci.`);
        const column = cell?.match(/^[A-Z]+/)?.[0];
        if (!column || Object.hasOwn(row, column)) fail('Nieprawidlowe adresy komorek.');
        if (type === 's' && strings[Number(value)] === undefined) fail(`Nieprawidlowy tekst w ${cell}.`);
        row[column] = type === 's' ? strings[Number(value)] : value;
        rowDateStyles[column] = (!type || type === 'n') && dateStyles[style] === true;
      }
      if (node.local === 'row') consumeRow();
    },
  });
  if (!rowCount || seenHeaders.size !== 3) fail('Brak kompletnych naglowkow lub stawek w Sheet1.');
  const missing = [...expectedGroups.filter(group => !groups.has(group)), ...expectedZones.filter(zone => !zones.has(zone))];
  if (missing.length) fail(`Brakuje klas/lokalizacji: ${missing.join(', ')}.`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), rowCount, groups: [...groups].sort(), zones: [...zones].sort(), pairs: [...pairs].sort(), firstDate, lastDate,
    ...(allowUnknownZones === true ? { unknownZones: [...zones].filter(zone => !expectedZones.includes(zone)).sort() } : {}) };
}

export function compareBaselineCoverage(next, previous) {
  const missing = previous.pairs.filter(pair => !next.pairs.includes(pair));
  if (missing.length) fail(`W porownaniu z obecna baza brakuje: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` oraz ${missing.length - 12} kolejnych` : ''}.`);
}
