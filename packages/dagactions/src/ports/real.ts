import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { CHILD_SIGINT_GRACE_MS, CHILD_SIGTERM_GRACE_MS, STREAM_DRAIN_GRACE_MS } from "../config.ts";
import type { Clock, Sh, ShResult, SyncFs } from "../ports.ts";

/**
 * The real shell. A cancelled command is interrupted the way GitHub's runner interrupts a step:
 * SIGINT, SIGTERM after `sigintGraceMs`, SIGKILL after `sigtermGraceMs` more. A command killed
 * by a signal resolves with code -1 and the signal's name on stderr and at the end of `output`.
 * A process the command left behind holding its output (a server started with `&`) is cut off
 * `streamDrainGraceMs` after the command exits, so neither it nor a killed command's orphan keeps
 * the node running.
 */
export function createSh(
  opts: { sigintGraceMs?: number; sigtermGraceMs?: number; streamDrainGraceMs?: number } = {},
): Sh {
  const sigintGraceMs = opts.sigintGraceMs ?? CHILD_SIGINT_GRACE_MS;
  const sigtermGraceMs = opts.sigtermGraceMs ?? CHILD_SIGTERM_GRACE_MS;
  const streamDrainGraceMs = opts.streamDrainGraceMs ?? STREAM_DRAIN_GRACE_MS;
  return {
    run: (cmd, runOpts) =>
      new Promise<ShResult>((resolve) => {
        const signal = runOpts?.signal;
        const onOutput = runOpts?.onOutput ?? (() => {});
        if (signal?.aborted) {
          const message = "cancelled before start";
          onOutput(message);
          resolve({ code: -1, stdout: "", stderr: message, output: message, ok: false });
          return;
        }
        const [bin, ...args] = cmd;
        const proc = spawn(bin ?? "", args, {
          cwd: runOpts?.cwd,
          env: runOpts?.env ? { ...process.env, ...runOpts.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const out: string[] = [];
        const err: string[] = [];
        const all: string[] = [];
        const timers: NodeJS.Timeout[] = [];
        const onAbort = () => {
          proc.kill("SIGINT");
          timers.push(setTimeout(() => proc.kill("SIGTERM"), sigintGraceMs));
          timers.push(setTimeout(() => proc.kill("SIGKILL"), sigintGraceMs + sigtermGraceMs));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const settle = (result: ShResult) => {
          for (const t of timers) clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const recordChunk = (chunks: string[]) => (chunk: string) => {
          chunks.push(chunk);
          all.push(chunk);
          onOutput(chunk);
        };
        proc.stdout.setEncoding("utf8").on("data", recordChunk(out));
        proc.stderr.setEncoding("utf8").on("data", recordChunk(err));
        proc.on("error", (e) => {
          onOutput(e.message);
          settle({ code: -1, stdout: "", stderr: e.message, output: e.message, ok: false });
        });
        proc.on("exit", () => {
          timers.push(
            setTimeout(() => {
              proc.stdout.destroy();
              proc.stderr.destroy();
            }, streamDrainGraceMs),
          );
        });
        proc.on("close", (code, killedBy) => {
          const c = code ?? -1;
          const withKill = (text: string) =>
            killedBy
              ? `${text}${text.endsWith("\n") || !text ? "" : "\n"}killed by ${killedBy}\n`
              : text;
          const outputSoFar = all.join("");
          const output = withKill(outputSoFar);
          if (output !== outputSoFar) onOutput(output.slice(outputSoFar.length));
          settle({
            code: c,
            stdout: out.join(""),
            stderr: withKill(err.join("")),
            output,
            ok: c === 0,
          });
        });
      }),
  };
}

export const syncFs: SyncFs = fs;

export function systemClock(): Clock {
  return { now: () => Date.now() };
}

/**
 * A signal to abort on SIGINT or SIGTERM: Ctrl-C locally, and on GitHub the runner's SIGINT to
 * the step, then its SIGTERM 7500 ms later. Either cancels the run: waiting nodes settle as
 * cancelled, running commands are interrupted, and the process exits once they have stopped.
 * A second signal exits at once.
 */
export function abortOnSignals(): AbortSignal {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) process.exit(130);
    console.log(`${signal}: cancelling, waiting for running commands to stop`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return controller.signal;
}
