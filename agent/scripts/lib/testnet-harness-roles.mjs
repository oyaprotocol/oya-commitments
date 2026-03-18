import { toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

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

export {
    DEFAULT_HARNESS_MNEMONIC,
    HARNESS_ROLE_DEFINITIONS,
    deriveHarnessRoles,
};
