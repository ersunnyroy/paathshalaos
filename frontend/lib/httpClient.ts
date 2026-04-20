import { getApiBaseUrl } from '@/lib/apiBase';
import { getBearerToken, getTenantIdForRequestHeaders } from '@/lib/apiRequestContext';

export interface ApiResponse<T = any> {
    success: boolean;
    message?: string;
    data?: T;
    errors?: Record<string, string[]>;
    available?: boolean;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface HttpRequestOptions {
    /** JSON-serializable body for POST, PUT, PATCH. Ignored when `formData` is set. */
    body?: JsonBody;
    formData?: FormData;
    /** Merged into default headers (e.g. custom headers). Do not set `Content-Type` for multipart. */
    headers?: Record<string, string>;
}

function normalizePath(path: string): string {
    return path.startsWith('/') ? path : `/${path}`;
}

function buildHeaders(content: 'json' | 'multipart' | 'none', extra?: Record<string, string>): Headers {
    const headers = new Headers();
    headers.set('Accept', 'application/json');

    if (content === 'json') {
        headers.set('Content-Type', 'application/json');
    }

    const token = getBearerToken();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const tenantId = getTenantIdForRequestHeaders();
    if (tenantId) {
        headers.set('X-Tenant-ID', tenantId);
    }

    if (extra) {
        for (const [key, value] of Object.entries(extra)) {
            if (value !== undefined && value !== null) {
                headers.set(key, String(value));
            }
        }
    }

    return headers;
}

async function parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
    const text = await response.text();
    if (!text) {
        return { success: response.ok } as ApiResponse<T>;
    }
    try {
        return JSON.parse(text) as ApiResponse<T>;
    } catch {
        return {
            success: false,
            message: text.slice(0, 200) || 'Invalid JSON response',
        } as ApiResponse<T>;
    }
}

function resolveUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
        return path;
    }
    if (path.startsWith('/api/')) {
        return path;
    }
    if (path.startsWith('/api')) {
        return path;
    }
    return `${getApiBaseUrl()}${normalizePath(path)}`;
}

/**
 * Low-level HTTP call with shared base URL, auth, tenant, and JSON/multipart handling.
 */
export async function httpRequest<T = any>(
    method: HttpMethod,
    path: string,
    options?: HttpRequestOptions
): Promise<ApiResponse<T>> {
    const url = resolveUrl(path);
    const { body, formData, headers: extraHeaders } = options || {};

    let headers: Headers;
    let fetchBody: BodyInit | undefined;

    if (formData) {
        headers = buildHeaders('multipart', extraHeaders);
        fetchBody = formData;
    } else if (method === 'GET') {
        headers = buildHeaders('none', extraHeaders);
        fetchBody = undefined;
    } else if (method === 'DELETE' && body === undefined) {
        headers = buildHeaders('none', extraHeaders);
        fetchBody = undefined;
    } else {
        headers = buildHeaders('json', extraHeaders);
        fetchBody = body !== undefined ? JSON.stringify(body) : undefined;
    }

    const response = await fetch(url, {
        method,
        headers,
        body: fetchBody,
    });

    return parseResponse<T>(response);
}

export const httpClient = {
    get: <T = any>(path: string, options?: Pick<HttpRequestOptions, 'headers'>) =>
        httpRequest<T>('GET', path, options),

    post: <T = any>(path: string, body?: JsonBody, formData?: FormData, options?: Omit<HttpRequestOptions, 'body' | 'formData'>) =>
        httpRequest<T>('POST', path, formData ? { ...options, formData } : { ...options, body }),

    put: <T = any>(path: string, body?: JsonBody, formData?: FormData, options?: Omit<HttpRequestOptions, 'body' | 'formData'>) =>
        httpRequest<T>('PUT', path, formData ? { ...options, formData } : { ...options, body }),

    patch: <T = any>(path: string, body?: JsonBody, options?: Omit<HttpRequestOptions, 'body' | 'formData'>) =>
        httpRequest<T>('PATCH', path, { ...options, body }),

    delete: <T = any>(path: string, body?: JsonBody, options?: Omit<HttpRequestOptions, 'body' | 'formData'>) =>
        httpRequest<T>('DELETE', path, { ...options, body }),

    /**
     * POST with `FormData` body. Does not set `Content-Type` so the browser sets multipart boundaries.
     */
    postMultipart: <T = any>(path: string, formData: FormData, options?: Omit<HttpRequestOptions, 'formData'>) =>
        httpRequest<T>('POST', path, { ...options, formData }),
};
