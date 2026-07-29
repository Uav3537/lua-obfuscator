// RNG helpers shared by every pass. Not cryptographically secure by
// necessity (obfuscation variety, not security-critical randomness —
// EncryptStrings' key material is generated separately with more entropy),
// but backed by Web Crypto when it's available for better statistical
// quality than Math.random().
//
// Works unmodified in both the browser and Node.js: it only ever touches
// `globalThis.crypto` (the standard Web Crypto API, present in every modern
// browser and in Node >= 19 as a global — Node 18 exposes the same API via
// `require('node:crypto').webcrypto`, just not globally by default). There
// is no static `import 'node:crypto'` here, so nothing breaks when this
// file is bundled for the browser. If `globalThis.crypto` isn't present at
// all (very old browsers, or Node < 19 without the webcrypto global), every
// helper below falls back to `Math.random()` so the obfuscator still runs.

function webcrypto(): Crypto | undefined {
  return typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
}

/** A random, unsigned 32-bit integer, from crypto when available. */
function randomUint32(): number {
  const c = webcrypto();
  if (c && typeof c.getRandomValues === 'function') {
    return c.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x100000000);
}

/**
 * 32 random hex characters — the same shape as a UUID's digits, just
 * without the hyphens (those aren't valid in a Lua identifier anyway).
 * Prefers `crypto.randomUUID()`, but that's only exposed in secure
 * contexts (https/localhost) in browsers, so this falls back to building
 * the same kind of string from `crypto.getRandomValues()`, and finally to
 * `Math.random()` if neither is available.
 */
function randomHex32(): string {
  const c = webcrypto();
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID().replace(/-/g, '');
    } catch {
      // Fall through to getRandomValues — e.g. insecure-context browsers
      // where the property exists but throws when called.
    }
  }
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function randInt(min: number, max: number): number {
  const range = max - min + 1;
  return min + (randomUint32() % range);
}

export function choice<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

export function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Valid Lua identifier: starts with a letter/underscore, then letters/digits/underscores. */
const VALID_LUA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Generates the `a1b2c3d4`-style random identifiers used by
 * RenameVariables: an underscore followed by a random slice of crypto-backed
 * hex characters. Every candidate is filtered through the same rules a Lua
 * valid here, but the check stays in place as a safety net against future
 * changes to the generator — and against collisions with names already in
 * scope or Lua's reserved words.
 */
export function randomVarName(existing: Set<string>): string {
  // Hex digits are 0-9a-f, so a raw slice starts with a digit ~62.5% of the
  // time and fails VALID_LUA_IDENTIFIER, forcing a fresh crypto call and
  // retry. Force the first character to always be a valid identifier start
  // (a-f, the only letters hex produces) so the loop only ever retries on
  // an actual name collision, not on this near-certain first-attempt miss.
  let name: string;
  do {
    const len = randInt(5, 10);
    const body = randomHex32().slice(0, len - 1);
    const firstCharPool = 'abcdef';
    const first = firstCharPool[randInt(0, firstCharPool.length - 1)];
    name = first + body;
  } while (!VALID_LUA_IDENTIFIER.test(name) || existing.has(name) || RESERVED.has(name));
  existing.add(name);
  return name;
}

/** Short opaque key used for constant-array / bytecode-array table slots. */
export function randomKey(len = 5): string {
  let s = '';
  for (let i = 0; i < len; i++) s += NAME_CHARS[randInt(0, NAME_CHARS.length - 1)];
  return s;
}

export const RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while', 'continue', 'self',
]);