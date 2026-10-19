export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly service: string,
  ) {
    super(`${service} returned HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

/** POSTs JSON with a timeout and retries on 429 / 5xx (at most `retries` times). */
export async function postJson<T>(
  service: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  { timeoutMs = 30000, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(res.status, text, service);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
  }
}
