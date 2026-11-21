import { ApiError, apiResponse } from './api';

export async function downloadExport(path: string, fallbackName: string, what: string) {
  const response = await apiResponse(path, { cache: 'no-store' });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === 'string' && body.error.trim()
        ? `${what} could not be exported: ${body.error}`
        : `${what} could not be exported (HTTP ${response.status}).`,
      response.status,
    );
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
    fallbackName;
  const url = URL.createObjectURL(await response.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
