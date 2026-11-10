import { describe, it, expect } from 'vitest';
import { shouldRetry, apiKey } from '../src/lib/query.ts';
import { ApiError } from '../src/lib/api.ts';

describe('retrying a failed read', () => {
  it('does not repeat a question the server has answered', () => {
    expect(shouldRetry(0, new ApiError(401, 'invalid_token', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, 'forbidden', 'x'))).toBe(false);
    expect(shouldRetry(0, new ApiError(404, 'not_found', 'x'))).toBe(false);
  });

  it('tries a server or network failure twice more, then stops', () => {
    expect(shouldRetry(0, new ApiError(503, 'unavailable', 'x'))).toBe(true);
    expect(shouldRetry(1, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetry(2, new TypeError('fetch failed'))).toBe(false);
  });
});

describe('the cache key', () => {
  it('is the path, so the same question shares one answer', () => {
    expect(apiKey('/v1/students?q=a')).toEqual(apiKey('/v1/students?q=a'));
    expect(apiKey('/v1/students?q=a')).not.toEqual(apiKey('/v1/students?q=b'));
  });
});
