import { findClientBySite, insertClient, updateClientApplicant, updateClientName } from '../db.ts';
import { SELECTION_ID, formatCadastre } from '../fields.ts';

/**
 * Every report is a hidden row in the local DB: one site,
 * optionally one company. The map never shows it as a "client";
 * it only gives the evaluation a place to write its facts.
 */
export function reportRow(input: { cadastre: string; applicant: string; applicantName: string }): string {
  const existing = findClientBySite(input.cadastre, input.applicant);
  if (existing) {
    updateClientName(existing.id, formatCadastre(input.cadastre));
    if (input.applicant) {
      updateClientApplicant(existing.id, input.applicant, input.applicantName || existing.applicant_name || '');
    }
    return existing.id;
  }

  const id = crypto.randomUUID();
  insertClient({
    id,
    selection_id: SELECTION_ID,
    name: formatCadastre(input.cadastre),
    regcode: input.cadastre,
    created_at: new Date().toISOString(),
    project_cadastre: input.cadastre,
    project_lat: '',
    project_lon: '',
    project_address: '',
    applicant_regcode: input.applicant,
    applicant_name: input.applicantName,
  });
  return id;
}
