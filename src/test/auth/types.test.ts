import { describe, expect, it } from "vitest";
import type { AuthResult, AuthStrategy } from "../../auth/types.js";

describe("Auth types", () => {
  it("AuthStrategy interface is implementable", () => {
    const strategy: AuthStrategy = {
      async extractCredentials(_request: Request) {
        return "test-token";
      },
      async verify(_credentials: string) {
        return { valid: true, claims: { sub: "user-1" } };
      },
    };
    expect(strategy).toBeDefined();
  });

  it("AuthResult supports error field", () => {
    const result: AuthResult = {
      valid: false,
      error: "Token expired",
    };
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token expired");
  });
});
