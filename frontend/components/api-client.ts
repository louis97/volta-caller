const READ_RETRY_DELAYS_MS = [0, 200, 600];

export async function fetchOperationalRead(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (const delayMs of READ_RETRY_DELAYS_MS) {
    if (delayMs > 0) await delay(delayMs);
    try {
      const response = await fetch(input, { ...init, cache: "no-store" });
      if (response.ok || (response.status < 500 && response.status !== 429)) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? lastError
    : new Error("operational_read_unavailable");
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
