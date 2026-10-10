import { collectAll, collectForClient } from './services/collect.ts';
import { getClient, logEvent } from './db.ts';
import type { FieldKey } from './types.ts';

export interface CollectJob {
  id: string;
  status: 'running' | 'done' | 'error';
  done: number;
  total: number;
  label: string;
  error?: string;
  force: boolean;
  clientId?: string;
  clientIds?: string[];
  fieldKey?: FieldKey;
  started_at: string;
  finished_at?: string;
}

const jobs = new Map<string, CollectJob>();

export function getJob(id: string): CollectJob | undefined {
  return jobs.get(id);
}

export function startCollectJob(input: {
  force?: boolean;
  clientId?: string;
  clientIds?: string[];
  fieldKey?: FieldKey;
}): CollectJob {
  const clientIds = input.clientIds?.filter(Boolean);
  const job: CollectJob = {
    id: crypto.randomUUID(),
    status: 'running',
    done: 0,
    total: clientIds?.length || 1,
    label: 'Rindā',
    force: Boolean(input.force),
    clientId: input.clientId,
    clientIds,
    fieldKey: input.fieldKey,
    started_at: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  logEvent('collect_queued', {
    jobId: job.id,
    clientId: job.clientId,
    force: job.force,
  });

  void runJob(job);
  return job;
}

async function runJob(job: CollectJob): Promise<void> {
  try {
    if (job.clientIds?.length) {
      /*
       * One uploaded sheet is one job. The list polls this
       * and fills in as each row finishes.
       */
      job.total = job.clientIds.length;
      for (let index = 0; index < job.clientIds.length; index += 1) {
        const id = job.clientIds[index];
        job.label = getClient(id)?.name || 'Ielādē';
        job.done = index;
        await collectForClient(id, job.force);
        job.done = index + 1;
      }
    } else if (job.clientId) {
      job.label = 'Ielādē';
      job.total = 1;
      await collectForClient(job.clientId, job.force, job.fieldKey ? [job.fieldKey] : undefined);
      job.done = 1;
    } else {
      job.label = 'Ielādē visus';
      await collectAll(job.force, (done, total, label) => {
        job.done = done;
        job.total = total;
        job.label = label;
      });
      job.done = job.total;
    }
    job.status = 'done';
    job.label = 'Pabeigts';
  } catch (error) {
    job.status = 'error';
    job.error = error instanceof Error ? error.message : 'Savākšana neizdevās';
  } finally {
    job.finished_at = new Date().toISOString();
  }
}
