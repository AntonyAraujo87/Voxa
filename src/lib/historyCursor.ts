/** Cursor PostgREST que preserva a precisao de microssegundos do PostgreSQL. */
export function historyCursor(timestamp?: string, id?: string): string | null {
  if (!timestamp || !id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) return null;
  return `created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`;
}
