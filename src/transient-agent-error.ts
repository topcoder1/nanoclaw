/**
 * Classifies whether an agent-run error string represents a transient
 * upstream/network failure (Anthropic API socket drops, 502/503/529, local
 * connectivity blips) versus a real agent failure (timeout, code-1 exit,
 * Docker daemon down, parse errors).
 *
 * Used by the email-trigger handler to suppress chat-facing alerts when the
 * failure is transient and the next debounced batch is likely to recover —
 * which is the empirically observed pattern (every "Email intelligence
 * trigger failed" alert in the wild has been followed within ~1 minute by a
 * successful retry from the next batch).
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
];

export function isTransientAgentError(
  error: string | undefined | null,
): boolean {
  if (!error) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(error));
}
