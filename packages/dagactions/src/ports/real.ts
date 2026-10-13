import { spawn } from "node:child_process";
import { CHILD_SIGINT_GRACE_MS, CHILD_SIGTERM_GRACE_MS } from "../config.ts";
import type { Clock, Sh, ShResult } from "../ports.ts";

/**
 * The real shell. A cancelled command is interrupted the way GitHub's runner interrupts a step:
 * SIGINT, SIGTERM after `sigintGraceMs`, SIGKILL after `sigtermGraceMs` more. A command killed
 * by a signal resolves with code -1 and the signal's name on stderr.
 */
export function createSh(opts: { sigintGraceMs?: number; sigtermGraceMs?: number } = {}): Sh {
  const sigintGraceMs = opts.sigintGraceMs ?? CHILD_SIGINT_GRACE_MS;
  const sigtermGraceMs = opts.sigtermGraceMs ?? CHILD_SIGTERM_GRACE_MS;
  return {
    run: (cmd, runOpts) =>
      new Promise<ShResult>((resolve) => {
        const signal = runOpts?.signal;
        if (signal?.aborted) {
          resolve({ code: -1, stdout: "", stderr: "cancelled before start", ok: false });
          return;
        }
        const [bin, ...args] = cmd;
        const proc = spawn(bin ?? "", args, {
          cwd: runOpts?.cwd,
          env: runOpts?.env ? { ...process.env, ...runOpts.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
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
        proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        proc.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        proc.on("error", (e) => settle({ code: -1, stdout: "", stderr: e.message, ok: false }));
        proc.on("close", (code, killedBy) => {
          const c = code ?? -1;
          const stderr = Buffer.concat(err).toString();
          settle({
            code: c,
            stdout: Buffer.concat(out).toString(),
            stderr: killedBy
              ? `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}killed by ${killedBy}\n`
              : stderr,
            ok: c === 0,
          });
        });
      }),
  };
}

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
