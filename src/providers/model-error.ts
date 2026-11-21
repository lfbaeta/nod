export class ModelServiceError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
  }
}

export async function modelServiceError(
  response: Response,
  service: string,
  secrets: string[] = [],
  detailFields = ['message', 'type', 'code', 'status', 'param'],
) {
  const values = [...new Set(secrets.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  const redact = (value: string) => {
    let result = '';
    for (let at = 0; at < value.length;) {
      const secret = values.find((secret) => value.startsWith(secret, at));
      result += secret ? '[redacted]' : value[at];
      at += secret?.length ?? 1;
    }
    return result.replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]');
  };
  let reason = response.statusText;
  let serviceReason: string | undefined;
  const reader = response.body?.getReader();
  try {
    if (
      reader &&
      /\/(?:json|[\w.-]+\+json)$/i.test(
        response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '',
      )
    ) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (size < 16_384) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.subarray(0, 16_384 - size));
        size += value.length;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        const found = /"(?:message|detail|error)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
        if (found) reason = serviceReason = JSON.parse(found[1]);
      }
      const first = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
      const error = first?.error ?? first;
      if (typeof error === 'string') reason = serviceReason = error;
      else if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        if (typeof record.message === 'string') serviceReason = record.message;
        else if (detailFields.includes('description') && typeof record.description === 'string')
          serviceReason = record.description;
        const detail = Array.isArray(record.detail)
          ? record.detail
              .flatMap((item) => (typeof item?.msg === 'string' ? [item.msg] : []))
              .join('; ')
          : (Object(record.detail).message ?? record.detail);
        const fields = detailFields.flatMap((name) =>
          typeof record[name] === 'string' || typeof record[name] === 'number'
            ? [`${name}: ${record[name]}`]
            : [],
        );
        const described = typeof detail === 'string' && detail ? detail : undefined;
        if (fields.length)
          reason = [...fields, ...(described ? [`detail: ${described}`] : [])].join('; ');
        else if (described) reason = described;
        if (described) serviceReason ??= described;
      }
    }
  } catch {
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  const details = redact(reason).slice(0, 2000);
  return new ModelServiceError(
    `${service} failed (HTTP ${response.status})${reason ? `: ${details}` : '.'}`,
    serviceReason ? redact(serviceReason) : undefined,
    Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : undefined,
    details,
  );
}
