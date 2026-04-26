import fs from 'fs';

import { logger } from '../logger.js';
import {
  deprecateProcedure,
  saveProcedure,
  type Procedure,
} from '../memory/procedure-store.js';

export interface CandidatePayload {
  proposed: Procedure;
  replaces: Procedure[];
}

export interface AcceptResult {
  proposedName: string;
  deprecated: string[];
  missing: string[];
  dryRun: boolean;
}

export function readCandidate(filePath: string): CandidatePayload {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Candidate not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Candidate JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Candidate is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.proposed || typeof obj.proposed !== 'object') {
    throw new Error('Candidate missing `proposed` procedure');
  }
  if (!Array.isArray(obj.replaces)) {
    throw new Error('Candidate missing `replaces` array');
  }
  return obj as unknown as CandidatePayload;
}

export function acceptCandidate(
  filePath: string,
  opts: { dryRun?: boolean } = {},
): AcceptResult {
  const dryRun = opts.dryRun ?? false;
  const candidate = readCandidate(filePath);
  const proposed = candidate.proposed;

  const deprecated: string[] = [];
  const missing: string[] = [];

  // Detect collision: a member shares the proposed name. If we deprecated it
  // first the path would be gone before we save; if we saved first we would
  // overwrite the original and have nothing left to deprecate. Either ordering
  // loses one of the two operations on that file. Bail loudly instead.
  for (const m of candidate.replaces) {
    if (m.name === proposed.name && m.groupId === proposed.groupId) {
      throw new Error(
        `Refusing to accept: proposed name "${proposed.name}" collides with one of its own replacees in the same group`,
      );
    }
  }

  if (!dryRun) {
    saveProcedure(proposed);
    for (const m of candidate.replaces) {
      const ok = deprecateProcedure(m.name, m.groupId);
      if (ok) {
        deprecated.push(m.name);
      } else {
        missing.push(m.name);
      }
    }
  } else {
    for (const m of candidate.replaces) {
      // dry-run: report which would be touched, no fs changes
      missing.push(m.name);
    }
  }

  logger.info(
    {
      filePath,
      proposed: proposed.name,
      groupId: proposed.groupId,
      deprecated: deprecated.length,
      missing: missing.length,
      dryRun,
    },
    dryRun ? 'Candidate dry-run' : 'Candidate accepted',
  );

  return {
    proposedName: proposed.name,
    deprecated,
    missing,
    dryRun,
  };
}
