/**
 * Path handling compatible with lodash's `get` / `set` / `unset`, which both
 * quick.db and wio.db use for dot-notation keys. Ported from lodash 4.17.21
 * (MIT, https://lodash.com/license): `_stringToPath`, `_isKey`, `_baseSet`,
 * `_baseUnset`. Difference: reads only follow own properties, so a key such as
 * `"toString"` never resolves to an inherited function.
 */

const rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;
const reEscapeChar = /\\(\\)?/g;
const reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/;
const reIsPlainProp = /^\w*$/;
const reIsUint = /^(?:0|[1-9]\d*)$/;

type Container = Record<string, unknown>;

/** lodash `isKey` without the object check: whether `path` must be parsed into segments. */
export function isDeepPath(path: string): boolean {
  return !reIsPlainProp.test(path) && reIsDeepProp.test(path);
}

/** lodash `stringToPath`. */
export function stringToPath(path: string): string[] {
  const result: string[] = [];
  if (path.charCodeAt(0) === 46 /* . */) result.push("");
  path.replace(rePropName, (match: string, number?: string, quote?: string, subString?: string) => {
    result.push(quote ? (subString ?? "").replace(reEscapeChar, "$1") : (number ?? match));
    return match;
  });
  return result;
}

/** lodash `castPath(path, object)`: a literal property wins over parsing. */
export function castPath(path: string, object: unknown): string[] {
  if (!isDeepPath(path)) return [path];
  if (object != null && path in Object(object)) return [path];
  return stringToPath(path);
}

function isObjectLike(value: unknown): value is Container {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isIndex(value: string): boolean {
  return reIsUint.test(value) && Number(value) < Number.MAX_SAFE_INTEGER;
}

function ownProperty(value: unknown, key: string): unknown {
  const boxed: unknown = Object(value);
  if (!isObjectLike(boxed) || !Object.hasOwn(boxed, key)) return undefined;
  return boxed[key];
}

/** lodash `get(object, path)` over an already-cast path, own properties only. */
export function lodashGet(object: unknown, path: readonly string[]): unknown {
  let current = object;
  let index = 0;
  while (current != null && index < path.length) {
    current = ownProperty(current, path[index++]!);
  }
  return index > 0 && index === path.length ? current : undefined;
}

/** lodash `set(object, path, value)`: creates arrays for index-like segments, objects otherwise. */
export function lodashSet(object: unknown, path: readonly string[], value: unknown): void {
  if (!isObjectLike(object)) return;
  let nested: Container = object;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    if (key === "__proto__" || key === "constructor" || key === "prototype") return;
    let newValue = value;
    if (i !== path.length - 1) {
      const existing = nested[key];
      newValue = isObjectLike(existing) ? existing : isIndex(path[i + 1]!) ? [] : {};
    }
    nested[key] = newValue;
    const next = nested[key];
    if (!isObjectLike(next)) return;
    nested = next;
  }
}

/** lodash `unset(object, path)`. Deleting an array index leaves a hole (stored as `null`). */
export function lodashUnset(object: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return true;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    if (key === "__proto__" && !(isObjectLike(object) && Object.hasOwn(object, "__proto__"))) return false;
    if ((key === "constructor" || key === "prototype") && i < path.length - 1) return false;
  }
  const parent = path.length < 2 ? object : lodashGet(object, path.slice(0, -1));
  if (parent == null) return true;
  if (!isObjectLike(parent)) return false;
  return delete parent[path[path.length - 1]!];
}
