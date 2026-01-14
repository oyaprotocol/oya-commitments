const MAX_BYTES32_BYTES = 32;

export const OPTIMISTIC_GOVERNOR_ABI = [
  {
    type: "function",
    name: "setUp",
    inputs: [{ name: "initializer", type: "bytes" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export type OgInitParams = {
  owner: string;
  collateral: string;
  bondAmount: bigint;
  rules: string;
  identifier: string;
  liveness: bigint;
};

export type OgInitParamsEncoded = Omit<OgInitParams, "identifier"> & {
  identifier: `0x${string}`;
};

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function encodeIdentifierBytes32(identifier: string): `0x${string}` {
  const bytes = textEncoder.encode(identifier);
  if (bytes.length > MAX_BYTES32_BYTES) {
    throw new Error(
      `Identifier string is too long for bytes32 (max ${MAX_BYTES32_BYTES} bytes).`
    );
  }

  const padded = new Uint8Array(MAX_BYTES32_BYTES);
  padded.set(bytes);

  return `0x${bytesToHex(padded)}`;
}

export function encodeOgInitParams(params: OgInitParams): OgInitParamsEncoded {
  return {
    ...params,
    identifier: encodeIdentifierBytes32(params.identifier),
  };
}
