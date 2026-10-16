import { dirname } from "node:path";
import { errorMessage } from "../../kernel/format.ts";
import type { SyncFs } from "../../ports.ts";

/**
 * A recorder's writes, synchronous so its files are whole when the process is forced out. The
 * first that fails warns, and the recorder stops there: a full disk never stops the run.
 */
export function createWriter(fs: SyncFs, warn: (message: string) => void, recorderName: string) {
  const madeDirectories = new Set<string>();
  let disabled = false;
  return (path: string, text: string, append = false): boolean => {
    if (disabled) return false;
    try {
      if (!madeDirectories.has(dirname(path))) fs.mkdirSync(dirname(path), { recursive: true });
      madeDirectories.add(dirname(path));
      if (append) fs.appendFileSync(path, text);
      else fs.writeFileSync(path, text);
      return true;
    } catch (e) {
      disabled = true;
      warn(`${recorderName} off: ${errorMessage(e)}`);
      return false;
    }
  };
}
