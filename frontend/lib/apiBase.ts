/**
 * Base URL for API requests. Next dev uses `/api` (rewrites); production may use a full origin.
 * Does not depend on `window` so paths stay correct during SSR and in module scope.
 */
export function getApiBaseUrl(): string {
    const envApi = process.env.NEXT_PUBLIC_API_URL;
    if (envApi && !envApi.includes('localhost')) {
        return envApi.replace(/\/$/, '');
    }
    return '/api';
}
