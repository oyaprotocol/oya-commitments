import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';
import { createWalletClient, getAddress, http } from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';
import { mustGetEnv, normalizePrivateKey } from './utils.js';

const execFileAsync = promisify(execFile);

async function loadPrivateKeyFromKeystore() {
    const keystorePath = mustGetEnv('KEYSTORE_PATH');
    const keystorePassword = mustGetEnv('KEYSTORE_PASSWORD');
    const keystoreJson = await readFile(keystorePath, 'utf8');
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, keystorePassword);
    return wallet.privateKey;
}

async function loadPrivateKeyFromKeychain() {
    const service = mustGetEnv('KEYCHAIN_SERVICE');
    const account = mustGetEnv('KEYCHAIN_ACCOUNT');

    if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('security', [
            'find-generic-password',
            '-s',
            service,
            '-a',
            account,
            '-w',
        ]);
        return stdout.trim();
    }

    if (process.platform === 'linux') {
        const { stdout } = await execFileAsync('secret-tool', [
            'lookup',
            'service',
            service,
            'account',
            account,
        ]);
        return stdout.trim();
    }

    throw new Error('Keychain lookup not supported on this platform.');
}

async function loadPrivateKeyFromVault() {
    const vaultAddr = mustGetEnv('VAULT_ADDR').replace(/\/+$/, '');
    const vaultToken = mustGetEnv('VAULT_TOKEN');
    const vaultPath = mustGetEnv('VAULT_SECRET_PATH').replace(/^\/+/, '');
    const vaultNamespace = process.env.VAULT_NAMESPACE;
    const vaultKeyField = process.env.VAULT_SECRET_KEY ?? 'private_key';

    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
        headers: {
            'X-Vault-Token': vaultToken,
            ...(vaultNamespace ? { 'X-Vault-Namespace': vaultNamespace } : {}),
        },
    });

    if (!response.ok) {
        throw new Error(`Vault request failed (${response.status}).`);
    }

    const payload = await response.json();
    const data = payload?.data?.data ?? payload?.data ?? {};
    const value = data[vaultKeyField];
    if (!value) {
        throw new Error(`Vault secret missing key '${vaultKeyField}'.`);
    }

    return value;
}

async function createSignerClient({ rpcUrl }) {
    const signerType = (process.env.SIGNER_TYPE ?? 'env').toLowerCase();

    if (signerType === 'env') {
        const privateKey = normalizePrivateKey(mustGetEnv('PRIVATE_KEY'));
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(rpcUrl) }),
        };
    }

    if (signerType === 'keystore') {
        const privateKey = normalizePrivateKey(await loadPrivateKeyFromKeystore());
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(rpcUrl) }),
        };
    }

    if (signerType === 'keychain') {
        const privateKey = normalizePrivateKey(await loadPrivateKeyFromKeychain());
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(rpcUrl) }),
        };
    }

    if (signerType === 'vault') {
        const privateKey = normalizePrivateKey(await loadPrivateKeyFromVault());
        const account = privateKeyToAccount(privateKey);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(rpcUrl) }),
        };
    }

    if (['kms', 'vault-signer', 'signer-rpc', 'rpc', 'json-rpc'].includes(signerType)) {
        const signerRpcUrl = mustGetEnv('SIGNER_RPC_URL');
        const signerAddress = getAddress(mustGetEnv('SIGNER_ADDRESS'));
        const account = toAccount(signerAddress);
        return {
            account,
            walletClient: createWalletClient({ account, transport: http(signerRpcUrl) }),
        };
    }

    throw new Error(`Unsupported SIGNER_TYPE '${signerType}'.`);
}

export { createSignerClient };
