import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROFILES,
  resolvePermissionFlags,
} from "../../permissions/profiles.js";

describe("Permission profiles", () => {
  describe("BUILT_IN_PROFILES", () => {
    it("has none, strict, standard, permissive", () => {
      expect(BUILT_IN_PROFILES.none).toEqual([]);
      expect(BUILT_IN_PROFILES.strict).toEqual(["--allow-net"]);
      expect(BUILT_IN_PROFILES.standard).toEqual([
        "--allow-net",
        "--allow-env",
      ]);
      expect(BUILT_IN_PROFILES.permissive).toEqual(["--allow-all"]);
    });
  });

  describe("resolvePermissionFlags", () => {
    it("resolves a built-in profile name to flags", () => {
      const flags = resolvePermissionFlags("strict", {});
      expect(flags).toEqual(["--allow-net"]);
    });

    it("resolves custom profile name from customProfiles", () => {
      const flags = resolvePermissionFlags("my-api", {
        customProfiles: { "my-api": ["--allow-net=api.example.com"] },
      });
      expect(flags).toEqual(["--allow-net=api.example.com"]);
    });

    it("custom profile shadows built-in", () => {
      const flags = resolvePermissionFlags("strict", {
        customProfiles: { strict: ["--allow-net", "--allow-read=/tmp"] },
      });
      expect(flags).toEqual(["--allow-net", "--allow-read=/tmp"]);
    });

    it("returns raw flags array as-is", () => {
      const flags = resolvePermissionFlags(["--allow-net", "--allow-ffi"], {});
      expect(flags).toEqual(["--allow-net", "--allow-ffi"]);
    });

    it("defaults to standard when no profile specified", () => {
      const flags = resolvePermissionFlags(undefined, {});
      expect(flags).toEqual(["--allow-net", "--allow-env"]);
    });

    it("uses defaultProfile when no per-function override", () => {
      const flags = resolvePermissionFlags(undefined, {
        defaultProfile: "strict",
      });
      expect(flags).toEqual(["--allow-net"]);
    });

    it("throws on unknown profile name", () => {
      expect(() => resolvePermissionFlags("nonexistent", {})).toThrow(
        'Unknown permission profile: "nonexistent"'
      );
    });
  });
});
