/**
 * One-shot index of the VZD open XML dumps.
 * data.gov.lv does not put these in the CKAN DataStore, so a
 * cadastre-number lookup has to be local.
 *
 *   npx tsx server/indexCadastre.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cadastreDigits } from './fields.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'cadastre-src');
const OUT = path.join(ROOT, 'data', 'cadastre.sqlite');

const DUMPS = [
  {
    name: 'ownership',
    url: 'https://data.gov.lv/dati/dataset/be841486-4af9-4d38-aa14-6502a2ddb517/resource/a0d801da-8eb0-4426-9087-50e8139bce39/download/ownership.zip',
    open: '<OwnershipItemData>',
    close: '</OwnershipItemData>',
  },
  {
    name: 'address',
    url: 'https://data.gov.lv/dati/dataset/be841486-4af9-4d38-aa14-6502a2ddb517/resource/2aeea249-6948-4713-92c2-e01543ea0f33/download/address.zip',
    open: '<AddressItemData>',
    close: '</AddressItemData>',
  },
  {
    name: 'property',
    url: 'https://data.gov.lv/dati/dataset/be841486-4af9-4d38-aa14-6502a2ddb517/resource/931e6299-61ba-477b-ba8d-f0fb30db9667/download/property.zip',
    open: '<PropertyItemData>',
    close: '</PropertyItemData>',
  },
  {
    name: 'encumbrance',
    url: 'https://data.gov.lv/dati/dataset/be841486-4af9-4d38-aa14-6502a2ddb517/resource/ca8a415c-a894-427f-b14d-d1e44c582620/download/encumbrance.zip',
    open: '<EncumbranceItemData>',
    close: '</EncumbranceItemData>',
  },
];

function tag(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return match ? match[1].trim() : '';
}

function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((match) => match[1].trim());
}

function walkXml(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkXml(full));
    } else if (entry.name.endsWith('.xml')) {
      found.push(full);
    }
  }
  return found;
}

function download(url: string, dest: string): void {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    console.log('have', dest);
    return;
  }
  console.log('get', url);
  const result = spawnSync('curl', ['-L', '--fail', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`download failed ${url}`);
  }
}

function unzip(zip: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  if (walkXml(dest).length) {
    console.log('extracted', dest);
    return;
  }
  const result = spawnSync('unzip', ['-o', '-q', zip, '-d', dest], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`unzip failed ${zip}`);
  }
}

/**
 * The dumps are one long line per file. Keep a carry buffer so a
 * tag split across two reads is not dropped.
 */
async function scan(file: string, open: string, close: string, onItem: (xml: string) => void): Promise<void> {
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
  let carry = '';
  for await (const chunk of stream) {
    carry += chunk.toString('utf8');
    let start = carry.indexOf(open);
    while (start !== -1) {
      const end = carry.indexOf(close, start);
      if (end === -1) {
        break;
      }
      onItem(carry.slice(start, end + close.length));
      carry = carry.slice(end + close.length);
      start = carry.indexOf(open);
    }
    if (carry.length > 8_000_000) {
      const keep = carry.lastIndexOf(open);
      carry = keep >= 0 ? carry.slice(keep) : '';
    }
  }
}

function formatAddress(xml: string): string {
  const street = [tag(xml, 'Street'), tag(xml, 'House'), tag(xml, 'Apartment')].filter(Boolean).join(' ');
  const place = [tag(xml, 'Village'), tag(xml, 'Parish'), tag(xml, 'Town'), tag(xml, 'County')].filter(Boolean).join(', ');
  return [street, place, tag(xml, 'PostIndex')].filter(Boolean).join(', ');
}

async function main(): Promise<void> {
  fs.mkdirSync(SRC, { recursive: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.building`;
  if (fs.existsSync(tmp)) {
    fs.rmSync(tmp);
  }

  const db = new DatabaseSync(tmp);
  db.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE owner (nr TEXT, object_type TEXT, status TEXT, person TEXT);
    CREATE TABLE address (nr TEXT, text TEXT, ar_code TEXT);
    CREATE TABLE link (property_nr TEXT, object_nr TEXT, object_kind TEXT);
    CREATE TABLE encumbrance (nr TEXT, code TEXT, name TEXT);
  `);

  const insertOwner = db.prepare('INSERT INTO owner (nr, object_type, status, person) VALUES (?, ?, ?, ?)');
  const insertAddress = db.prepare('INSERT INTO address (nr, text, ar_code) VALUES (?, ?, ?)');
  const insertLink = db.prepare('INSERT INTO link (property_nr, object_nr, object_kind) VALUES (?, ?, ?)');
  const insertEnc = db.prepare('INSERT INTO encumbrance (nr, code, name) VALUES (?, ?, ?)');

  for (const dump of DUMPS) {
    const zip = path.join(SRC, `${dump.name}.zip`);
    const dir = path.join(SRC, dump.name);
    download(dump.url, zip);
    unzip(zip, dir);
    const files = walkXml(dir);
    console.log(dump.name, files.length, 'xml');
    db.exec('BEGIN');
    let count = 0;
    for (const file of files) {
      console.log('scan', file);
      await scan(file, dump.open, dump.close, (xml) => {
        const nr = cadastreDigits(tag(xml, 'ObjectCadastreNr'));
        if (dump.name === 'ownership') {
          if (!nr) {
            return;
          }
          const type = tag(xml, 'ObjectType');
          const statuses = tags(xml, 'OwnershipStatus');
          const persons = tags(xml, 'PersonStatus');
          const size = Math.max(statuses.length, persons.length, 1);
          for (let index = 0; index < size; index += 1) {
            insertOwner.run(nr, type, statuses[index] || '', persons[index] || '');
            count += 1;
          }
        } else if (dump.name === 'address') {
          if (!nr) {
            return;
          }
          insertAddress.run(nr, formatAddress(xml), tag(xml, 'ARCode'));
          count += 1;
        } else if (dump.name === 'property') {
          const propertyNr = cadastreDigits(tag(xml, 'ProCadastreNr'));
          const objects = tags(xml, 'ObjectCadastreNrData');
          const kinds = tags(xml, 'ObjectKindData');
          objects.forEach((objectNr, index) => {
            const clean = cadastreDigits(objectNr);
            if (!propertyNr || !clean) {
              return;
            }
            insertLink.run(propertyNr, clean, kinds[index] || '');
            count += 1;
          });
        } else if (nr) {
          const codes = tags(xml, 'EncumbranceKindId');
          const names = tags(xml, 'EncumbranceKindName');
          const size = Math.max(codes.length, names.length);
          for (let index = 0; index < size; index += 1) {
            insertEnc.run(nr, codes[index] || '', names[index] || '');
            count += 1;
          }
        }
        if (count > 0 && count % 20000 === 0) {
          db.exec('COMMIT');
          db.exec('BEGIN');
          console.log(dump.name, count);
        }
      });
    }
    db.exec('COMMIT');
    console.log('done', dump.name, count);
  }

  console.log('indexing');
  db.exec(`
    CREATE INDEX idx_owner_nr ON owner(nr);
    CREATE INDEX idx_address_nr ON address(nr);
    CREATE INDEX idx_link_property ON link(property_nr);
    CREATE INDEX idx_link_object ON link(object_nr);
    CREATE INDEX idx_enc_nr ON encumbrance(nr);
  `);
  db.close();
  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT);
  }
  fs.renameSync(tmp, OUT);
  console.log('INDEX_OK', OUT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
