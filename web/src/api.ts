let bearerToken = "";
export function setBearerToken(value: string) {
  bearerToken = value.trim();
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
    headers: {
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error?.message ??
        body?.message ??
        `Nie udało się pobrać danych (${response.status}).`,
      response.status,
      body?.error?.code,
    );
  return body as T;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body });
export const requestKey = () => crypto.randomUUID();
export async function uploadDocument<T>(
  id: string,
  version: number,
  file: File,
  mediaType: string,
  changeNote: string,
  uploadId: string,
): Promise<T> {
  const response = await fetch(`/api/documents/${id}/files/prepare`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      "Content-Type": "application/octet-stream",
      "X-Jarvis-Upload-Id": uploadId,
      "X-Jarvis-Document-Version": String(version),
      "X-Jarvis-File-Name": encodeURIComponent(file.name),
      "X-Jarvis-File-Type": mediaType,
      "X-Jarvis-Change-Note": encodeURIComponent(changeNote),
    },
    body: file,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error?.message ?? "Nie udało się przygotować pliku.",
      response.status,
      body?.error?.code,
    );
  return body as T;
}
export async function download(path: string, filename: string) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      body?.error?.message ?? "Nie udało się przygotować pliku.",
      response.status,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
