/** JSON.parse wrapper that includes a context label and raw value preview in error messages. */
export function jsonParse<T = unknown>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const preview = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    throw new Error(`JSON parse failed (${label}): ${(e as Error).message}\nRaw value: ${preview}`);
  }
}

/** A thrown value as a result's error: its name, its message and the cause it carries. */
export function errorOf(
  e: unknown,
  message = e instanceof Error ? e.message : String(e),
): { name: string; message: string; cause?: unknown } {
  return {
    name: e instanceof Error ? e.name : "Error",
    message,
    ...(e instanceof Error && e.cause !== undefined && { cause: e.cause }),
  };
}
