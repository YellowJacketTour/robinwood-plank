export async function readApiJson<T extends Record<string, unknown>>(
  response: Response,
  fallbackMessage: string
): Promise<T> {
  const body = await response.text();
  let data: Record<string, unknown> = {};
  if (body.trim()) {
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error(response.ok ? `${fallbackMessage} The server returned invalid data.` : `${fallbackMessage} (${response.status})`);
    }
  }
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `${fallbackMessage} (${response.status})`);
  }
  if (!body.trim()) throw new Error(`${fallbackMessage} The server returned an empty response.`);
  return data as T;
}
