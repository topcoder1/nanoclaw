/**
 * Unit tests for the brain drive-resolver:
 *  - URL detection (pure)
 *  - ingestDriveDoc idempotency on (source_type='drive', source_ref)
 *  - integration with the email ingest pipeline (shared-doc emails
 *    produce a separate `source_type='drive'` KU)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
  QDRANT_URL: '',
}));

const { embedMock, embedBatchMock, qdrantUpsertMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  embedBatchMock: vi.fn(),
  qdrantUpsertMock: vi.fn(),
}));

vi.mock('../embed.js', () => ({
  embedText: embedMock,
  embedBatch: embedBatchMock,
  getEmbeddingModelVersion: () => 'nomic-embed-text-v1.5:768',
  EMBEDDING_DIMS: 768,
  _resetEmbeddingPipeline: () => {},
}));
vi.mock('../qdrant.js', () => ({
  upsertKu: qdrantUpsertMock,
  searchSemantic: vi.fn(),
  ensureBrainCollection: vi.fn(),
  BRAIN_COLLECTION: 'ku_nomic-embed-text-v1.5_768',
  _setQdrantClientForTest: () => {},
}));

import { eventBus } from '../../event-bus.js';
import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  driveSourceRef,
  extractDriveLinks,
  ingestDriveDoc,
  setBrainDriveFetcher,
  type BrainDriveFetcher,
  type DriveDocContent,
  type DriveLink,
} from '../drive-resolver.js';
import { startBrainIngest, stopBrainIngest } from '../ingest.js';

describe('extractDriveLinks', () => {
  it('detects Google Docs / Slides / Sheets URLs', () => {
    const text = `Check the doc: https://docs.google.com/document/d/aaaaaaaaaa1111/edit
And the deck: https://docs.google.com/presentation/d/bbbbbbbbbb2222/edit?usp=sharing
Sheet: https://docs.google.com/spreadsheets/d/cccccccccc3333/`;

    const links = extractDriveLinks(text);
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({
      kind: 'document',
      fileId: 'aaaaaaaaaa1111',
    });
    expect(links[1]).toMatchObject({
      kind: 'presentation',
      fileId: 'bbbbbbbbbb2222',
    });
    expect(links[2]).toMatchObject({
      kind: 'spreadsheet',
      fileId: 'cccccccccc3333',
    });
  });

  it('detects drive.google.com/file/d/ and ?id= forms', () => {
    const text = `File: https://drive.google.com/file/d/zzzzzzzzzzzz999/view
Open: https://drive.google.com/open?id=yyyyyyyyyyyy888&usp=sharing`;

    const links = extractDriveLinks(text);
    expect(links).toHaveLength(2);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'file', fileId: 'zzzzzzzzzzzz999' }),
        expect.objectContaining({ kind: 'file', fileId: 'yyyyyyyyyyyy888' }),
      ]),
    );
  });

  it('dedupes the same (kind, fileId) across multiple URL forms', () => {
    const text = `Once: https://docs.google.com/document/d/dup1234567/edit
Twice: https://docs.google.com/document/d/dup1234567/preview
Thrice: https://docs.google.com/document/d/dup1234567`;
    const links = extractDriveLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0].fileId).toBe('dup1234567');
  });

  it('ignores non-Drive URLs and returns empty for empty input', () => {
    expect(extractDriveLinks('')).toEqual([]);
    expect(
      extractDriveLinks(
        'Plain email body with https://acme.co and nothing else',
      ),
    ).toEqual([]);
  });
});

describe('ingestDriveDoc — idempotency', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-resolver-'));
    embedMock.mockReset();
    qdrantUpsertMock.mockReset();
    embedMock.mockResolvedValue(Array.from({ length: 768 }, () => 0.01));
    qdrantUpsertMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts on first call; updates text + recorded_at on second; preserves valid_from', async () => {
    const db = getBrainDb();
    const link: DriveLink = {
      kind: 'presentation',
      fileId: 'idem1234567',
      url: 'https://docs.google.com/presentation/d/idem1234567/edit',
    };

    const v1: DriveDocContent = { title: 'Deck v1', text: 'Original body.' };
    const id1 = await ingestDriveDoc(db, link, v1, {
      accountBucket: 'work',
      validFromIso: '2026-04-20T10:00:00Z',
    });

    const v2: DriveDocContent = { title: 'Deck v2', text: 'Revised body.' };
    const id2 = await ingestDriveDoc(db, link, v2, {
      accountBucket: 'work',
      validFromIso: '2026-04-27T11:00:00Z', // newer valid_from must NOT overwrite
    });

    expect(id1).toBe(id2);

    const rows = db
      .prepare(
        `SELECT id, text, valid_from, recorded_at, source_type, source_ref
           FROM knowledge_units WHERE source_type='drive'`,
      )
      .all() as Array<{
      id: string;
      text: string;
      valid_from: string;
      recorded_at: string;
      source_type: string;
      source_ref: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].source_ref).toBe(driveSourceRef(link));
    expect(rows[0].source_ref).toBe('presentation:idem1234567');
    expect(rows[0].text).toContain('Deck v2');
    expect(rows[0].text).toContain('Revised body.');
    // valid_from preserved from the first ingest.
    expect(rows[0].valid_from).toBe('2026-04-20T10:00:00Z');
  });

  it('embeds and upserts to Qdrant on insert', async () => {
    const db = getBrainDb();
    await ingestDriveDoc(
      db,
      {
        kind: 'document',
        fileId: 'qdr1234567',
        url: 'https://docs.google.com/document/d/qdr1234567',
      },
      { title: 'Doc', text: 'Some content' },
      { accountBucket: 'personal', validFromIso: '2026-04-27T00:00:00Z' },
    );

    expect(embedMock).toHaveBeenCalledOnce();
    expect(qdrantUpsertMock).toHaveBeenCalledOnce();
    const upsertArg = qdrantUpsertMock.mock.calls[0][0] as {
      payload: { source_type: string; source_ref: string; account: string };
    };
    expect(upsertArg.payload.source_type).toBe('drive');
    expect(upsertArg.payload.source_ref).toBe('document:qdr1234567');
    expect(upsertArg.payload.account).toBe('personal');
  });
});

describe('ingest pipeline — shared-doc email creates drive KU', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-pipe-'));
    embedMock.mockReset();
    embedBatchMock.mockReset();
    qdrantUpsertMock.mockReset();
    const fakeVec = Array.from({ length: 768 }, () => 0.01);
    embedMock.mockResolvedValue(fakeVec);
    embedBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => fakeVec),
    );
    qdrantUpsertMock.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await stopBrainIngest();
    setBrainDriveFetcher(null);
    _closeBrainDb();
    eventBus.removeAllListeners();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts an inline Drive link and ingests it as a separate source_type=drive KU', async () => {
    const fetcher = vi.fn<BrainDriveFetcher>(async (_account, link) => ({
      title: 'WXA v1.5 Traffic Intelligence Recipes',
      text:
        link.kind === 'presentation'
          ? 'Slide 0: Cover page. Slide 1: One shared evidence engine. ...'
          : 'plain doc body',
    }));
    setBrainDriveFetcher(fetcher);

    startBrainIngest();
    eventBus.emit('email.received', {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {
        count: 1,
        emails: [
          {
            thread_id: 'thread-shared-deck',
            account: 'whoisxml',
            subject: 'Presentation shared with you: "WXA v1.5"',
            sender: 'alex.ronquillo@whoisxmlapi.com',
            snippet:
              "I've shared an item with you: WXA v1.5 — https://docs.google.com/presentation/d/share123abc/edit",
          },
        ],
        connection: 'test',
      },
    });

    await new Promise((r) => setTimeout(r, 500));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('whoisxml');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      kind: 'presentation',
      fileId: 'share123abc',
    });

    const db = getBrainDb();
    const drives = db
      .prepare(
        `SELECT id, text, source_ref, account FROM knowledge_units WHERE source_type='drive'`,
      )
      .all() as Array<{
      id: string;
      text: string;
      source_ref: string;
      account: string;
    }>;
    expect(drives).toHaveLength(1);
    expect(drives[0].source_ref).toBe('presentation:share123abc');
    expect(drives[0].text).toContain('Slide 0: Cover');
    expect(drives[0].account).toBe('work');
  });
});
