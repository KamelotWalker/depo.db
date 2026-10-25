import { DepoError } from "./errors.js";
import { assertWellFormed, type Store } from "./store.js";

export interface LeaderboardEntry {
  member: string;
  score: number;
  /** One-based position: score descending, then member ascending (BINARY). */
  rank: number;
}

/** A sorted set in one namespace, sharing its parent Depo's connection and transactions. */
export class Leaderboard {
  readonly #store: Store;
  readonly #namespace: string;
  readonly #name: string;

  /** @internal Obtain a board through `Depo#leaderboard(name)`. */
  constructor(store: Store, namespace: string, name: string) {
    assertName("Leaderboard name", name);
    this.#store = store;
    this.#namespace = namespace;
    this.#name = name;
  }

  /** Stores and returns a finite score. */
  set(member: string, score: number): number {
    assertName("Member", member);
    if (typeof score !== "number" || !Number.isFinite(score)) throw new DepoError("score must be a finite number");
    return this.#store.setScore(this.#namespace, this.#name, member, score, false);
  }

  /** Atomically increments a score; a missing member starts at zero. */
  add(member: string, delta: number): number {
    assertName("Member", member);
    if (typeof delta !== "number" || !Number.isFinite(delta)) throw new DepoError("delta must be a finite number");
    return this.#store.setScore(this.#namespace, this.#name, member, delta, true);
  }

  score(member: string): number | undefined {
    assertName("Member", member);
    return this.#store.score(this.#namespace, this.#name, member);
  }

  /** One-based rank, highest score first; ties use BINARY member order. */
  rank(member: string): number | undefined {
    assertName("Member", member);
    return this.#store.rank(this.#namespace, this.#name, member);
  }

  top(limit = 10, offset = 0): LeaderboardEntry[] {
    if (!Number.isInteger(limit) || limit < 0) throw new DepoError("limit must be a non-negative integer");
    if (!Number.isInteger(offset) || offset < 0) throw new DepoError("offset must be a non-negative integer");
    return this.#store.top(this.#namespace, this.#name, limit, offset);
  }

  remove(member: string): boolean {
    assertName("Member", member);
    return this.#store.removeScore(this.#namespace, this.#name, member);
  }

  count(): number {
    return this.#store.countScores(this.#namespace, this.#name);
  }

  /** Removes this board's members and returns the number removed. */
  clear(): number {
    return this.#store.clearScores(this.#namespace, this.#name);
  }
}

function assertName(what: string, name: string): void {
  if (typeof name !== "string" || name.length === 0) throw new DepoError(`${what} must be a non-empty string`);
  assertWellFormed(what, name);
}

