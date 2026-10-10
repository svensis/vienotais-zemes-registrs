import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cadastreDigits } from './fields.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Built by server/indexCadastre.ts from the VZD XML dumps. */
export const CADASTRE_DB_PATH = path.join(ROOT, 'data', 'cadastre.sqlite');

export interface OwnerRow {
  nr: string;
  object_type: string;
  status: string;
  person: string;
}

export interface AddressRow {
  nr: string;
  text: string;
  ar_code: string;
}

export interface LinkRow {
  property_nr: string;
  object_nr: string;
  object_kind: string;
}

export interface EncumbranceRow {
  nr: string;
  code: string;
  name: string;
}

let db: DatabaseSync | null | undefined;

function open(): DatabaseSync | null {
  if (db !== undefined) {
    return db;
  }
  if (!fs.existsSync(CADASTRE_DB_PATH)) {
    db = null;
    return null;
  }
  try {
    db = new DatabaseSync(CADASTRE_DB_PATH, { readOnly: true });
    return db;
  } catch {
    db = null;
    return null;
  }
}

export function cadastreReady(): boolean {
  return open() != null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function cleanNumbers(values: string[]): string[] {
  return [...new Set(values.map(cadastreDigits).filter((value) => value.length >= 11))];
}

export function ownersFor(numbers: string[]): OwnerRow[] {
  const nrs = cleanNumbers(numbers);
  const handle = open();
  if (!handle || !nrs.length) {
    return [];
  }
  return handle
    .prepare(
      `SELECT nr, object_type, status, person FROM owner WHERE nr IN (${placeholders(nrs.length)}) LIMIT 40`,
    )
    .all(...nrs) as OwnerRow[];
}

export function addressesFor(numbers: string[]): AddressRow[] {
  const nrs = cleanNumbers(numbers);
  const handle = open();
  if (!handle || !nrs.length) {
    return [];
  }
  return handle
    .prepare(`SELECT nr, text, ar_code FROM address WHERE nr IN (${placeholders(nrs.length)}) LIMIT 12`)
    .all(...nrs) as AddressRow[];
}

/**
 * Property number ↔ parcel / building designation.
 * A search for either side should still find the owner.
 */
export function linksFor(number: string): LinkRow[] {
  const nr = cadastreDigits(number);
  const handle = open();
  if (!handle || nr.length < 11) {
    return [];
  }
  return handle
    .prepare(
      `SELECT property_nr, object_nr, object_kind FROM link
       WHERE property_nr = ? OR object_nr = ?
       LIMIT 30`,
    )
    .all(nr, nr) as LinkRow[];
}

export function encumbrancesFor(numbers: string[]): EncumbranceRow[] {
  const nrs = cleanNumbers(numbers);
  const handle = open();
  if (!handle || !nrs.length) {
    return [];
  }
  return handle
    .prepare(
      `SELECT nr, code, name FROM encumbrance WHERE nr IN (${placeholders(nrs.length)}) LIMIT 40`,
    )
    .all(...nrs) as EncumbranceRow[];
}
