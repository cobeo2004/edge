import { jwtVerify, createRemoteJWKSet, type JWTVerifyResult, type KeyLike } from "jose";
import type { AuthResult, AuthStrategy } from "./types.js";

export interface JWTStrategyOptions {
  /** HMAC shared secret (string) */
  secret?: string;
  /** Crypto key (RSA, EC, etc.) for direct verification */
  key?: KeyLike | Uint8Array;
  /** JWKS endpoint URL for remote key fetching */
  jwksEndpoint?: string;
  /** Expected algorithms (if not set, inferred by jose) */
  algorithms?: string[];
  /** Expected issuer (validates `iss` claim) */
  issuer?: string;
  /** Expected audience (validates `aud` claim) */
  audience?: string | string[];
  /** Clock tolerance in seconds (default: 0) */
  clockTolerance?: number;
  /** Where to find the token. Default: "header" */
  tokenLocation?: "header" | "cookie" | "query";
  /** Header name, cookie name, or query param name. Default: "authorization" for header */
  tokenKey?: string;
}

export class JWTStrategy implements AuthStrategy {
  #options: JWTStrategyOptions;
  #jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(options: JWTStrategyOptions) {
    if (!options.secret && !options.key && !options.jwksEndpoint) {
      throw new Error(
        "JWTStrategy requires at least one of: secret, key, or jwksEndpoint"
      );
    }
    this.#options = options;
    if (options.jwksEndpoint) {
      this.#jwks = createRemoteJWKSet(new URL(options.jwksEndpoint));
    }
  }

  async extractCredentials(request: Request): Promise<string | null> {
    const location = this.#options.tokenLocation ?? "header";

    if (location === "header") {
      const headerName = this.#options.tokenKey ?? "authorization";
      const value = request.headers.get(headerName);
      if (!value) return null;
      const match = value.match(/^Bearer\s+(.+)$/i);
      return match ? match[1] : null;
    }

    if (location === "query") {
      const key = this.#options.tokenKey ?? "token";
      const url = new URL(request.url);
      return url.searchParams.get(key);
    }

    if (location === "cookie") {
      const key = this.#options.tokenKey ?? "token";
      const cookieHeader = request.headers.get("cookie");
      if (!cookieHeader) return null;
      const cookies = cookieHeader.split(";").map((c) => c.trim());
      for (const cookie of cookies) {
        const [name, ...rest] = cookie.split("=");
        if (name.trim() === key) {
          return rest.join("=").trim();
        }
      }
      return null;
    }

    return null;
  }

  async verify(credentials: string): Promise<AuthResult> {
    try {
      const keyOrJwks = this.#resolveKey();
      const options: Parameters<typeof jwtVerify>[2] = {};

      if (this.#options.algorithms) {
        options.algorithms = this.#options.algorithms;
      }
      if (this.#options.issuer) {
        options.issuer = this.#options.issuer;
      }
      if (this.#options.audience) {
        options.audience = this.#options.audience;
      }
      if (this.#options.clockTolerance !== undefined) {
        options.clockTolerance = this.#options.clockTolerance;
      }

      const result: JWTVerifyResult = await jwtVerify(
        credentials,
        keyOrJwks,
        options
      );

      return {
        valid: true,
        claims: result.payload as Record<string, unknown>,
      };
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Verification failed",
      };
    }
  }

  #resolveKey(): KeyLike | Uint8Array | ReturnType<typeof createRemoteJWKSet> {
    if (this.#jwks) return this.#jwks;
    if (this.#options.key) return this.#options.key;
    if (this.#options.secret) {
      return new TextEncoder().encode(this.#options.secret);
    }
    throw new Error("No key configured");
  }
}
