import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db.js';
import { EventBus } from '../../event-bus.js';
import { createCeremony, getCeremony } from '../ceremony-repo.js';
import { startSummarizerWiring } from '../summarizer-wiring.js';

describe('summarizer wiring', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    bus = new EventBus();
  });

  it('on sign.invite.detected: fetches page, summarizes, transitions to summarized, emits sign.summarized', async () => {
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });

    const fetchDocText = vi.fn().mockResolvedValue('doc text here');
    const llm = vi
      .fn()
      .mockResolvedValue({ summary: ['Doc: NDA'], riskFlags: [] });

    const summarized = new Promise<void>((resolve) =>
      bus.on('sign.summarized', () => resolve()),
    );

    startSummarizerWiring({ db, bus, fetchDocText, llm });

    bus.emit('sign.invite.detected', {
      type: 'sign.invite.detected',
      source: 'triage',
      timestamp: Date.now(),
      payload: {
        ceremonyId: 'c1',
        emailId: 'e1',
        vendor: 'docusign',
        signUrl: 'https://na3.docusign.net/x',
        groupId: 'main',
      },
    });

    await summarized;
    expect(getCeremony(db, 'c1')!.state).toBe('summarized');
    expect(getCeremony(db, 'c1')!.summaryText).toBe('Doc: NDA');
  });

  it('on LLM failure: leaves ceremony at detected, no summarized emit', async () => {
    createCeremony(db, {
      id: 'c2',
      emailId: 'e2',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/x',
    });

    const fetchDocText = vi.fn().mockResolvedValue('doc text');
    const llm = vi.fn().mockResolvedValue({ bogus: true });

    const summarizedHandler = vi.fn();
    bus.on('sign.summarized', summarizedHandler);

    startSummarizerWiring({ db, bus, fetchDocText, llm });

    bus.emit('sign.invite.detected', {
      type: 'sign.invite.detected',
      source: 'triage',
      timestamp: Date.now(),
      payload: {
        ceremonyId: 'c2',
        emailId: 'e2',
        vendor: 'docusign',
        signUrl: 'https://na3.docusign.net/x',
        groupId: 'main',
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(getCeremony(db, 'c2')!.state).toBe('detected');
    expect(summarizedHandler).not.toHaveBeenCalled();
  });
});
