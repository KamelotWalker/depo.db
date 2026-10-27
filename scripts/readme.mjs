// Run all JavaScript fences through public package exports, without supplying
// snippet globals. Only simple named import/require syntax is translated.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const files = ["README.md", "docs/README.tr.md", "llms.txt"];
// Shell commands and illustrative reports are not JS. Diff blocks describe
// edits; TypeScript fragments (including inline signatures) are not runnable JS.
const nonExecutable = new Map([
  ["sh", "shell"], ["diff", "patch"], ["ts", "types"],
  ["typescript", "types"], ["", "output"], ["text", "output"],
]);

function extract(markdown, file) {
  const examples = [];
  const classified = { shell: 0, patch: 0, types: 0, output: 0 };
  const lines = markdown.split(/\r?\n/);
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] &&
          marker[1].length >= fence.marker.length && marker[2].trim() === "") {
        if (fence.executable) {
          const code = lines.slice(fence.start, i).join("\n");
          if (!code.trim()) throw new Error(`${file}:${fence.start + 1}: empty JavaScript fence`);
          examples.push({ code, line: fence.start + 1 });
        }
        fence = undefined;
      }
      continue;
    }
    if (!marker) continue;
    const language = marker[2].trim();
    const executable = language === "js" || language === "javascript";
    if (!executable && !nonExecutable.has(language)) {
      throw new Error(`${file}:${i + 1}: unsupported fence language ${JSON.stringify(language)}`);
    }
    if (!executable) classified[nonExecutable.get(language)]++;
    fence = { marker: marker[1], executable, start: i + 1 };
  }
  if (fence) throw new Error(`${file}:${fence.start}: unclosed code fence`);
  if (examples.length === 0) throw new Error(`${file}: no JavaScript fences`);
  return { examples, classified };
}

function moduleCode(code, mode) {
  // Deliberately narrow: unknown module forms must fail, not be skipped or
  // rewritten heuristically. Any other unsupported JS fails in the subprocess.
  const names = "([A-Za-z_$][\\w$]*(?:\\s*,\\s*[A-Za-z_$][\\w$]*)*)";
  const imported = new RegExp(`^\\s*import\\s*\\{\\s*${names}\\s*\\}\\s*from\\s*([\"'])([^\"']+)\\2;?(\\s*(?://.*)?)$`);
  const required = new RegExp(`^\\s*const\\s*\\{\\s*${names}\\s*\\}\\s*=\\s*require\\(([\"'])([^\"']+)\\2\\);?(\\s*(?://.*)?)$`);
  const converted = code.split("\n").map((line) => {
    const match = imported.exec(line) ?? required.exec(line);
    if (match) {
      return mode === "esm"
        ? `import { ${match[1]} } from ${JSON.stringify(match[3])};${match[4]}`
        : `const { ${match[1]} } = require(${JSON.stringify(match[3])});${match[4]}`;
    }
    if (/^\s*(?:import\b|export\b)/.test(line) || /\brequire\s*\(/.test(line)) {
      throw new Error(`unsupported module syntax: ${line.trim()}`);
    }
    return line;
  }).join("\n");
  return mode === "esm" ? converted :
    `(async () => {\n${converted}\n})().catch((error) => { console.error(error); process.exitCode = 1; });\n`;
}

/**
 * Execute source docs against either this checkout's built exports or an installed
 * consumer's depo.db. Temporary directories live directly under consumerRoot so
 * normal Node ESM/CJS resolution selects that consumer's package, not this script's.
 * No build, install, shell commands, or copying of package/docs is performed.
 */
export function runReadmeExamples({ docsRoot = root, consumerRoot = root } = {}) {
  docsRoot = resolve(docsRoot);
  consumerRoot = resolve(consumerRoot);
  const documents = files.map((file) => ({
    file, ...extract(readFileSync(join(docsRoot, file), "utf8"), file),
  }));
  const counts = { snippets: 0, esm: 0, cjs: 0, documents: [] };
  for (const { file, examples, classified } of documents) {
    counts.documents.push({ file, snippets: examples.length, nonExecutable: classified });
    counts.snippets += examples.length;
    for (const { code, line } of examples) {
      for (const mode of ["esm", "cjs"]) {
        const label = `${file}:${line} (${mode})`;
        const work = mkdtempSync(join(consumerRoot, ".depo-readme-"));
        try {
          const script = join(work, mode === "esm" ? "snippet.mjs" : "snippet.cjs");
          writeFileSync(script, moduleCode(code, mode));
          const result = spawnSync(process.execPath, [script], {
            cwd: work, encoding: "utf8", timeout: 30_000,
          });
          if (result.error || result.status !== 0) {
            throw new Error(`${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
          }
          counts[mode]++;
        } catch (error) {
          throw new Error(`${label}: ${error.message}`, { cause: error });
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      }
    }
  }
  return counts;
}

// Positional CLI: node scripts/readme.mjs [docs-root] [consumer-root]
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 4) throw new Error("Usage: node scripts/readme.mjs [docs-root] [consumer-root]");
  console.log(JSON.stringify(runReadmeExamples({
    docsRoot: process.argv[2] ?? root,
    consumerRoot: process.argv[3] ?? root,
  }), null, 2));
}
