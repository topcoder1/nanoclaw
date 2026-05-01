import { describe, it, expect } from 'vitest';
import { isTransientAgentError } from '../transient-agent-error.js';

describe('isTransientAgentError', () => {
  it('classifies UND_ERR_SOCKET as transient', () => {
    const err =
      'Container exited with code 0: Agent error: Claude Code returned an error result: API Error: Unable to connect to API (UND_ERR_SOCKET)';
    expect(isTransientAgentError(err)).toBe(true);
  });

  it('classifies Anthropic 529 overloaded_error as transient', () => {
    const err =
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Authentication service is temporarily unavailable. Retry the request."}}';
    expect(isTransientAgentError(err)).toBe(true);
  });

  it('classifies ECONNRESET as transient', () => {
    expect(isTransientAgentError('read ECONNRESET')).toBe(true);
  });

  it('classifies ENETUNREACH as transient', () => {
    expect(isTransientAgentError('AggregateError [ENETUNREACH]:')).toBe(true);
  });

  it('classifies HTTP 502/503 as transient', () => {
    expect(isTransientAgentError('upstream returned 502 Bad Gateway')).toBe(
      true,
    );
    expect(isTransientAgentError('Service Unavailable (503)')).toBe(true);
  });

  it('classifies fetch failed / network error phrasing as transient', () => {
    expect(isTransientAgentError('fetch failed')).toBe(true);
    expect(isTransientAgentError('Unable to connect to API')).toBe(true);
  });

  it('does NOT classify a Docker-daemon-down error as transient', () => {
    const err =
      'Container exited with code 1: Cannot connect to the Docker daemon at unix:///Users/topcoder1/.docker/run/docker.sock. Is the docker daemon running?';
    expect(isTransientAgentError(err)).toBe(false);
  });

  it('does NOT classify a "Container timed out" error as transient', () => {
    expect(isTransientAgentError('Container timed out after 1800000ms')).toBe(
      false,
    );
  });

  it('does NOT classify a JSON parse error as transient', () => {
    expect(
      isTransientAgentError(
        'Failed to parse container output: Unexpected token',
      ),
    ).toBe(false);
  });

  it('returns false for undefined / empty input', () => {
    expect(isTransientAgentError(undefined)).toBe(false);
    expect(isTransientAgentError(null)).toBe(false);
    expect(isTransientAgentError('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isTransientAgentError('und_err_socket')).toBe(true);
    expect(isTransientAgentError('OVERLOADED_ERROR')).toBe(true);
  });
});
