import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Argon2id with parameters from the OWASP cheat sheet: 19 MiB of memory, two
 * iterations, one lane. Memory cost is what makes GPU cracking expensive, which
 * is the attack that matters when a hash dump leaks.
 */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A hash of a throwaway value, used to spend the same work on a login for an
 * account that does not exist as on one that does. Without it, response time
 * tells an attacker which email addresses are registered.
 */
let decoyHash: string | undefined;

export const passwordService = {
  async hash(plain: string): Promise<string> {
    if (plain.length < 12) throw new Error('Password must be at least 12 characters.');
    return hash(plain, OPTIONS);
  },

  async verify(storedHash: string | null, plain: string): Promise<boolean> {
    if (storedHash === null) {
      // Equalise timing against an unknown account, then fail.
      decoyHash ??= await hash('decoy-value-never-used-for-login', OPTIONS);
      await verify(decoyHash, plain).catch(() => false);
      return false;
    }
    try {
      return await verify(storedHash, plain);
    } catch {
      // A malformed stored hash is a failed login, never a 500 that reveals
      // something about the account.
      return false;
    }
  },
};
