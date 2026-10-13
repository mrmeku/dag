/** JSON.parse wrapper that includes a context label and raw value preview in error messages. */
export function jsonParse<T = unknown>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    const preview = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    throw new Error(`JSON parse failed (${label}): ${(e as Error).message}\nRaw value: ${preview}`);
  }
}
