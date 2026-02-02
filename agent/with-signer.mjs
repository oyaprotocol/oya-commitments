#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'ethers';

const execFileAsync = promisify(execFile);

function normalizePrivateKey(value) {
  if (!value) return value;
  return value.startsWith('0x') ? value : `0x${value}`;
}

function mustGetEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
}

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

async function resolvePrivateKey() {
  const signerType = (process.env.SIGNER_TYPE ?? 'env').toLowerCase();

  if (signerType === 'env') {
    return mustGetEnv('PRIVATE_KEY');
  }

  if (signerType === 'keystore') {
    return loadPrivateKeyFromKeystore();
  }

  if (signerType === 'keychain') {
    return loadPrivateKeyFromKeychain();
  }

  if (signerType === 'vault') {
    return loadPrivateKeyFromVault();
  }

  throw new Error(`Signer type '${signerType}' does not expose a private key.`);
}

function parseArgs(args) {
  const options = { envVar: 'DEPLOYER_PK' };
  const separatorIndex = args.indexOf('--');
  if (separatorIndex === -1) {
    throw new Error('Usage: node agent/with-signer.mjs [--env VAR] -- <command>');
  }

  const optionArgs = args.slice(0, separatorIndex);
  const commandArgs = args.slice(separatorIndex + 1);

  for (let i = 0; i < optionArgs.length; i += 1) {
    if (optionArgs[i] === '--env') {
      options.envVar = optionArgs[i + 1];
      i += 1;
      continue;
    }
  }

  if (!options.envVar) {
    throw new Error('Missing env var name for --env.');
  }

  if (commandArgs.length === 0) {
    throw new Error('Missing command after --.');
  }

  return { options, commandArgs };
}

const { options, commandArgs } = parseArgs(process.argv.slice(2));
const privateKey = normalizePrivateKey(await resolvePrivateKey());

const [command, ...commandRest] = commandArgs;
const child = await new Promise((resolve, reject) => {
  const proc = spawn(command, commandRest, {
    stdio: 'inherit',
    env: {
      ...process.env,
      [options.envVar]: privateKey,
    },
  });

  proc.on('exit', (code) => resolve(code ?? 1));
  proc.on('error', reject);
});

process.exitCode = child;
