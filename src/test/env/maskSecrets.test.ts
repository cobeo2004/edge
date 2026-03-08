import { describe, expect, it } from "vitest";
import { createSecretMasker } from "../../env/maskSecrets.js";

describe("createSecretMasker", () => {
  it("masks a single secret", () => {
    const mask = createSecretMasker(["my_secret_value"]);
    expect(mask("The secret is my_secret_value here")).toBe(
      "The secret is *** here"
    );
  });

  it("masks multiple secrets", () => {
    const mask = createSecretMasker(["alpha", "beta"]);
    expect(mask("alpha and beta")).toBe("*** and ***");
  });

  it("ignores values shorter than 3 characters", () => {
    const mask = createSecretMasker(["ab", "x"]);
    expect(mask("ab and x remain")).toBe("ab and x remain");
  });

  it("returns identity function when no secrets", () => {
    const mask = createSecretMasker([]);
    const msg = "nothing to mask";
    expect(mask(msg)).toBe(msg);
  });

  it("handles regex special characters in secrets", () => {
    const mask = createSecretMasker(["foo.bar", "a+b"]);
    expect(mask("foo.bar and a+b")).toBe("*** and ***");
    // Should not match fooXbar
    expect(mask("fooXbar")).toBe("fooXbar");
  });

  it("masks all occurrences", () => {
    const mask = createSecretMasker(["secret"]);
    expect(mask("secret and secret again")).toBe("*** and *** again");
  });
});
