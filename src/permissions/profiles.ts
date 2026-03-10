export const BUILT_IN_PROFILES: Record<string, string[]> = {
  none: [],
  strict: ["--allow-net"],
  standard: ["--allow-net", "--allow-env", "--allow-read"],
  permissive: ["--allow-all"],
};

export interface ResolveOptions {
  /** Default profile when none specified */
  defaultProfile?: string;
  /** Custom named profiles (merged with / can shadow built-ins) */
  customProfiles?: Record<string, string[]>;
}

/**
 * Resolve a permission value (profile name, raw flags, or undefined) into
 * a concrete array of Deno run flags.
 */
export function resolvePermissionFlags(
  value: string | string[] | undefined,
  options: ResolveOptions
): string[] {
  // Raw flags array — pass through
  if (Array.isArray(value)) {
    return value;
  }

  const profileName = value ?? options.defaultProfile ?? "standard";
  const allProfiles = { ...BUILT_IN_PROFILES, ...options.customProfiles };
  const flags = allProfiles[profileName];

  if (!flags) {
    throw new Error(`Unknown permission profile: "${profileName}"`);
  }

  return [...flags];
}
