const AMBIGUOUS_PROVIDER_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Returns true when a provider may have accepted a request even though the
 * bridge did not receive a definitive response. Such failures must not enter
 * a fallback send path because that can duplicate the provider-side effect.
 */
export function isAmbiguousProviderFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  return AMBIGUOUS_PROVIDER_CODES.has(code)
    || /timeout|timed out|socket hang up|connection reset/i.test(message);
}
