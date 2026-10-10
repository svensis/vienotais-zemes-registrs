import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SEED_CLIENTS, SELECTION_ID, cadastreDigits } from './fields.ts';
import type {
  AuditEvent,
  Client,
  Fact,
  FieldKey,
  FactStatus,
  Selection,
  SourceHealth,
  SourceId,
} from './types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'poc.sqlite');

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('Datubāze nav inicializēta.');
  }
  return db;
}

/**
 * Opens the local SQLite file and seeds the single PoC atlase
 * if this is a first run. Confirmations live here so a refresh
 * does not throw away the review trail.
 */
export function initDb(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS selection (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client (
      id TEXT PRIMARY KEY,
      selection_id TEXT NOT NULL,
      name TEXT NOT NULL,
      regcode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (selection_id) REFERENCES selection(id)
    );

    CREATE TABLE IF NOT EXISTS fact (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      proof_url TEXT NOT NULL DEFAULT '',
      fetched_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      corrected_value TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NOT NULL DEFAULT '',
      reviewer TEXT NOT NULL DEFAULT '',
      conflict_note TEXT NOT NULL DEFAULT '',
      UNIQUE (client_id, field_key),
      FOREIGN KEY (client_id) REFERENCES client(id)
    );

    CREATE TABLE IF NOT EXISTS event (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lookup_cache (
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_health (
      resource_id TEXT PRIMARY KEY,
      last_modified TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );
  `);

  /*
   * Existing PoC files keep their rows; we only add columns
   * that a CREATE TABLE IF NOT EXISTS would skip.
   */
  ensureColumn('client', 'project_cadastre', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('client', 'project_lat', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('client', 'project_lon', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('client', 'project_address', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('client', 'applicant_regcode', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('client', 'applicant_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('fact', 'previous_value', "TEXT NOT NULL DEFAULT ''");

  seedIfEmpty();
  return db;
}

function ensureColumn(table: string, name: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((col) => col.name === name)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

function seedIfEmpty(): void {
  const existing = db.prepare('SELECT id FROM selection WHERE id = ?').get(SELECTION_ID) as
    | { id: string }
    | undefined;

  if (existing) {
    return;
  }

  const now = new Date().toISOString();
  db.prepare('INSERT INTO selection (id, title, created_at) VALUES (?, ?, ?)').run(
    SELECTION_ID,
    'Vienotais Zemes Reģistrs — kadastra pārskati',
    now,
  );

  for (const seed of SEED_CLIENTS) {
    insertClient({
      id: crypto.randomUUID(),
      selection_id: SELECTION_ID,
      name: seed.name,
      regcode: seed.regcode,
      created_at: now,
      project_cadastre: '',
      project_lat: '',
      project_lon: '',
      project_address: '',
      applicant_regcode: '',
      applicant_name: '',
    });
  }

  logEvent('seed', {
    selectionId: SELECTION_ID,
    clients: SEED_CLIENTS.map((item) => item.regcode),
  });
}

export function insertClient(client: Client): void {
  db.prepare(
    `INSERT INTO client (
       id, selection_id, name, regcode, created_at,
       project_cadastre, project_lat, project_lon, project_address,
       applicant_regcode, applicant_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    client.id,
    client.selection_id,
    client.name,
    client.regcode,
    client.created_at,
    client.project_cadastre ?? '',
    client.project_lat ?? '',
    client.project_lon ?? '',
    client.project_address ?? '',
    client.applicant_regcode ?? '',
    client.applicant_name ?? '',
  );
}

export function getSelection(): Selection {
  const row = db.prepare('SELECT * FROM selection WHERE id = ?').get(SELECTION_ID) as Selection | undefined;
  if (!row) {
    throw new Error('Atlase nav atrasta.');
  }
  return row;
}

export function listClients(): Client[] {
  return db
    .prepare('SELECT * FROM client WHERE selection_id = ? ORDER BY created_at ASC')
    .all(SELECTION_ID) as unknown as Client[];
}

export function getClient(id: string): Client | undefined {
  return db.prepare('SELECT * FROM client WHERE id = ?').get(id) as Client | undefined;
}

export function findClientByRegcode(regcode: string): Client | undefined {
  return db.prepare('SELECT * FROM client WHERE regcode = ?').get(regcode) as Client | undefined;
}

/**
 * One card is a site plus an applicant.
 * The same cadastre with a different registration number is a second card.
 * An empty applicant matches only the card that also has none.
 */
export function findClientBySite(cadastre: string, applicant: string): Client | undefined {
  const wantedSite = cadastreDigits(cadastre);
  const wantedPerson = cadastreDigits(applicant);
  return listClients().find((row) => {
    const site = cadastreDigits(row.project_cadastre || '');
    const person = cadastreDigits(row.applicant_regcode || '');
    return site === wantedSite && person === wantedPerson;
  });
}

export function updateClientName(id: string, name: string): void {
  db.prepare('UPDATE client SET name = ? WHERE id = ?').run(name, id);
}

/** Applicant is not the card title. The title stays the cadastre number. */
export function updateClientApplicant(id: string, regcode: string, name: string): void {
  db.prepare('UPDATE client SET applicant_regcode = ?, applicant_name = ? WHERE id = ?').run(regcode, name, id);
}

export function updateClientSite(
  id: string,
  site: {
    project_cadastre: string;
    project_lat: string;
    project_lon: string;
    project_address: string;
  },
): Client {
  db.prepare(
    `UPDATE client
     SET project_cadastre = ?, project_lat = ?, project_lon = ?, project_address = ?
     WHERE id = ?`,
  ).run(site.project_cadastre, site.project_lat, site.project_lon, site.project_address, id);
  const updated = getClient(id);
  if (!updated) {
    throw new Error('Klients nav atrasts.');
  }
  return updated;
}

export function listFacts(): Fact[] {
  return db.prepare('SELECT * FROM fact ORDER BY client_id, field_key').all() as unknown as Fact[];
}

export function listFactsForClient(clientId: string): Fact[] {
  return db.prepare('SELECT * FROM fact WHERE client_id = ?').all(clientId) as unknown as Fact[];
}

export function getFact(id: string): Fact | undefined {
  return db.prepare('SELECT * FROM fact WHERE id = ?').get(id) as Fact | undefined;
}

export function upsertFact(input: {
  clientId: string;
  fieldKey: FieldKey;
  value: string;
  sourceId: SourceId | '';
  sourceUrl: string;
  proofUrl: string;
  fetchedAt: string;
  status: FactStatus;
  conflictNote: string;
}): Fact {
  const current = db
    .prepare('SELECT * FROM fact WHERE client_id = ? AND field_key = ?')
    .get(input.clientId, input.fieldKey) as Fact | undefined;

  /*
   * Keep a finished review if the live value did not move.
   * If the source value changed, the reviewer has to look again.
   */
  const valueUnchanged = current?.value === input.value;
  const keepReview =
    current &&
    valueUnchanged &&
    (current.status === 'apstiprinats' || current.status === 'labots');

  const previousValue = current && !valueUnchanged ? current.value : (current?.previous_value ?? '');

  const next: Fact = {
    id: current?.id ?? crypto.randomUUID(),
    client_id: input.clientId,
    field_key: input.fieldKey,
    value: input.value,
    source_id: input.sourceId,
    source_url: input.sourceUrl,
    proof_url: input.proofUrl,
    fetched_at: input.fetchedAt,
    status: keepReview ? current.status : input.status,
    corrected_value: keepReview ? current.corrected_value : '',
    reviewed_at: keepReview ? current.reviewed_at : '',
    reviewer: keepReview ? current.reviewer : '',
    conflict_note: input.conflictNote,
    previous_value: previousValue,
  };

  db.prepare(
    `INSERT INTO fact (
       id, client_id, field_key, value, source_id, source_url, proof_url,
       fetched_at, status, corrected_value, reviewed_at, reviewer, conflict_note,
       previous_value
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id, field_key) DO UPDATE SET
       value = excluded.value,
       source_id = excluded.source_id,
       source_url = excluded.source_url,
       proof_url = excluded.proof_url,
       fetched_at = excluded.fetched_at,
       status = excluded.status,
       corrected_value = excluded.corrected_value,
       reviewed_at = excluded.reviewed_at,
       reviewer = excluded.reviewer,
       conflict_note = excluded.conflict_note,
       previous_value = excluded.previous_value`,
  ).run(
    next.id,
    next.client_id,
    next.field_key,
    next.value,
    next.source_id,
    next.source_url,
    next.proof_url,
    next.fetched_at,
    next.status,
    next.corrected_value,
    next.reviewed_at,
    next.reviewer,
    next.conflict_note,
    next.previous_value,
  );

  return next;
}

export function updateFactReview(
  id: string,
  patch: {
    status: FactStatus;
    corrected_value: string;
    reviewed_at: string;
    reviewer: string;
  },
): Fact {
  db.prepare(
    `UPDATE fact
     SET status = ?, corrected_value = ?, reviewed_at = ?, reviewer = ?
     WHERE id = ?`,
  ).run(patch.status, patch.corrected_value, patch.reviewed_at, patch.reviewer, id);

  const updated = getFact(id);
  if (!updated) {
    throw new Error('Fakts nav atrasts.');
  }
  return updated;
}

export function logEvent(type: string, payload: unknown): void {
  db.prepare('INSERT INTO event (id, type, payload, created_at) VALUES (?, ?, ?, ?)').run(
    crypto.randomUUID(),
    type,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

export function listEvents(limit = 200): AuditEvent[] {
  return db
    .prepare('SELECT * FROM event ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as AuditEvent[];
}

/*
 * Upstream answers are reused for a day by default. A demo machine
 * can stretch that with CACHE_TTL_HOURS so a pre-warmed cache
 * survives until the stage lights come on.
 */
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS) > 0 ? Number(process.env.CACHE_TTL_HOURS) : 24;
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;

export function readCache(cacheKey: string, ttlMs = CACHE_TTL_MS): { payload: string; fetched_at: string } | undefined {
  const row = db.prepare('SELECT payload, fetched_at FROM lookup_cache WHERE cache_key = ?').get(cacheKey) as
    | { payload: string; fetched_at: string }
    | undefined;

  if (!row) {
    return undefined;
  }

  const age = Date.now() - Date.parse(row.fetched_at);
  if (Number.isNaN(age) || age > ttlMs) {
    return undefined;
  }

  return row;
}

export function writeCache(cacheKey: string, payload: string, fetchedAt: string): void {
  db.prepare(
    `INSERT INTO lookup_cache (cache_key, payload, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(cacheKey, payload, fetchedAt);
}

export function listSourceHealth(): SourceHealth[] {
  return db.prepare('SELECT * FROM source_health').all() as unknown as SourceHealth[];
}

export function upsertSourceHealth(row: SourceHealth): void {
  db.prepare(
    `INSERT INTO source_health (resource_id, last_modified, checked_at, ok, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(resource_id) DO UPDATE SET
       last_modified = excluded.last_modified,
       checked_at = excluded.checked_at,
       ok = excluded.ok,
       note = excluded.note`,
  ).run(row.resource_id, row.last_modified, row.checked_at, row.ok, row.note);
}
