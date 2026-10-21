/** A thrown value's message: an error's own, anything else as text. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A thrown value as a result's error: its name, its message and the cause it carries. */
export function errorOf(
  e: unknown,
  message = errorMessage(e),
): { name: string; message: string; cause?: unknown } {
  return {
    name: e instanceof Error ? e.name : "Error",
    message,
    ...(e instanceof Error && e.cause !== undefined && { cause: e.cause }),
  };
}
