import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus.js';
import { logger } from '../logger.js';
import { summarizeDocument, type LlmFn } from './summarizer.js';
import {
  getCeremony,
  transitionState,
  updateSummary,
} from './ceremony-repo.js';

export interface SummarizerWiringDeps {
  db: Database.Database;
  bus: EventBus;
  fetchDocText: (signUrl: string) => Promise<string>;
  llm: LlmFn;
}

export function startSummarizerWiring(deps: SummarizerWiringDeps): () => void {
  return deps.bus.on('sign.invite.detected', async (evt) => {
    const { ceremonyId } = evt.payload;
    try {
      const docText = await deps.fetchDocText(evt.payload.signUrl);
      const result = await summarizeDocument({
        docText,
        llm: deps.llm,
        timeoutMs: 30_000,
      });
      if (!result) {
        logger.warn(
          { ceremonyId },
          'summarizer returned null, leaving at detected',
        );
        return;
      }
      updateSummary(deps.db, ceremonyId, result.summary, result.riskFlags);
      const ok = transitionState(deps.db, ceremonyId, 'detected', 'summarized');
      if (!ok) {
        logger.warn(
          { ceremonyId },
          'could not transition detected→summarized (state race)',
        );
        return;
      }
      deps.bus.emit('sign.summarized', {
        type: 'sign.summarized',
        source: 'signer',
        timestamp: Date.now(),
        payload: {
          ceremonyId,
          summary: result.summary,
          riskFlags: result.riskFlags,
        },
      });
    } catch (err) {
      logger.error(
        { err, ceremonyId, component: 'signer/summarizer-wiring' },
        'summarizer wiring threw',
      );
    }
  });
}
