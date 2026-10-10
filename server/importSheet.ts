import { cadastreDigits, isCadastre, isRegcode } from './fields.ts';

export interface ImportRow {
  cadastre: string;
  address: string;
  applicant: string;
  applicantName: string;
}

export interface ImportSkip {
  line: number;
  reason: string;
}

const ROW_CAP = 40;

function foldHeader(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * One CSV line, quotes included. Latvian Excel uses semicolons.
 */
function splitCsv(line: string, delim: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delim && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function columnOf(headers: string[], kind: 'cadastre' | 'address' | 'applicant' | 'name'): number {
  return headers.findIndex((header) => {
    if (kind === 'cadastre') {
      return header.includes('kadastr') || header.includes('cadastre');
    }
    if (kind === 'address') {
      return header.includes('adres');
    }
    if (kind === 'applicant') {
      const aboutPerson = header.includes('reg') || header.includes('iesniedz') || header.includes('numur');
      return aboutPerson && !header.includes('kadastr') && !header.includes('adres');
    }
    return header.includes('nosauk') || header.includes('uznem') || header === 'name';
  });
}

/**
 * Sheet of sites. Header row is optional.
 * Without one, the order is cadastre, address, registration number, name.
 */
export function parseImportSheet(raw: string): { rows: ImportRow[]; skipped: ImportSkip[] } {
  const text = raw.replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const skipped: ImportSkip[] = [];
  if (!lines.length) {
    return { rows: [], skipped: [{ line: 1, reason: 'fails ir tukšs' }] };
  }

  const commas = (lines[0].match(/,/g) || []).length;
  const semis = (lines[0].match(/;/g) || []).length;
  const delim = semis > commas ? ';' : ',';
  const first = splitCsv(lines[0], delim).map(foldHeader);
  const headered = first.some((cell) => /kadastr|adres|reg|iesniedz|numur|nosauk/.test(cell));
  const headers = headered ? first : [];
  const start = headered ? 1 : 0;
  const cadastreCol = headered ? columnOf(headers, 'cadastre') : 0;
  const addressCol = headered ? columnOf(headers, 'address') : 1;
  const applicantCol = headered ? columnOf(headers, 'applicant') : 2;
  const nameCol = headered ? columnOf(headers, 'name') : 3;

  const rows: ImportRow[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const lineNo = index + 1;
    if (rows.length >= ROW_CAP) {
      skipped.push({ line: lineNo, reason: `limits ir ${ROW_CAP} rindas` });
      continue;
    }
    const cells = splitCsv(lines[index], delim);
    const cadastre = cadastreDigits(cells[cadastreCol] || '');
    if (!isCadastre(cadastre)) {
      skipped.push({ line: lineNo, reason: 'nav kadastra numura (11–17 cipari)' });
      continue;
    }
    const applicantRaw = cadastreDigits(cells[applicantCol] || '');
    const applicant = applicantRaw && isRegcode(applicantRaw) ? applicantRaw : '';
    if (applicantRaw && !applicant) {
      skipped.push({ line: lineNo, reason: 'reģistrācijas numuram jābūt 11 cipariem — rinda iet bez iesniedzēja' });
    }
    rows.push({
      cadastre,
      address: (cells[addressCol] || '').trim(),
      applicant,
      applicantName: nameCol >= 0 ? (cells[nameCol] || '').trim() : '',
    });
  }

  return { rows, skipped };
}
