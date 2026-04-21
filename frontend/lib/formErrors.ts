/**
 * Extracts the first validation error message per field from a Laravel 422 response.
 *
 * Usage:
 *   const fieldErrors = parseApiErrors(response.errors);
 *   // fieldErrors.email → "The email has already been taken."
 */
export function parseApiErrors(
    errors?: Record<string, string[]>
): Record<string, string> {
    if (!errors) return {};
    const result: Record<string, string> = {};
    for (const [field, messages] of Object.entries(errors)) {
        if (messages && messages.length > 0) {
            result[field] = messages[0];
        }
    }
    return result;
}
