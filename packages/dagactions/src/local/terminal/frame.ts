import stringWidth from "string-width";
import { isDebugCommand, textOf } from "../../kernel/format.ts";

const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h";
const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l";
const DISABLE_LINE_WRAP = "\x1b[?7l";
const ENABLE_LINE_WRAP = "\x1b[?7h";

type WriteStream = NodeJS.WriteStream;

export interface WriteStreams {
  stdout: Pick<WriteStream, "write"> &
    Partial<Pick<WriteStream, "columns" | "rows" | "isTTY" | "hasColors">>;
  stderr: Pick<WriteStream, "write">;
}

/**
 * The footer's writer. Until `restore` it holds other writes to stdout and stderr for the
 * scrollback, debug commands dropped, so the footer never erases them. Each draw is one
 * synchronized write that erases the footer, prints the scrollback, then the rows with wrapping
 * off, so a misjudged width clips; the rows end in "\r", so a ^C echo cannot wrap one. A window
 * made narrower reflows each row onto the lines it now takes, and the erase counts those.
 */
export function createFrame(streams: WriteStreams) {
  const writeToTerminal = streams.stdout.write.bind(streams.stdout);
  const originalWrites = { stdout: streams.stdout.write, stderr: streams.stderr.write };
  let heldScrollback = "";
  let drawnFooterRows: string[] = [];
  const endHeldLine = () => {
    if (heldScrollback && !heldScrollback.endsWith("\n")) heldScrollback += "\n";
  };
  const holdWrite: WriteStream["write"] = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (!isDebugCommand(text)) heldScrollback += text;
    const callback = rest.find((argument) => typeof argument === "function") as
      | (() => void)
      | undefined;
    if (callback) process.nextTick(callback);
    return true;
  };
  streams.stdout.write = holdWrite;
  streams.stderr.write = holdWrite;
  return {
    print: (lines: string[]) => {
      endHeldLine();
      heldScrollback += textOf(lines);
    },
    draw: (rows: string[]) => {
      if (!heldScrollback && rows.length === 0 && drawnFooterRows.length === 0) return;
      endHeldLine();
      const columns = streams.stdout.columns ?? Infinity;
      const linesAboveCursor = drawnFooterRows
        .slice(0, -1)
        .reduce(
          (lineCount, footerRow) =>
            lineCount + Math.max(1, Math.ceil(stringWidth(footerRow) / columns)),
          0,
        );
      const eraseFooter =
        drawnFooterRows.length === 0
          ? ""
          : `\r${linesAboveCursor > 0 ? `\x1b[${linesAboveCursor}A` : ""}\x1b[J`;
      const footerText =
        rows.length > 0 ? `${DISABLE_LINE_WRAP}${rows.join("\n")}\r${ENABLE_LINE_WRAP}` : "";
      writeToTerminal(
        `${BEGIN_SYNCHRONIZED_UPDATE}${eraseFooter}${heldScrollback}${footerText}${END_SYNCHRONIZED_UPDATE}`,
      );
      heldScrollback = "";
      drawnFooterRows = rows;
    },
    restore: () => {
      streams.stdout.write = originalWrites.stdout;
      streams.stderr.write = originalWrites.stderr;
    },
  };
}
