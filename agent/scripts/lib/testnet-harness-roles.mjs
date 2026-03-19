import { toHex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

const DEFAULT_HARNESS_MNEMONIC = 'test test test test test test test test test test test junk';

const HARNESS_ROLE_DEFINITIONS = Object.freeze([
    Object.freeze({ name: 'deployer', addressIndex: 0 }),
    Object.freeze({ name: 'agent', addressIndex: 1 }),
    Object.freeze({ name: 'depositor', addressIndex: 2 }),
]);

function deriveHarnessRole({ name, addressIndex }, mnemonic) {
    const account = mnemonicToAccount(mnemonic, { addressIndex });
    const hdKey = account.getHdKey();
    const privateKey = hdKey?.privateKey ? toHex(hdKey.privateKey) : undefined;

    return {
        name,
        addressIndex,
        derivationPath: `m/44'/60'/0'/0/${addressIndex}`,
        address: account.address,
        privateKey,
    };
}

function deriveHarnessRoles({
    mnemonic = DEFAULT_HARNESS_MNEMONIC,
    mnemonicSource = 'default-anvil',
} = {}) {
    const roles = {};
    for (const definition of HARNESS_ROLE_DEFINITIONS) {
        roles[definition.name] = deriveHarnessRole(definition, mnemonic);
    }

    return {
        mnemonicSource,
        roles,
    };
}

function normalizePrivateKey(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty hex private key.`);
    }
    const normalized = value.trim().startsWith('0x') ? value.trim() : `0x${value.trim()}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new Error(`${label} must be a 32-byte hex private key.`);
    }
    return normalized;
}

function deriveHarnessRolesFromEnv({
    env = process.env,
    roleEnvMap = {
        deployer: ['HARNESS_DEPLOYER_PRIVATE_KEY', 'DEPLOYER_PK'],
        agent: ['HARNESS_AGENT_PRIVATE_KEY', 'PRIVATE_KEY'],
        depositor: ['HARNESS_DEPOSITOR_PRIVATE_KEY', 'MESSAGE_API_SIGNER_PRIVATE_KEY'],
    },
} = {}) {
    const roles = {};
    for (const definition of HARNESS_ROLE_DEFINITIONS) {
        const candidates = roleEnvMap[definition.name] ?? [];
        const sourceEnv = candidates.find((key) => typeof env?.[key] === 'string' && env[key].trim());
        if (!sourceEnv) {
            throw new Error(
                `Missing remote harness key for role "${definition.name}". Set one of: ${candidates.join(', ')}.`
            );
        }
        const privateKey = normalizePrivateKey(env[sourceEnv], sourceEnv);
        const account = privateKeyToAccount(privateKey);
        roles[definition.name] = {
            name: definition.name,
            addressIndex: definition.addressIndex,
            derivationPath: null,
            address: account.address,
            privateKey,
            sourceEnv,
        };
    }

    return {
        mnemonicSource: 'env',
        roles,
    };
}

function resolveHarnessRoles({
    profile,
    env = process.env,
} = {}) {
    if (profile?.mode === 'remote') {
        return deriveHarnessRolesFromEnv({ env });
    }
    return deriveHarnessRoles();
}

export {
    DEFAULT_HARNESS_MNEMONIC,
    HARNESS_ROLE_DEFINITIONS,
    deriveHarnessRoles,
    deriveHarnessRolesFromEnv,
    resolveHarnessRoles,
};
