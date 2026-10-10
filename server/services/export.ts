import { FIELD_SPECS } from '../fields.ts';
import type { Client, Fact } from '../types.ts';

const STATUS_LABEL: Record<string, string> = {
  gaida: 'Gaida pārbaudi',
  apstiprinats: 'Apstiprināts',
  labots: 'Labots',
  konflikts: 'Konflikts',
  nav_datu: 'Nav datu',
  kluda: 'Kļūda',
};

function csvCell(value: string): string {
  const safe = value.replace(/"/g, '""');
  return `"${safe}"`;
}

/**
 * One row per field — the Excel client card from the first-version
 * test: value, source URL, fetch time, reviewer, status.
 */
export function factsToCsv(clients: Client[], facts: Fact[]): string {
  const header = [
    'Klients',
    'Reģistrācijas numurs',
    'Lauks',
    'Vērtība',
    'Labotā vērtība',
    'Avots',
    'Avota URL',
    'Pierādījuma saite',
    'Iegūts',
    'Statuss',
    'Pārbaudītājs',
    'Pārbaudīts',
    'Piezīme',
  ];

  const lines = [header.map(csvCell).join(';')];

  for (const client of clients) {
    const clientFacts = facts.filter((fact) => fact.client_id === client.id);
    for (const spec of FIELD_SPECS) {
      const fact = clientFacts.find((item) => item.field_key === spec.key);
      lines.push(
        [
          client.name,
          client.regcode,
          spec.label,
          fact?.value ?? '',
          fact?.corrected_value ?? '',
          spec.sourceId.toUpperCase(),
          fact?.source_url ?? '',
          fact?.proof_url ?? '',
          fact?.fetched_at ?? '',
          fact ? STATUS_LABEL[fact.status] ?? fact.status : '',
          fact?.reviewer ?? '',
          fact?.reviewed_at ?? '',
          fact?.conflict_note ?? '',
        ]
          .map(csvCell)
          .join(';'),
      );
    }
  }

  return `\uFEFF${lines.join('\n')}\n`;
}
