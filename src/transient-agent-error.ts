/**
 * Classifies whether an agent-run error string represents a transient
 * upstream/network/runtime failure that the next debounced email batch
 * will reliably recover from, versus a real agent failure that warrants a
 * chat-facing alert.
 *
 * Used by the email-trigger handler to suppress chat-facing alerts when the
 * failure is transient — empirically every observed "Email intelligence
 * trigger failed" alert has been followed within ~1 minute by a successful
 * retry from the next batch.
 *
 * Categories suppressed:
 *  - Upstream API instability (Anthropic socket drops, 502/503/529).
 *  - Container idle-timeout with no streaming output, and SIGKILL (137)
 *    cleanup — when a deep-research email trigger blows past the 30-min
 *    idle window or the OOM reaper trips, the next batch retries.
 *  - Local Docker daemon hiccups + mount-permission races during reload —
 *    these clear up on the next attempt, alerting on every flap is noise.
 *  - Output-parse failures from a container killed mid-stream — also
 *    typically a torn-down container, not a real bug.
 */

const TRANSIENT_PATTERNS: RegExp[] = [
  /und_err_socket/i,
  /und_err_connect_timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /enetunreach/i,
  /ehostunreach/i,
  /etimedout/i,
  /eai_again/i,
  /overloaded_error/i,
  /\bfetch failed\b/i,
  /unable to connect to (?:api|the api)/i,
  /\b(?:502|503|529)\b/,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /socket hang up/i,
  /container timed out after \d+ms/i,
  /container exited with code 137\b/i,
  /cannot connect to the docker daemon/i,
  /operation not permitted/i,
  /failed to parse container output/i,
];

export function isTransientAgentError(
  error: string | undefined | null,
): boolean {
  if (!error) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(error));
}
