/**
 * Pack one workspace package for npm into a tarball: `bun scripts/pack.ts <package> <version> <out dir>`.
 * The tree is never edited. tsconfig.build.json emits every package's JavaScript and declarations
 * into a staging dir, laid out as `<package>/src/*.js`; the package's staged package.json gets the
 * version stamped, `private` dropped, every `.ts` entry pointed at its `.js`, and workspace deps
 * pinned to the same version; then `npm pack` writes `<name>-<version>.tgz` into the out dir and
 * prints its name. Bare imports of a sibling package stay bare: npm resolves them.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [pkg, version, outDir] = process.argv.slice(2);
if (!pkg || !version || !outDir) throw new Error("usage: pack.ts <package> <version> <out dir>");
const dir = `packages/${pkg}`;

const run = (cmd: string[], cwd = ".") => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} exited ${r.status}`);
  return r.stdout.toString();
};
const toJs = (v: unknown): unknown =>
  typeof v === "string"
    ? v.replace(/\.ts$/, ".js")
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJs(x)]))
      : v;

const stage = mkdtempSync(join(tmpdir(), "pack-"));
try {
  run(["bunx", "tsgo", "-p", "tsconfig.build.json", "--outDir", stage]);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const { private: _private, scripts: _scripts, ...rest } = manifest;
  const dependencies = Object.fromEntries(
    Object.entries((manifest.dependencies as Record<string, string>) ?? {}).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? version : range,
    ]),
  );
  const staged = { ...(toJs(rest) as object), version, files: ["src", "README.md"], dependencies };
  writeFileSync(join(stage, pkg, "package.json"), JSON.stringify(staged, null, 2) + "\n");
  cpSync(join(dir, "README.md"), join(stage, pkg, "README.md"));
  console.log(run(["npm", "pack", "--pack-destination", resolve(outDir)], join(stage, pkg)).trim());
} finally {
  rmSync(stage, { recursive: true, force: true });
}
