import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ethWaitForTransactionReceipt, parseTransactionQuantity, requestEthereumJsonRpc } from '@oyaprotocol/ethereum';
import { createTimeoutSignal, invokeWithAbort } from '@oyaprotocol/utils';
import { createLocalSigner } from '../src/signer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const equal = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();

export function deploymentPath(configPath) {
    const name = basename(configPath);
    return join(dirname(configPath), name === 'config.local.json' ? 'deployment.local.json'
        : `${name}.deployment.local.json`);
}

function hasCode(code) {
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error('Invalid bytecode.');
    return code !== '0x';
}

async function readDeployment(artifactPath, chainId, deployer) {
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    if (artifact.chain !== chainId || artifact.transactions?.length !== 1) throw new Error('Invalid deployment artifact.');
    const transaction = artifact.transactions[0];
    if (transaction.contractName !== 'Logger' || transaction.transactionType !== 'CREATE'
        || !addressPattern.test(transaction.contractAddress) || /^0x0{40}$/i.test(transaction.contractAddress)
        || !hashPattern.test(transaction.hash) || !equal(transaction.transaction?.from, deployer)
        || transaction.transaction?.to != null) throw new Error('Invalid deployment transaction.');
    return { address: transaction.contractAddress, transactionHash: transaction.hash };
}

export async function deployLogger(configPath, { config, configText, env }, {
    broadcast = false, execute = promisify(execFile), fetch = globalThis.fetch, log = console.log,
} = {}) {
    let stage = 'Check Ethereum RPC availability and chainId.';
    let artifactPath;
    let submitted = false;
    let deployment;
    let deployer;
    const rpc = async (method, params = []) => {
        const timeout = createTimeoutSignal(10_000);
        try {
            return await invokeWithAbort(async () => (await requestEthereumJsonRpc({
                config: config.rpc, fetch, method, params, signal: timeout.signal,
            })).result, timeout.signal);
        } finally { timeout.cleanup(); }
    };
    const checkChain = async () => {
        if (parseTransactionQuantity(await rpc('eth_chainId'), 'chainId') !== BigInt(config.chainId)) {
            throw new Error('Wrong chain.');
        }
    };
    try {
        if (config.rpc.headers.authorization) {
            log('FAIL deploy-logger does not support RPC Authorization headers yet. Use an RPC endpoint without that requirement.');
            return 1;
        }
        await checkChain();
        stage = 'Check the configured Logger address and RPC bytecode response.';
        if (hasCode(await rpc('eth_getCode', [config.loggerContract, 'latest']))) {
            log(`OK Reusing configured Logger ${config.loggerContract} on chain ${config.chainId}; no deployment submitted.`);
            return 0;
        }
        stage = 'Set a valid LOGGER_DEPLOYER_PK in the selected environment file or inherited environment.';
        deployer = createLocalSigner(env.LOGGER_DEPLOYER_PK).address;
        stage = 'Check config permissions and prior deployment metadata before deploying.';
        const original = await lstat(configPath);
        // Atomic replacement must not silently sever a symlink or another hard link.
        if (!original.isFile() || original.nlink !== 1) throw new Error('Config must be a regular, singly linked file.');
        await access(configPath, constants.W_OK);
        const metadataPath = deploymentPath(configPath);
        try {
            await lstat(metadataPath);
            log('FAIL Prior deployment metadata exists but the configured address has no code. Reconcile the record and chain before deploying again.');
            return 1;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const directory = await mkdtemp(join(dirname(configPath), '.oya-logger-'));
        artifactPath = join(directory, 'broadcast', 'DeployLogger.s.sol', String(config.chainId), 'run-latest.json');
        log(`Deployment artifacts: ${directory}`);
        // Retain ordinary process settings, but isolate Foundry and Oya configuration.
        const baseEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
            !/^(OYA_|LOGGER_|FOUNDRY_|DAPP_|ETH_|ETHERSCAN_|VERIFIER_)/.test(key)));
        stage = 'Install Foundry and initialize lib/forge-std before deploying.';
        try { await access(join(root, 'lib/forge-std/src/Script.sol')); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await execute('git', ['submodule', 'update', '--init', 'lib/forge-std'], {
                cwd: root, env: baseEnv, timeout: 180_000,
            });
        }
        const forgeEnv = { ...baseEnv, LOGGER_CHAIN_ID: String(config.chainId), LOGGER_DEPLOYER_PK: env.LOGGER_DEPLOYER_PK,
            FOUNDRY_ETH_RPC_URL: config.rpc.url,
            FOUNDRY_BROADCAST: join(directory, 'broadcast'), FOUNDRY_CACHE_PATH: join(directory, 'cache'),
        };
        stage = 'Forge deployment failed. Check Foundry, compiler availability, deployer funds, and retained artifacts.';
        log(`${broadcast ? 'Broadcasting' : 'Simulating'} Logger deployment from ${deployer} on chain ${config.chainId}.`);
        submitted = broadcast;
        // Forge compiles the existing script and simulates before any explicit broadcast.
        await execute('forge', ['script', '--root', 'contracts', 'contracts/script/DeployLogger.s.sol:DeployLogger',
            '--non-interactive', '--no-storage-caching', '--timeout', '60', ...(broadcast ? ['--broadcast'] : [])], {
            cwd: root, env: forgeEnv, timeout: 180_000, maxBuffer: 1_048_576,
        });
        if (!broadcast) {
            log('OK Simulation passed; no deployment submitted or configuration changed. Use --broadcast to deploy.');
            return 0;
        }
        stage = 'Could not verify the deployment. Inspect its receipt and retained artifacts before retrying.';
        deployment = await readDeployment(artifactPath, config.chainId, deployer);
        log(`Deployment transaction: ${deployment.transactionHash}`);
        const { receipt } = await ethWaitForTransactionReceipt({ config: config.rpc, fetch,
            transactionHash: deployment.transactionHash, timeoutMs: config.receiptTimeoutMs,
            pollIntervalMs: config.pollIntervalMs });
        await checkChain();
        if (receipt.status !== 'success' || receipt.to !== null || !equal(receipt.from, deployer)
            || !equal(receipt.contractAddress, deployment.address)
            || !hasCode(await rpc('eth_getCode', [deployment.address, 'latest']))) throw new Error('Deployment did not verify.');
        log(`OK Verified Logger ${deployment.address} on chain ${config.chainId}.`);
        stage = 'Deployment verified, but recording failed. Adopt the verified address manually; do not deploy again.';
        const current = await lstat(configPath);
        if (current.dev !== original.dev || current.ino !== original.ino || current.nlink !== 1
            || await readFile(configPath, 'utf8') !== configText) throw new Error('Config changed during deployment.');
        const metadata = { chainId: config.chainId, loggerContract: deployment.address,
            transactionHash: deployment.transactionHash, blockNumber: receipt.blockNumber.toString(), deployer };
        await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        const updated = { ...JSON.parse(configText), loggerContract: deployment.address };
        const replacement = join(directory, 'config.json');
        await writeFile(replacement, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await chmod(replacement, current.mode & 0o777);
        await rename(replacement, configPath);
        log('OK Deployment recorded and loggerContract updated. Run local check after funding the node and starting IPFS.');
        return 0;
    } catch {
        log(`FAIL ${stage}`);
        if (submitted) {
            if (!deployment) {
                try {
                    deployment = await readDeployment(artifactPath, config.chainId, deployer);
                    log(`Deployment transaction: ${deployment.transactionHash}`);
                } catch { /* Missing or malformed artifacts must not expose raw Forge output. */ }
            }
            log('Inspect the retained artifacts and reconcile the deployment before another --broadcast. Forge was invoked once; no automatic relaunch or resume was attempted.');
        }
        return 1;
    }
}
