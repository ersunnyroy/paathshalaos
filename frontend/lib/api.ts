'use client';

/**
 * @deprecated Prefer `@/lib/httpClient` or `@/services/api` in app code.
 * Kept for compatibility with older examples; mirrors the shared HTTP client.
 */
export type { ApiResponse } from '@/lib/httpClient';
export { httpClient as apiClient, httpRequest } from '@/lib/httpClient';

import { httpClient } from '@/lib/httpClient';

export const api = {
    get: httpClient.get,
    post: httpClient.post,
    put: httpClient.put,
    patch: httpClient.patch,
    delete: httpClient.delete,
    postMultipart: httpClient.postMultipart,
};

export default api;
