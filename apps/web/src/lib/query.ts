/**
 * Reading from the API through one cache (M40).
 *
 * Every page used to fetch in its own effect, which meant no caching, a
 * spinner on every return to a screen, and nineteen slightly different ideas
 * of what a failed request looks like. A read goes through here instead: the
 * path is the cache key, so two components asking for the same thing share one
 * request and one answer.
 *
 * Writes still go through `apiPost`; after one, invalidate the paths it changed.
 */
import { useQuery, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { apiGet, ApiError } from './api';

export const apiKey = (path: string) => ['api', path] as const;

export function useApiQuery<T>(
  path: string | null,
  options?: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>,
): UseQueryResult<T, ApiError> {
  return useQuery<T, ApiError>({
    queryKey: apiKey(path ?? ''),
    queryFn: () => apiGet<T>(path as string),
    ...options,
    // A null path is "not ready to ask yet", whatever the caller passed.
    enabled: path !== null && (options?.enabled ?? true),
  });
}

/**
 * Whether a failed read is worth asking again.
 *
 * A 4xx is an answer — not signed in, not allowed, not found — and repeating
 * the question three times only delays showing it. Network failures and 5xx
 * get two more tries.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}
