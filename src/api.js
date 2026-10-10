/* global API_BASE */

// the api's origin set at build; empty when site & and the api share a host
export const base = API_BASE;

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// every write sends json > server
export async function api(path, { method = 'GET', body } = {}) {
  const write = method !== 'GET';
  const res = await fetch(base + path, {
    method,
    credentials: 'include',
    headers: write ? { 'content-type': 'application/json' } : {},
    body: write ? JSON.stringify(body ?? {}) : undefined,
  });
  if (res.status === 204) {
    // reading empty body lets browser close the response instead of reporting it aborted
    await res.text();
    return null;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `something went wrong (${res.status})`, res.status, data);
  return data;
}
