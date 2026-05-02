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

  it('classifies a Docker-daemon-down error as transient (recovers next batch)', () => {
    const err =
      'Container exited with code 1: Cannot connect to the Docker daemon at unix:///Users/topcoder1/.docker/run/docker.sock. Is the docker daemon running?';
    expect(isTransientAgentError(err)).toBe(true);
  });

  it('classifies a "Container timed out" error as transient (idle-timeout cleanup, not an agent bug)', () => {
    expect(isTransientAgentError('Container timed out after 1800000ms')).toBe(
      true,
    );
  });

  it('classifies SIGKILL (code 137) cleanup as transient', () => {
    expect(
      isTransientAgentError('Container exited with code 137: <stderr tail>'),
    ).toBe(true);
  });

  it('classifies mount/permission race (operation not permitted) as transient', () => {
    expect(
      isTransientAgentError(
        "Container exited with code 125: error while creating mount source path '/Users/topcoder1/Library/Application Support/AddressBook': mkdir … operation not permitted",
      ),
    ).toBe(true);
  });

  it('classifies a container-output parse error as transient (torn-down container mid-stream)', () => {
    expect(
      isTransientAgentError(
        'Failed to parse container output: Unexpected token',
      ),
    ).toBe(true);
  });

  it('does NOT classify a generic budget-ceiling error as transient', () => {
    expect(isTransientAgentError('Agent blocked by budget ceiling')).toBe(
      false,
    );
  });

  it('does NOT classify an arbitrary container exit code as transient', () => {
    expect(
      isTransientAgentError('Container exited with code 1: <stderr tail>'),
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
