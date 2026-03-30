import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createPublicClient, getAddress, http } from 'viem';
import { buildHarnessRuntimeEnv } from './testnet-harness-context.mjs';
import { resolveHarnessRuntimeContext } from './testnet-harness-runtime.mjs';
import { readHarnessJson, writeHarnessJson } from './testnet-harness-session.mjs';

const DEPLOY_SCRIPT_BASENAME = 'DeploySafeWithOptimisticGovernor.s.sol';
const MOCK_DEPLOY_SCRIPT_BASENAME = 'DeployHarnessMockCommitmentDeps.s.sol';

function resolveForgeExecutable(env = process.env) {
    const candidate = typeof env?.FORGE_BIN === 'string' ? env.FORGE_BIN.trim() : '';
    return candidate || 'forge';
}

function normalizeUintEnv(value, label) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    try {
        return BigInt(value).toString();
    } catch (error) {
        throw new Error(`${label} must be an integer.`);
    }
}

function normalizeAddressOrUndefined(value, label) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    try {
        return getAddress(value);
    } catch (error) {
        throw new Error(`${label} must be a valid address.`);
    }
}

function parseOwnersConfig(value, label) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (value === '0x') {
        return '0x';
    }

    let rawOwners;
    if (Array.isArray(value)) {
        if (value.length === 0) {
            throw new Error(`${label} must contain at least one owner. Omit it for deployer-only ownership or use "0x" to burn ownership.`);
        }
        rawOwners = value;
    } else if (typeof value === 'string') {
        if (!value.trim()) {
            throw new Error(`${label} must not be empty. Omit it for deployer-only ownership or use "0x" to burn ownership.`);
        }
        rawOwners = value.split(',');
    } else {
        rawOwners = null;
    }
    if (!rawOwners) {
        throw new Error(`${label} must be "0x", an address string, a comma-separated string, or an array.`);
    }

    const owners = rawOwners.map((item, index) =>
        normalizeAddressOrUndefined(
            typeof item === 'string' ? item.trim() : item,
            `${label}[${index}]`
        )
    );

    if (owners.some((owner) => owner === undefined)) {
        throw new Error(`${label} entries must be non-empty addresses.`);
    }

    return owners.join(',');
}

function parseDeploymentConfig(runtimeContext) {
    const raw = runtimeContext.runtimeConfig.agentConfig?.harness?.deployment;
    if (raw === undefined || raw === null) {
        return {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('config.agentConfig.harness.deployment must be an object.');
    }

    return {
        safeSingleton: normalizeAddressOrUndefined(raw.safeSingleton, 'harness.deployment.safeSingleton'),
        safeProxyFactory: normalizeAddressOrUndefined(
            raw.safeProxyFactory,
            'harness.deployment.safeProxyFactory'
        ),
        safeFallbackHandler: normalizeAddressOrUndefined(
            raw.safeFallbackHandler,
            'harness.deployment.safeFallbackHandler'
        ),
        ogMasterCopy: normalizeAddressOrUndefined(raw.ogMasterCopy, 'harness.deployment.ogMasterCopy'),
        moduleProxyFactory: normalizeAddressOrUndefined(
            raw.moduleProxyFactory,
            'harness.deployment.moduleProxyFactory'
        ),
        collateral: normalizeAddressOrUndefined(
            raw.collateral ?? raw.collateralToken,
            'harness.deployment.collateral'
        ),
        bondAmount: normalizeUintEnv(raw.bondAmount, 'harness.deployment.bondAmount'),
        liveness: normalizeUintEnv(raw.liveness, 'harness.deployment.liveness'),
        identifier: typeof raw.identifier === 'string' && raw.identifier.trim() ? raw.identifier.trim() : undefined,
        owners: parseOwnersConfig(raw.owners, 'harness.deployment.owners'),
        safeSaltNonce: normalizeUintEnv(raw.safeSaltNonce, 'harness.deployment.safeSaltNonce'),
        ogSaltNonce: normalizeUintEnv(raw.ogSaltNonce, 'harness.deployment.ogSaltNonce'),
    };
}

function broadcastPathForScript(repoRootPath, scriptBasename, chainId) {
    return path.join(repoRootPath, 'broadcast', scriptBasename, String(chainId), 'run-latest.json');
}

async function readBroadcastJson(broadcastPath) {
    const raw = await readFile(broadcastPath, 'utf8');
    return JSON.parse(raw);
}

function buildForgeScriptCommand({ scriptBasename, contractName, rpcUrl, env }) {
    return {
        command: resolveForgeExecutable(env),
        args: [
            'script',
            `script/${scriptBasename}:${contractName}`,
            '--rpc-url',
            rpcUrl,
            '--broadcast',
        ],
    };
}

async function runForgeScript({
    repoRootPath,
    scriptBasename,
    contractName,
    rpcUrl,
    env,
}) {
    const { command, args } = buildForgeScriptCommand({
        scriptBasename,
        contractName,
        rpcUrl,
        env,
    });

    const result = await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: repoRootPath,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            resolve({
                code,
                signal,
                stdout,
                stderr,
                command,
                args,
            });
        });
    });

    if (result.code !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`
        );
    }

    return result;
}

function parseReturnedAddress(returnsObject, key) {
    const candidate = returnsObject?.[key]?.value;
    if (!candidate) {
        throw new Error(`Broadcast JSON missing return value "${key}".`);
    }
    return getAddress(candidate);
}

function summarizeBroadcast({
    broadcast,
    returnsObject,
    chainId,
}) {
    const txHashes = Array.isArray(broadcast.transactions)
        ? broadcast.transactions.map((item) => item?.hash).filter(Boolean)
        : [];
    const receiptBlockNumbers = Array.isArray(broadcast.receipts)
        ? broadcast.receipts
              .map((item) => item?.blockNumber)
              .filter(Boolean)
              .map((value) => BigInt(value))
        : [];
    const startBlock =
        receiptBlockNumbers.length > 0
            ? receiptBlockNumbers.reduce((min, value) => (value < min ? value : min), receiptBlockNumbers[0])
            : undefined;

    return {
        chainId,
        startBlock: startBlock?.toString(),
        txHashes,
        returnsObject,
    };
}

async function deployMockDependencies({
    repoRootPath,
    rpcUrl,
    chainId,
    deployerPrivateKey,
    env = process.env,
}) {
    await runForgeScript({
        repoRootPath,
        scriptBasename: MOCK_DEPLOY_SCRIPT_BASENAME,
        contractName: 'DeployHarnessMockCommitmentDeps',
        rpcUrl,
        env: {
            ...env,
            DEPLOYER_PK: deployerPrivateKey,
        },
    });

    const broadcast = await readBroadcastJson(
        broadcastPathForScript(repoRootPath, MOCK_DEPLOY_SCRIPT_BASENAME, chainId)
    );
    const returnsObject = broadcast.returns ?? {};

    return {
        ...summarizeBroadcast({ broadcast, returnsObject, chainId }),
        safeSingleton: parseReturnedAddress(returnsObject, 'safeSingleton'),
        safeProxyFactory: parseReturnedAddress(returnsObject, 'safeProxyFactory'),
        safeFallbackHandler: parseReturnedAddress(returnsObject, 'safeFallbackHandler'),
        ogMasterCopy: parseReturnedAddress(returnsObject, 'ogMasterCopy'),
        collateralToken: parseReturnedAddress(returnsObject, 'collateralToken'),
    };
}

async function commitmentDeploymentExists({ rpcUrl, commitmentSafe, ogModule }) {
    if (!commitmentSafe || !ogModule) {
        return false;
    }
    const publicClient = createPublicClient({
        transport: http(rpcUrl, {
            retryCount: 0,
        }),
    });
    const [safeCode, ogCode] = await Promise.all([
        publicClient.getCode({ address: getAddress(commitmentSafe) }),
        publicClient.getCode({ address: getAddress(ogModule) }),
    ]);
    return Boolean(safeCode && safeCode !== '0x' && ogCode && ogCode !== '0x');
}

function mergeByChainOverlay({
    existingOverlay,
    chainId,
    fields,
}) {
    const nextOverlay = existingOverlay && typeof existingOverlay === 'object' && !Array.isArray(existingOverlay)
        ? structuredClone(existingOverlay)
        : {};
    const byChain = nextOverlay.byChain && typeof nextOverlay.byChain === 'object' && !Array.isArray(nextOverlay.byChain)
        ? nextOverlay.byChain
        : {};
    const chainKey = String(chainId);
    const chainOverlay =
        byChain[chainKey] && typeof byChain[chainKey] === 'object' && !Array.isArray(byChain[chainKey])
            ? byChain[chainKey]
            : {};
    byChain[chainKey] = {
        ...chainOverlay,
        ...fields,
    };
    nextOverlay.byChain = byChain;
    return nextOverlay;
}

async function deployHarnessCommitment({
    repoRootPath,
    agentRef,
    profileName,
    sessionPaths,
    rpcUrl,
    deployerPrivateKey,
    force = false,
    env = process.env,
}) {
    const runtimeContext = await resolveHarnessRuntimeContext({
        repoRootPath,
        agentRef,
        profileName,
        overlayPath: sessionPaths.files.overlay,
        env: buildHarnessRuntimeEnv({
            env,
            rpcUrl,
        }),
    });
    const deploymentConfig = parseDeploymentConfig(runtimeContext);
    if (!runtimeContext.commitmentText) {
        throw new Error(`Missing commitment text for module "${agentRef}".`);
    }

    if (
        !force &&
        (await commitmentDeploymentExists({
            rpcUrl,
            commitmentSafe: runtimeContext.runtimeConfig.commitmentSafe,
            ogModule: runtimeContext.runtimeConfig.ogModule,
        }))
    ) {
        const existingDeployment = await readHarnessJson(sessionPaths.files.deployment);
        const deployment =
            existingDeployment ?? {
                chainId: runtimeContext.profile.chainId,
                commitmentSafe: runtimeContext.runtimeConfig.commitmentSafe,
                ogModule: runtimeContext.runtimeConfig.ogModule,
            };
        if (existingDeployment === null) {
            await writeHarnessJson(sessionPaths.files.deployment, deployment);
        }
        return {
            reused: true,
            deployment,
        };
    }

    let mockDependencies = null;
    let effectiveConfig = {
        ...deploymentConfig,
    };

    if (runtimeContext.profile.name === 'local-mock') {
        if (!effectiveConfig.bondAmount) {
            effectiveConfig = {
                ...effectiveConfig,
                bondAmount: '1',
            };
        }
        const missingLocalDeps = [
            !effectiveConfig.safeSingleton,
            !effectiveConfig.safeProxyFactory,
            !effectiveConfig.safeFallbackHandler,
            !effectiveConfig.ogMasterCopy,
            !effectiveConfig.collateral,
        ].some(Boolean);

        if (missingLocalDeps) {
            mockDependencies = await deployMockDependencies({
                repoRootPath,
                rpcUrl,
                chainId: runtimeContext.profile.chainId,
                deployerPrivateKey,
                env,
            });
            effectiveConfig = {
                ...effectiveConfig,
                safeSingleton: effectiveConfig.safeSingleton ?? mockDependencies.safeSingleton,
                safeProxyFactory: effectiveConfig.safeProxyFactory ?? mockDependencies.safeProxyFactory,
                safeFallbackHandler:
                    effectiveConfig.safeFallbackHandler ?? mockDependencies.safeFallbackHandler,
                ogMasterCopy: effectiveConfig.ogMasterCopy ?? mockDependencies.ogMasterCopy,
                collateral: effectiveConfig.collateral ?? mockDependencies.collateralToken,
            };
        }
    }

    if (!effectiveConfig.collateral) {
        throw new Error(
            `Missing harness deployment collateral for profile "${profileName}". Set config.agentConfig.harness.deployment.collateral in the module config.`
        );
    }
    if (!effectiveConfig.bondAmount) {
        throw new Error(
            `Missing harness deployment bondAmount for profile "${profileName}". Set config.agentConfig.harness.deployment.bondAmount in the module config.`
        );
    }

    const forgeEnv = {
        ...env,
        DEPLOYER_PK: deployerPrivateKey,
        OG_COLLATERAL: effectiveConfig.collateral,
        OG_BOND_AMOUNT: effectiveConfig.bondAmount,
        OG_RULES: runtimeContext.commitmentText,
        ...(effectiveConfig.safeSingleton ? { SAFE_SINGLETON: effectiveConfig.safeSingleton } : {}),
        ...(effectiveConfig.safeProxyFactory
            ? { SAFE_PROXY_FACTORY: effectiveConfig.safeProxyFactory }
            : {}),
        ...(effectiveConfig.safeFallbackHandler
            ? { SAFE_FALLBACK_HANDLER: effectiveConfig.safeFallbackHandler }
            : {}),
        ...(effectiveConfig.ogMasterCopy ? { OG_MASTER_COPY: effectiveConfig.ogMasterCopy } : {}),
        ...(effectiveConfig.moduleProxyFactory
            ? { MODULE_PROXY_FACTORY: effectiveConfig.moduleProxyFactory }
            : {}),
        ...(effectiveConfig.liveness ? { OG_LIVENESS: effectiveConfig.liveness } : {}),
        ...(effectiveConfig.identifier ? { OG_IDENTIFIER_STR: effectiveConfig.identifier } : {}),
        ...(effectiveConfig.safeSaltNonce ? { SAFE_SALT_NONCE: effectiveConfig.safeSaltNonce } : {}),
        ...(effectiveConfig.ogSaltNonce ? { OG_SALT_NONCE: effectiveConfig.ogSaltNonce } : {}),
    };
    if (effectiveConfig.owners === undefined) {
        delete forgeEnv.SAFE_OWNERS;
    } else {
        forgeEnv.SAFE_OWNERS = effectiveConfig.owners;
    }

    await runForgeScript({
        repoRootPath,
        scriptBasename: DEPLOY_SCRIPT_BASENAME,
        contractName: 'DeploySafeWithOptimisticGovernor',
        rpcUrl,
        env: forgeEnv,
    });

    const broadcast = await readBroadcastJson(
        broadcastPathForScript(repoRootPath, DEPLOY_SCRIPT_BASENAME, runtimeContext.profile.chainId)
    );
    const returnsObject = broadcast.returns ?? {};
    const deployment = {
        ...summarizeBroadcast({
            broadcast,
            returnsObject,
            chainId: runtimeContext.profile.chainId,
        }),
        reused: false,
        moduleProxyFactory: parseReturnedAddress(returnsObject, 'deployedModuleProxyFactory'),
        commitmentSafe: parseReturnedAddress(returnsObject, 'deployedSafe'),
        ogModule: parseReturnedAddress(returnsObject, 'deployedOgModule'),
        mockDependencies,
        deploymentConfig: {
            ...effectiveConfig,
            collateral: effectiveConfig.collateral,
        },
    };

    const overlay = await readHarnessJson(sessionPaths.files.overlay);
    let nextOverlay = mergeByChainOverlay({
        existingOverlay: overlay,
        chainId: runtimeContext.profile.chainId,
        fields: {
            commitmentSafe: deployment.commitmentSafe,
            ogModule: deployment.ogModule,
            ...(deployment.startBlock ? { startBlock: deployment.startBlock } : {}),
            ...((runtimeContext.profile.name === 'local-mock' && effectiveConfig.collateral) ||
            (!runtimeContext.runtimeConfig.defaultDepositAsset && effectiveConfig.collateral)
                ? { defaultDepositAsset: effectiveConfig.collateral }
                : {}),
        },
    });

    if (mockDependencies) {
        const currentChainOverlay = nextOverlay.byChain[String(runtimeContext.profile.chainId)] ?? {};
        const currentHarness = currentChainOverlay.harness ?? {};
        const currentHarnessDeployment = currentHarness.deployment ?? {};
        nextOverlay = mergeByChainOverlay({
            existingOverlay: nextOverlay,
            chainId: runtimeContext.profile.chainId,
            fields: {
                harness: {
                    ...currentHarness,
                    deployment: {
                        ...currentHarnessDeployment,
                        safeSingleton: mockDependencies.safeSingleton,
                        safeProxyFactory: mockDependencies.safeProxyFactory,
                        safeFallbackHandler: mockDependencies.safeFallbackHandler,
                        ogMasterCopy: mockDependencies.ogMasterCopy,
                        collateral: effectiveConfig.collateral,
                    },
                },
            },
        });
    }

    await writeHarnessJson(sessionPaths.files.overlay, nextOverlay);
    await writeHarnessJson(sessionPaths.files.deployment, deployment);

    return {
        reused: false,
        deployment,
    };
}

export {
    deployHarnessCommitment,
    parseDeploymentConfig,
};
