import { encodeIdentifierBytes32 } from "../abi/optimisticGovernor";

const DEFAULT_SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const DEFAULT_SAFE_PROXY_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";
const DEFAULT_SAFE_FALLBACK_HANDLER = "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";
const DEFAULT_OG_MASTER_COPY = "0x28CeBFE94a03DbCA9d17143e9d2Bd1155DC26D5d";

export type SafeOgAddresses = {
  safeSingleton: string;
  safeProxyFactory: string;
  safeFallbackHandler: string;
  ogMasterCopy: string;
};

export type OgDefaults = {
  identifier: `0x${string}`;
  rules: string;
};

export type SafeOgConfigOverrides = Partial<SafeOgAddresses> & Partial<OgDefaults>;

function readEnv(key: string): string | undefined {
  if (typeof process !== "undefined" && process?.env?.[key]) {
    return process.env[key];
  }

  if (typeof import.meta !== "undefined") {
    const metaEnv = (import.meta as { env?: Record<string, string> }).env;
    if (metaEnv?.[key]) {
      return metaEnv[key];
    }
  }

  return undefined;
}

function readEnvWithPrefixes(key: string): string | undefined {
  return (
    readEnv(key) ??
    readEnv(`VITE_${key}`) ??
    readEnv(`NEXT_PUBLIC_${key}`)
  );
}

export function getDefaultSafeOgAddresses(
  overrides: SafeOgConfigOverrides = {}
): SafeOgAddresses {
  return {
    safeSingleton:
      overrides.safeSingleton ??
      readEnvWithPrefixes("SAFE_SINGLETON") ??
      DEFAULT_SAFE_SINGLETON,
    safeProxyFactory:
      overrides.safeProxyFactory ??
      readEnvWithPrefixes("SAFE_PROXY_FACTORY") ??
      DEFAULT_SAFE_PROXY_FACTORY,
    safeFallbackHandler:
      overrides.safeFallbackHandler ??
      readEnvWithPrefixes("SAFE_FALLBACK_HANDLER") ??
      DEFAULT_SAFE_FALLBACK_HANDLER,
    ogMasterCopy:
      overrides.ogMasterCopy ??
      readEnvWithPrefixes("OG_MASTER_COPY") ??
      DEFAULT_OG_MASTER_COPY,
  };
}

export function getDefaultOgConfig(
  overrides: SafeOgConfigOverrides = {}
): OgDefaults {
  const identifierInput =
    overrides.identifier ?? readEnvWithPrefixes("OG_IDENTIFIER_STR") ?? "ASSERT_TRUTH2";

  return {
    identifier:
      typeof identifierInput === "string"
        ? encodeIdentifierBytes32(identifierInput)
        : identifierInput,
    rules: overrides.rules ?? readEnvWithPrefixes("OG_RULES") ?? "",
  };
}
