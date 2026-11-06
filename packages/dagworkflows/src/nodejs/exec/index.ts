import { spawn } from "node:child_process";
import {
  CHILD_SIGINT_GRACE_MS,
  CHILD_SIGTERM_GRACE_MS,
  STREAM_DRAIN_GRACE_MS,
} from "../../config/index.ts";
import type { Exec, ExecResult } from "../../tasks/index.ts";

/** The process groups of the commands running now: a second signal kills them on its way out. */
const groups = new Set<number>();

/** Signals a command's process group, which may be gone already. */
const signalGroup = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pid, sig);
  } catch {
    // The group is gone already.
  }
};

/** Whether any process of a command's group is left. */
const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
};

/**
 * The Exec over Node's child processes. A cancelled command is interrupted the way GitHub's runner
 * interrupts a step: SIGINT, SIGTERM after `sigintGraceMs`, SIGKILL after `sigtermGraceMs` more.
 * Each command runs in a process group of its own and the signals go to the group, so what it
 * started stops with it. Once a cancelled command exits, what is left of its group, such as a
 * background job, which ignores SIGINT, gets SIGTERM and, if it is still there `sigtermGraceMs`
 * later, SIGKILL, as systemd stops a unit; the command settles when the group is gone. A command
 * killed by a signal resolves `signalled`, with code -1 and the signal's name on stderr and at the
 * end of `output`. A process the command left behind holding its output (a server started with
 * `&`) is cut off `streamDrainGraceMs` after the command exits, so neither it nor a killed
 * command's orphan keeps the node running.
 */
export function createExec(
  opts: { sigintGraceMs?: number; sigtermGraceMs?: number; streamDrainGraceMs?: number } = {},
): Exec {
  const sigintGraceMs = opts.sigintGraceMs ?? CHILD_SIGINT_GRACE_MS;
  const sigtermGraceMs = opts.sigtermGraceMs ?? CHILD_SIGTERM_GRACE_MS;
  const streamDrainGraceMs = opts.streamDrainGraceMs ?? STREAM_DRAIN_GRACE_MS;
  return {
    run: (cmd, runOpts) =>
      new Promise<ExecResult>((resolve) => {
        const signal = runOpts?.signal;
        const onOutput = runOpts?.onOutput ?? (() => {});
        if (signal?.aborted) {
          const message = "cancelled before start";
          onOutput(message);
          resolve({
            ended: "not-started",
            code: -1,
            stdout: "",
            stderr: message,
            output: message,
            ok: false,
          });
          return;
        }
        const [program, ...args] = cmd;
        const proc = spawn(program ?? "", args, {
          cwd: runOpts?.cwd,
          env: runOpts?.env ? { ...process.env, ...runOpts.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        const out: string[] = [];
        const err: string[] = [];
        const all: string[] = [];
        const timers: NodeJS.Timeout[] = [];
        const pid = proc.pid;
        if (pid !== undefined) groups.add(pid);
        const kill = (sig: NodeJS.Signals) => pid !== undefined && signalGroup(pid, sig);
        const onAbort = () => {
          kill("SIGINT");
          timers.push(setTimeout(() => kill("SIGTERM"), sigintGraceMs));
          timers.push(setTimeout(() => kill("SIGKILL"), sigintGraceMs + sigtermGraceMs));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const settle = async (result: ExecResult) => {
          for (const t of timers) clearTimeout(t);
          if (signal?.aborted && pid !== undefined && groupAlive(pid)) {
            kill("SIGTERM");
            const grace = { over: false };
            const timer = setTimeout(() => (grace.over = true), sigtermGraceMs);
            while (groupAlive(pid) && !grace.over) await new Promise((r) => setTimeout(r, 20));
            clearTimeout(timer);
            kill("SIGKILL");
          }
          if (pid !== undefined) groups.delete(pid);
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
        // Only the spawn can fail here: nothing kills or messages `proc` through Node.
        proc.on("error", (e: NodeJS.ErrnoException) => {
          // Node's wording, `spawn bash ENOENT`, under Bun too.
          const message = e.code ? `spawn ${program} ${e.code}` : e.message;
          onOutput(message);
          void settle({
            ended: "not-started",
            code: -1,
            stdout: "",
            stderr: message,
            output: message,
            ok: false,
          });
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
          const stdout = out.join("");
          const stderr = err.join("");
          const output = all.join("");
          if (!killedBy) {
            void settle({
              ended: "exited",
              code: code ?? -1,
              stdout,
              stderr,
              output,
              ok: code === 0,
            });
            return;
          }
          const killed = (text: string) =>
            `${text && !text.endsWith("\n") ? "\n" : ""}killed by ${killedBy}\n`;
          onOutput(killed(output));
          void settle({
            ended: "signalled",
            code: -1,
            stdout,
            stderr: stderr + killed(stderr),
            output: output + killed(output),
            ok: false,
          });
        });
      }),
  };
}

/**
 * After SIGHUP the terminal is gone, and a write to it fails with EIO, or EPIPE through a pipe,
 * as it does when whatever read the output has exited: the cancel and the post steps go on
 * without their output.
 */
const ignoreGone = (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE" && e.code !== "EIO") throw e;
};

/**
 * A signal to abort on SIGINT, SIGTERM or SIGHUP: Ctrl-C or a closed terminal locally, and on
 * GitHub the runner's SIGINT to the step, then its SIGTERM 7500 ms later. Each cancels the run:
 * waiting nodes settle as cancelled, running commands are interrupted, and the process exits once
 * they have stopped. A second signal SIGKILLs the process group of every command still running,
 * which no terminal signal reaches since each runs in a session of its own, and exits at once; the
 * next run finishes the post steps it owes.
 */
export function abortOnSignals(): AbortSignal {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      for (const pid of groups) signalGroup(pid, "SIGKILL");
      process.exit(130);
    }
    process.stdout.on("error", ignoreGone);
    process.stderr.on("error", ignoreGone);
    process.stdout.write(`${signal}: cancelling, waiting for running commands to stop\n`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  return controller.signal;
}
