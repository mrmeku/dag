/**
 * Pack one workspace package for npm into a tarball: `bun scripts/pack.ts <package> <version> <out dir>`.
 * The tree is never edited. tsconfig.build.json emits every package's JavaScript and declarations
 * into a staging dir, laid out as `<package>/src/*.js`; the package's staged package.json gets the
 * version stamped, `private` dropped, every `.ts` entry pointed at its `.js`, and workspace deps
 * pinned to the same version; then `npm pack` writes `<name>-<version>.tgz` into the out dir and
 * prints its name. Bare imports of a sibling package stay bare: npm resolves them. A package in
 * INLINE_TYPES ships its declarations bundled, one file per export under `types/`, with those
 * packages' types inlined, so they never depend on a package the consumer may not have installed.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

/**
 * Per package, the imports whose types its declarations carry inline, each with the package that
 * holds them: optional peers and devDependencies, which a consumer's typecheck must not need.
 */
const INLINE_TYPES: Record<string, Record<string, string>> = {
  dagworkflows: {
    "@actions/artifact": "@actions/artifact",
    "@actions/cache": "@actions/cache",
    "@actions/github": "@actions/github",
    "proper-lockfile": "@types/proper-lockfile",
    retry: "@types/retry",
  },
};

const [pkg, version, outDir] = process.argv.slice(2);
if (!pkg || !version || !outDir) throw new Error("usage: pack.ts <package> <version> <out dir>");
const dir = `packages/${pkg}`;

const run = ([command, ...args]: [string, ...string[]], cwd = ".") => {
  const r = spawnSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error(`${[command, ...args].join(" ")} exited ${r.status}`);
  return r.stdout.toString();
};
const toJsRecord = (v: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJs(x)]));
const toJs = (v: unknown): unknown =>
  typeof v === "string"
    ? v.replace(/\.ts$/, ".js")
    : v && typeof v === "object"
      ? toJsRecord(v)
      : v;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string");

/** A field of package.json that holds strings by name, refused when it holds anything else. */
function strings(value: unknown, field: string): Record<string, string> {
  if (!isStrings(value))
    throw new Error(`${dir}/package.json: ${field} is not a record of strings`);
  return value;
}

/** Where `name` is installed, looked up from `from` as Node does. */
const installed = (name: string, from: string): string | undefined => {
  const at = join(from, "node_modules", name);
  if (existsSync(at)) return realpathSync(at);
  return dirname(from) === from ? undefined : installed(name, dirname(from));
};

/**
 * Bundle the declarations of each export of the staged package into `types/<name>.d.ts`, with
 * `inline`'s types in them, and check that they import nothing but the package's dependencies.
 */
async function bundleTypes(
  staged: string,
  exports: Record<string, string>,
  inline: Record<string, string>,
  dependencies: Record<string, string>,
) {
  // A package is looked up from this one, then from those before it, whose own dependency it may be.
  const found: string[] = [];
  const paths = Object.fromEntries(
    Object.entries(inline).map(([name, pkg]) => {
      const at = [resolve(dir), ...found].map((from) => installed(pkg, from)).find(Boolean);
      if (!at) throw new Error(`${pkg} is not installed`);
      found.push(at);
      return [name, [at]];
    }),
  );
  const bundle = await rollup({
    input: Object.fromEntries(
      Object.entries(exports).map(([sub, file]) => [
        sub === "." ? "index" : sub.slice(2),
        join(staged, file.replace(/\.ts$/, ".d.ts")),
      ]),
    ),
    plugins: [
      dts({
        includeExternal: [...Object.keys(inline), ...Object.values(inline)],
        compilerOptions: { paths },
      }),
    ],
    onwarn: (warning) => {
      if (warning.code !== "UNRESOLVED_IMPORT") throw new Error(warning.message);
    },
  });
  const { output } = await bundle.write({ dir: join(staged, "types"), format: "es" });
  const own = new Set(output.map((o) => o.fileName));
  const imported = output.flatMap((o) => (o.type === "chunk" ? o.imports : []));
  const stray = imported.filter((i) => !own.has(i) && !(i in dependencies));
  if (stray.length)
    throw new Error(`${pkg}'s declarations import ${[...new Set(stray)].join(", ")}`);
}

const stage = mkdtempSync(join(tmpdir(), "pack-"));
try {
  run(["bunx", "tsgo", "-p", "tsconfig.build.json", "--outDir", stage]);
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!isRecord(manifest)) throw new Error(`${dir}/package.json holds no object`);
  const { private: _private, scripts: _scripts, ...rest } = manifest;
  const dependencies = Object.fromEntries(
    Object.entries(strings(manifest["dependencies"] ?? {}, "dependencies")).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? version : range,
    ]),
  );
  const inline = INLINE_TYPES[pkg];
  const exports = inline && strings(manifest["exports"], "exports");
  if (exports) await bundleTypes(join(stage, pkg), exports, inline, dependencies);
  const staged = {
    ...toJsRecord(rest),
    version,
    dependencies,
    ...(exports
      ? {
          types: "./types/index.d.ts",
          exports: Object.fromEntries(
            Object.entries(exports).map(([sub, file]) => [
              sub,
              {
                types: `./types/${sub === "." ? "index" : sub.slice(2)}.d.ts`,
                default: toJs(file),
              },
            ]),
          ),
          files: ["src/**/*.js", "types", "README.md"],
        }
      : { files: ["src", "README.md"] }),
  };
  writeFileSync(join(stage, pkg, "package.json"), JSON.stringify(staged, null, 2) + "\n");
  cpSync(join(dir, "README.md"), join(stage, pkg, "README.md"));
  console.log(run(["npm", "pack", "--pack-destination", resolve(outDir)], join(stage, pkg)).trim());
} finally {
  rmSync(stage, { recursive: true, force: true });
}
