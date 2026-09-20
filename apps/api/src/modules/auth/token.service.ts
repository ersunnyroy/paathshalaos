import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { loadEnv } from '../../config/env.ts';

const env = loadEnv();
const key = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'paathshala.os';
const AUDIENCE = 'paathshala.api';

export interface AccessTokenClaims {
  sub: string;
  /**
   * Absent on a platform console token, and only on that.
   *
   * A platform administrator holds no role in any school, so there is no tenant
   * to put here. The auth guard refuses a token without one, which is what stops
   * a console token being pointed at the school API — see the check there.
   */
  tenant_id?: string;
  session_id: string;
  /** The user's grants_version at mint time. See verifyAccessToken's caller. */
  gv: number;
  roles: string[];
  imp?: string;
  write?: boolean;
}

export const tokenService = {
  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ ...claims } as unknown as JWTPayload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(key);
  },

  /**
   * Returns our claims AND the registered ones jose put there.
   *
   * The earlier signature said `Promise<AccessTokenClaims>`, which was a lie the
   * cast concealed: `exp`, `iat`, `iss` and `aud` are all present at runtime and
   * invisible to the typechecker, so a test reading `claims.exp` was writing
   * against a type that denied it existed. Saying so is free and makes the
   * expiry checkable by anything that needs it.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims & JWTPayload> {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE });
    return payload as unknown as AccessTokenClaims & JWTPayload;
  },

  /**
   * Refresh tokens are opaque random bytes, not JWTs. A JWT refresh token cannot
   * be revoked without a server-side lookup anyway, so the JWT buys nothing and
   * costs the ability to keep the secret out of the database.
   */
  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashRefreshToken(token) };
  },
};

/**
 * SHA-256 rather than Argon2: the token is 256 bits of entropy we generated, so
 * there is nothing to brute-force and no reason to pay a slow hash on every
 * refresh. Argon2 protects low-entropy human passwords; this is not one.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
