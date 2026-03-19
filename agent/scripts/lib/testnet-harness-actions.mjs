import { createPublicClient, createTestClient, createWalletClient, erc20Abi, getAddress, http, parseAbi, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSignedMessagePayload } from '../../src/lib/message-signing.js';
import { makeDeposit, makeTransfer } from '../../src/lib/tx.js';
import { resolveMessageApiTarget } from '../send-signed-message.mjs';

const mintableErc20Abi = parseAbi([
    'function mint(address to, uint256 amount)',
]);

function normalizeRoleName(roleName) {
    return typeof roleName === 'string' && roleName.trim() ? roleName.trim() : 'depositor';
}

function loadRoleRecord(rolesData, roleName) {
    const normalizedRoleName = normalizeRoleName(roleName);
    const record = rolesData?.roles?.[normalizedRoleName];
    if (!record?.privateKey) {
        throw new Error(`Harness role "${normalizedRoleName}" is unavailable. Run the harness "up" command first.`);
    }
    return record;
}

function createHarnessClients({ rpcUrl, chainId, rolesData }) {
    const publicClient = createPublicClient({
        transport: http(rpcUrl, {
            retryCount: 0,
        }),
    });
    const testClient = createTestClient({
        mode: 'anvil',
        transport: http(rpcUrl, {
            retryCount: 0,
        }),
    });

    const walletClients = {};
    for (const [roleName, roleRecord] of Object.entries(rolesData?.roles ?? {})) {
        if (!roleRecord?.privateKey) {
            continue;
        }
        const account = privateKeyToAccount(roleRecord.privateKey);
        walletClients[roleName] = {
            account,
            walletClient: createWalletClient({
                account,
                transport: http(rpcUrl, {
                    retryCount: 0,
                }),
            }),
        };
    }

    return {
        publicClient,
        testClient,
        walletClients,
        chainId,
    };
}

async function mintHarnessErc20({
    walletClient,
    account,
    token,
    recipient,
    amountWei,
    publicClient,
}) {
    const hash = await walletClient.writeContract({
        address: getAddress(token),
        abi: mintableErc20Abi,
        functionName: 'mint',
        args: [getAddress(recipient), BigInt(amountWei)],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return {
        transactionHash: hash,
        receipt,
        mode: 'mint',
    };
}

async function seedHarnessErc20FromHolder({
    publicClient,
    testClient,
    rpcUrl,
    token,
    holder,
    recipient,
    amountWei,
}) {
    const normalizedHolder = getAddress(holder);
    const normalizedRecipient = getAddress(recipient);
    const normalizedToken = getAddress(token);
    const normalizedAmount = BigInt(amountWei);

    await testClient.setBalance({
        address: normalizedHolder,
        value: 10n ** 18n,
    });
    await testClient.impersonateAccount({
        address: normalizedHolder,
    });

    try {
        const walletClient = createWalletClient({
            account: normalizedHolder,
            transport: http(rpcUrl, {
                retryCount: 0,
            }),
        });
        const hash = await walletClient.writeContract({
            address: normalizedToken,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [normalizedRecipient, normalizedAmount],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return {
            transactionHash: hash,
            receipt,
            mode: 'impersonated-transfer',
        };
    } finally {
        await testClient.stopImpersonatingAccount?.({
            address: normalizedHolder,
        });
    }
}

async function sendHarnessDeposit({
    runtimeConfig,
    roleName = 'depositor',
    asset,
    amountWei,
    harnessClients,
}) {
    const entry = harnessClients.walletClients[normalizeRoleName(roleName)];
    if (!entry) {
        throw new Error(`Missing wallet client for role "${roleName}".`);
    }

    const hash =
        asset === undefined || asset === null
            ? await makeDeposit({
                  walletClient: entry.walletClient,
                  account: entry.account,
                  config: runtimeConfig,
              })
            : await makeTransfer({
                  walletClient: entry.walletClient,
                  account: entry.account,
                  asset,
                  amountWei: BigInt(amountWei),
                  recipient: runtimeConfig.commitmentSafe,
              });
    const receipt = await harnessClients.publicClient.waitForTransactionReceipt({ hash });
    return {
        role: normalizeRoleName(roleName),
        asset: asset ?? runtimeConfig.defaultDepositAsset,
        amountWei:
            amountWei !== undefined
                ? BigInt(amountWei).toString()
                : runtimeConfig.defaultDepositAmountWei?.toString(),
        transactionHash: hash,
        blockNumber: receipt.blockNumber.toString(),
    };
}

async function sendHarnessSignedMessage({
    repoRootPath,
    agentRef,
    profile,
    overlayPath,
    role,
    text,
    requestId,
    command,
    args,
    metadata,
    deadline,
    timeoutMs = 10_000,
    bearerToken,
    dryRun = false,
}) {
    const account = privateKeyToAccount(role.privateKey);
    const timestampMs = Date.now();
    const { baseUrl, chainId } = await resolveMessageApiTarget({
        argv: [
            'node',
            'send-signed-message.mjs',
            `--module=${agentRef}`,
            `--chain-id=${profile.chainId}`,
        ],
        env: {
            ...process.env,
            ...(overlayPath ? { AGENT_CONFIG_OVERLAY_PATH: overlayPath } : {}),
        },
        repoRootPath,
    });

    const normalizedRequestId = requestId ?? `harness-${Date.now()}`;
    const payload = buildSignedMessagePayload({
        address: account.address,
        chainId,
        timestampMs,
        text,
        command,
        args,
        metadata,
        requestId: normalizedRequestId,
        deadline,
    });
    const signature = await account.signMessage({ message: payload });
    const body = {
        text,
        ...(chainId !== undefined ? { chainId } : {}),
        requestId: normalizedRequestId,
        auth: {
            type: 'eip191',
            address: account.address,
            timestampMs,
            signature,
        },
    };
    if (command !== undefined) body.command = command;
    if (args !== undefined) body.args = args;
    if (metadata !== undefined) body.metadata = metadata;
    if (deadline !== undefined) body.deadline = deadline;

    if (dryRun) {
        return {
            endpoint: `${baseUrl}/v1/messages`,
            signer: account.address,
            requestId: normalizedRequestId,
            body,
        };
    }

    const endpoint = `${baseUrl}/v1/messages`;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (bearerToken) {
            headers.Authorization = bearerToken.startsWith('Bearer ')
                ? bearerToken
                : `Bearer ${bearerToken}`;
        }
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: abortController.signal,
        });
        const raw = await response.text();
        let parsedResponse;
        try {
            parsedResponse = raw ? JSON.parse(raw) : {};
        } catch (error) {
            parsedResponse = { raw };
        }
        return {
            endpoint,
            signer: account.address,
            requestId: normalizedRequestId,
            status: response.status,
            ok: response.ok,
            response: parsedResponse,
        };
    } finally {
        clearTimeout(timer);
    }
}

function parseHarnessAsset(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    const normalized = String(value).trim().toLowerCase();
    if (!normalized || normalized === 'default') {
        return undefined;
    }
    if (normalized === 'native' || normalized === 'eth') {
        return zeroAddress;
    }
    return getAddress(String(value).trim());
}

export {
    createHarnessClients,
    loadRoleRecord,
    mintHarnessErc20,
    normalizeRoleName,
    parseHarnessAsset,
    seedHarnessErc20FromHolder,
    sendHarnessDeposit,
    sendHarnessSignedMessage,
};
