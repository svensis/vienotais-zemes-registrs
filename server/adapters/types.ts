import type { SourceId } from '../types.ts';

/**
 * Source adapters stay behind this interface so a later
 * UR API-manager subscription can replace the CKAN lookup
 * without touching the client card.
 */
export interface LookupResult {
  sourceId: SourceId;
  requestUrl: string;
  proofUrl: string;
  fetchedAt: string;
  record: Record<string, unknown> | null;
  records: Record<string, unknown>[];
  error?: string;
  fromCache: boolean;
}

export interface SourceAdapter {
  id: SourceId;
  label: string;
  lookup(regcode: string, options?: { force?: boolean }): Promise<LookupResult>;
}

export interface PlaceContext {
  regcode: string;
  address: string;
  addressId: string;
  city: string;
  cadastre: string;
  projectAddress: string;
}
