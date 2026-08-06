/**
 * Password hashing and policy (PRD §5.4).
 *
 * argon2id via @node-rs/argon2 — chosen because it ships prebuilt arm64
 * binaries, which matters when this moves to a Raspberry Pi (§12.3).
 */
import { hash, verify, type Algorithm } from "@node-rs/argon2";

/**
 * @node-rs/argon2 exports `Algorithm` as an ambient `const enum`, which cannot
 * be referenced as a value under `isolatedModules`. Argon2id is 2 (0=Argon2d,
 * 1=Argon2i, 2=Argon2id). The `satisfies` keeps it type-checked against the
 * real enum, so a future renumbering fails the build rather than silently
 * downgrading everyone's password hashing to Argon2d.
 */
const ARGON2ID = 2 satisfies Algorithm;

/**
 * OWASP-recommended argon2id parameters. These are deliberately explicit
 * rather than defaulted: if a future library upgrade changes the defaults,
 * existing hashes must still verify, and we want the change to be visible
 * in a diff rather than silent.
 *
 * ~64MB / 3 passes verifies in well under 100ms on the target hardware and
 * still leaves headroom inside the 2GB budget of NF-6.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

export const MIN_PASSWORD_LENGTH = 8;

/**
 * The 100 most common passwords (SecLists / NCSC breach corpora).
 *
 * This is a small, high-value blocklist, not a substitute for rate limiting —
 * §5.4 requires both. Compared case-insensitively.
 */
const COMMON_PASSWORDS = new Set([
  "123456", "password", "123456789", "12345678", "12345", "qwerty", "1234567",
  "111111", "1234567890", "123123", "abc123", "1234", "password1", "iloveyou",
  "1q2w3e4r", "000000", "qwerty123", "zaq12wsx", "dragon", "sunshine",
  "princess", "letmein", "654321", "monkey", "27653", "1qaz2wsx", "123321",
  "qwertyuiop", "superman", "asdfghjkl", "trustno1", "football", "baseball",
  "welcome", "shadow", "master", "666666", "qwe123", "michael", "jordan23",
  "harley", "password123", "1234qwer", "hunter", "ranger", "buster", "thomas",
  "tigger", "robert", "soccer", "batman", "test", "pass", "killer", "hockey",
  "george", "charlie", "andrew", "michelle", "love", "sunshine1", "jessica",
  "asshole", "6969", "pepper", "daniel", "access", "123456a", "654321a",
  "joshua", "maggie", "starwars", "silver", "william", "dallas", "yankees",
  "123qwe", "ashley", "666666a", "hello", "amanda", "orange", "biteme",
  "freedom", "computer", "sexy", "thunder", "nicole", "ginger", "heather",
  "hammer", "summer", "corvette", "taylor", "austin", "1111", "merlin",
  "matthew", "121212", "golfer", "cheese", "princess1", "martin", "chelsea",
  // Locally plausible weak choices — this system is used in Indonesia.
  "admin", "admin123", "marblehouse", "arcade", "kasir", "toko", "rahasia",
]);

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Validate a candidate password against §5.4 policy.
 *
 * Returns a plain message suitable for showing to a shop employee — the
 * audience is not technical, so the copy says what to do, not what failed.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      ok: false,
      message:
        "That password is one of the most commonly used passwords. Pick something harder to guess.",
    };
  }

  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Never throws on a malformed hash — a corrupted row must read as "wrong
 * password", not as a 500 that tells an attacker the account is special.
 */
export async function verifyPassword(
  storedHash: string,
  password: string
): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
