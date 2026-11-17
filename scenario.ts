// scenario.ts — deterministic scenario data for the git forge.
//
// The sealed suite derives every viewer / user identity from one constant
// scenario seed (0x6a09e667f3bcc909). This module re-implements that
// derivation (FNV-1a + splitmix64 + xorshift64*) so the forge knows, without
// any network or config, which login the suite's Bearer token names.
//
// Only the viewer login is needed at runtime: every repository in the forge
// belongs to that login, and any other owner is treated as a stranger whose
// repositories simply do not exist (GitHub answers 404, never 403).

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_EPOCH_SEC = 1735689600;

const MASK64 = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const ch of text) {
    hash = ((hash ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & MASK64;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed === 0n ? SCENARIO_SEED : seed;
  }

  private nextU64(): bigint {
    let x = this.state;
    x ^= x >> 12n;
    x ^= (x << 25n) & MASK64;
    x ^= x >> 27n;
    this.state = x & MASK64;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  private nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(max: number): number {
    const range = 2 ** 32;
    const limit = range - (range % max);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % max;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  "ada", "bram", "cora", "dmitri", "elena", "felix", "greta", "hugo",
  "iris", "jonas", "kira", "lars", "mira", "nico", "olga", "pavel",
  "quinn", "rosa", "sven", "tess", "ulla", "vito", "wren", "yara", "zane",
] as const;

const LAST_NAMES = [
  "anders", "bauer", "costa", "dahl", "eriksen", "fischer", "garcia",
  "holm", "iversen", "jansen", "keller", "lind", "moreau", "novak",
  "olsen", "peters", "quist", "rossi", "sato", "turi", "ulrich", "vega",
  "weber", "xu", "yilmaz", "zimmer",
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const users: ScenarioUser[] = [];
  const used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/gi, "").toLowerCase();
    let login = base;
    let suffix = 2;
    while (used.has(login)) login = `${base}-${suffix++}`;
    used.add(login);
    users.push({
      id: 1000 + i,
      login,
      name: `${first} ${last}`,
      email: `${login}@example.invalid`,
    });
  }
  return users;
}

/** The 12 seeded users; users[0] is the viewer the suite's token names. */
export const USERS: ScenarioUser[] = generateUsers(
  new Rng(scenarioSeedFor("users")),
  12,
);

export const VIEWER: ScenarioUser = USERS[0];

/** A monotonically increasing, deterministic clock for forge-created commits. */
let deterministicClock = SCENARIO_EPOCH_SEC;

/** Next deterministic timestamp (seconds since epoch). */
export function nextTimestamp(): number {
  return deterministicClock++;
}
