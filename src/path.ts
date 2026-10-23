import { ZulaError } from "./errors.js";

/**
 * A key addresses one stored entry and, optionally, a path inside its JSON value.
 *
 * - String form: segments separated by `.`; write `\.` for a literal dot and
 *   `\\` for a literal backslash. Example: `"user.42.balance"`.
 * - Array form: one string per segment, no escaping. Example: `["user", "42", "balance"]`.
 *
 * The first segment is the entry key (the SQLite row). Remaining segments walk
 * into the stored JSON value.
 */
export type Key = string | readonly string[];

const INDEX_RE = /^(?:0|[1-9]\d*)$/;

/** Splits a key into its segments. Throws `ZulaError` for empty segments or bad escapes. */
export function parseKey(key: Key): string[] {
  if (typeof key === "string") return parseStringKey(key);
  if (!Array.isArray(key) || key.length === 0) {
    throw new ZulaError("Key must be a non-empty string or a non-empty array of strings");
  }
  const segments: string[] = [];
  for (const segment of key) {
    if (typeof segment !== "string" || segment.length === 0) {
      throw new ZulaError("Every key segment must be a non-empty string");
    }
    segments.push(segment);
  }
  return segments;
}

function parseStringKey(key: string): string[] {
  // Fast path: no dots and no escapes, which is the overwhelmingly common case.
  if (key.length > 0 && key.indexOf(".") === -1 && key.indexOf("\\") === -1) return [key];
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (ch === "\\") {
      const next = key[i + 1];
      if (next !== "." && next !== "\\") {
        throw new ZulaError(`Invalid escape in key ${JSON.stringify(key)}: only "\\." and "\\\\" are allowed`);
      }
      current += next;
      i++;
    } else if (ch === ".") {
      pushSegment(segments, current, key);
      current = "";
    } else {
      current += ch;
    }
  }
  pushSegment(segments, current, key);
  return segments;
}

function pushSegment(segments: string[], segment: string, key: string): void {
  if (segment.length === 0) throw new ZulaError(`Empty segment in key ${JSON.stringify(key)}`);
  segments.push(segment);
}

/** Escapes one segment so it can be embedded in a string key: `escapeKey("a.b")` → `"a\\.b"`. */
export function escapeKey(segment: string): string {
  return segment.replace(/[\\.]/g, (ch) => "\\" + ch);
}

/** Renders segments back to the string form, for error messages. */
export function formatKey(segments: readonly string[]): string {
  return segments.map(escapeKey).join(".");
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Reads `path` inside `root`. Missing properties and non-container intermediates yield `undefined`. */
export function getIn(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!isContainer(current)) return undefined;
    if (Array.isArray(current)) {
      if (!INDEX_RE.test(segment)) return undefined;
      current = current[Number(segment)];
    } else {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function assignOwn(target: Record<string, unknown>, segment: string, value: unknown): void {
  if (segment === "__proto__") {
    // Plain assignment would invoke the prototype setter; define an own data property instead.
    Object.defineProperty(target, segment, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[segment] = value;
  }
}

function assignChild(container: Record<string, unknown> | unknown[], segment: string, value: unknown, where: string): void {
  if (Array.isArray(container)) {
    if (!INDEX_RE.test(segment)) {
      throw new ZulaError(`Cannot set ${JSON.stringify(segment)} on the array at ${where}: segment is not an array index`);
    }
    const index = Number(segment);
    if (index > container.length) {
      throw new ZulaError(`Cannot set index ${index} on the array at ${where}: length is ${container.length}, holes are not allowed`);
    }
    container[index] = value;
  } else {
    assignOwn(container, segment, value);
  }
}

/**
 * Returns `root` with `value` written at `path`. Missing intermediate
 * containers are created as plain objects. Writing through a primitive, or a
 * non-index segment into an array, throws instead of silently replacing data.
 * Mutates and returns `root` (or a new object when `root` is `undefined`).
 */
export function setIn(root: unknown, rowKey: string, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const top = root === undefined ? {} : root;
  if (!isContainer(top)) {
    throw new ZulaError(`Cannot set a path inside ${JSON.stringify(rowKey)}: its value is ${typeName(top)}, not an object`);
  }
  let container: Record<string, unknown> | unknown[] = top;
  const walked = [rowKey];
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const where = formatKey(walked);
    const existing = getIn(container, [segment]);
    let next: Record<string, unknown> | unknown[];
    if (existing === undefined) {
      next = {};
      assignChild(container, segment, next, where);
    } else if (isContainer(existing)) {
      next = existing;
    } else {
      walked.push(segment);
      throw new ZulaError(`Cannot set a path through ${formatKey(walked)}: its value is ${typeName(existing)}, not an object`);
    }
    walked.push(segment);
    container = next;
  }
  assignChild(container, path[path.length - 1]!, value, formatKey(walked));
  return top;
}

/** Removes `path` inside `root` in place. Array elements are spliced out. Returns whether something was removed. */
export function deleteIn(root: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return false;
  const parent = getIn(root, path.slice(0, -1));
  if (!isContainer(parent)) return false;
  const last = path[path.length - 1]!;
  if (Array.isArray(parent)) {
    if (!INDEX_RE.test(last)) return false;
    const index = Number(last);
    if (index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }
  if (!Object.hasOwn(parent, last)) return false;
  delete parent[last];
  return true;
}
