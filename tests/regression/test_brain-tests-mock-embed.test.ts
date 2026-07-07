// Lesson 2026-07-01: raw-events.test.ts drove the brain ingest pipeline
// without mocking ../embed.js, so on CI runners with a cold HuggingFace
// cache the first flush cold-loaded the real ~140MB transformers model
// mid-test; stopBrainIngest()'s queue drain then outlived the 10s
// afterEach hookTimeout ("Hook timed out in 10000ms", CI runs 28546900094
// and 28547165742). Dev machines pass because the model is already cached.
// embed.ts's contract is explicit: "Tests mock pipeline() so the real
// model is never fetched in CI."

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

const brainTestsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/brain/__tests__',
);

// Entry points through which a test can reach the P1 extraction pipeline
// (and therefore embedBatch/embedText on the real model).
const PIPELINE_MARKERS =
  /\b(startBrainIngest|startChatIngest|runExtractionPipeline|reprocessRawEvent)\b/;

describe('brain pipeline tests never load the real embedding model', () => {
  it('every test file that drives the ingest pipeline mocks ../embed.js', () => {
    const offenders: string[] = [];
    for (const name of fs
      .readdirSync(brainTestsDir)
      .filter((n) => n.endsWith('.test.ts'))) {
      const content = fs.readFileSync(path.join(brainTestsDir, name), 'utf8');
      if (!PIPELINE_MARKERS.test(content)) continue;
      if (!content.includes(`vi.mock('../embed.js'`)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
