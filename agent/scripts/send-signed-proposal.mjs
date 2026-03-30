import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSignedProposalPayload } from '../src/lib/signed-proposal.js';
import { createSignerClient } from '../src/lib/signer.js';
import { normalizePrivateKey } from '../src/lib/utils.js';
import {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadScriptEnv,
} from './lib/cli-runtime.mjs';
import {
    buildProposalPublishBaseUrl,
    resolveProposalPublishApiTarget,
} from './lib/proposal-publish-runtime.mjs';

loadScriptEnv();

function parseInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new Error(`${label} must be an integer.`);
    }
    return parsed;
}

function parseOptionalObject(raw, label) {
    if (raw === null || raw === undefined || raw === '') return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${label} must be valid JSON.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }
    return parsed;
}

function parseRequiredArray(raw, label) {
    if (raw === null || raw === undefined || raw === '') {
        throw new Error(`${label} is required.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`${label} must be valid JSON.`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`${label} must be a non-empty JSON array.`);
    }
    return parsed;
}

async function resolveExplanation({ argv = process.argv }) {
    const inline = getArgValue('--explanation=', argv);
    const filePath = getArgValue('--explanation-file=', argv);
    if (inline && filePath) {
        throw new Error('Use either --explanation or --explanation-file, not both.');
    }
    if (filePath) {
        const raw = await readFile(filePath, 'utf8');
        if (!raw.trim()) {
            throw new Error('--explanation-file must contain non-empty text.');
        }
        return raw;
    }
    if (!inline || !inline.trim()) {
        throw new Error('--explanation is required and must be non-empty.');
    }
    return inline;
}

async function resolveProposalSigner({ argv = process.argv, env = process.env } = {}) {
    const explicitPrivateKey = normalizePrivateKey(
        getArgValue('--private-key=', argv) ?? env.PROPOSAL_PUBLISH_SIGNER_PRIVATE_KEY
    );
    if (explicitPrivateKey) {
        const account = privateKeyToAccount(explicitPrivateKey);
        return {
            account,
            async signMessage(message) {
                return account.signMessage({ message });
            },
        };
    }

    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) {
        throw new Error(
            'Missing signing configuration. Provide --private-key or PROPOSAL_PUBLISH_SIGNER_PRIVATE_KEY, or set RPC_URL with SIGNER_TYPE-based signer config.'
        );
    }
    const { account, walletClient } = await createSignerClient({ rpcUrl });
    if (!walletClient || typeof walletClient.signMessage !== 'function') {
        throw new Error('Configured signer does not support signMessage.');
    }
    return {
        account,
        async signMessage(message) {
            return walletClient.signMessage({
                account,
                message,
            });
        },
    };
}

function printUsage() {
    console.log(`Usage:
  node agent/scripts/send-signed-proposal.mjs --safe=0x... --og-module=0x... --transactions-json='[...]' --explanation="..." [options]

Required:
  --safe=<address>                     Commitment Safe address
  --og-module=<address>                Optimistic Governor module address
  --transactions-json='<json-array>'   Proposal transactions
  --explanation=<string>               Human-readable explanation
                                       Or use --explanation-file=<path>

Signer:
  --private-key=<hex>                  Optional explicit signer private key
                                       Or set PROPOSAL_PUBLISH_SIGNER_PRIVATE_KEY
                                       Otherwise uses the shared SIGNER_TYPE-based signer config

Target:
  --url=<base-url>                     Full base URL, e.g. http://127.0.0.1:9890
                                       When used, also provide --chain-id or --module
  --host=<host>                        Used if --url is omitted; overrides module config host
  --port=<int>                         Used if --url is omitted; overrides module config port
  --scheme=<http|https>                Used if --url is omitted (default http)
  --module=<agent-ref>                 Agent module whose config.json should supply proposalPublishApi host/port
  --chain-id=<int>                     Optional assertion; must match the module config's selected chain when provided
  --overlay=<path>                     Optional extra config overlay file for script-side config resolution
  --overlay-paths=<a,b>                Optional comma-separated extra overlay files

Optional:
  --request-id=<string>                Optional (auto-generated when omitted)
  --metadata-json='<json-object>'      Optional metadata object
  --deadline-ms=<int>                  Optional absolute deadline (Unix ms)
  --timestamp-ms=<int>                 Optional signature timestamp (default now)
  --timeout-ms=<int>                   HTTP timeout (default 10000)
  --bearer-token=<string>              Optional bearer token (or PROPOSAL_PUBLISH_BEARER_TOKEN)
  --dry-run                            Print signed payload and request body without sending
  --help                               Show this help
`);
}

async function main() {
    if (hasFlag('--help', process.argv) || hasFlag('-h', process.argv)) {
        printUsage();
        return;
    }

    const commitmentSafe = getArgValue('--safe=');
    if (!commitmentSafe || !commitmentSafe.trim()) {
        throw new Error('--safe is required and must be non-empty.');
    }
    const ogModule = getArgValue('--og-module=');
    if (!ogModule || !ogModule.trim()) {
        throw new Error('--og-module is required and must be non-empty.');
    }

    const explanation = await resolveExplanation({});
    const transactions = parseRequiredArray(getArgValue('--transactions-json='), '--transactions-json');
    const metadata = parseOptionalObject(getArgValue('--metadata-json='), '--metadata-json');
    const requestId =
        getArgValue('--request-id=') ?? `proposal-${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (!requestId.trim()) {
        throw new Error('--request-id cannot be blank.');
    }

    const deadlineRaw = getArgValue('--deadline-ms=');
    const deadline = deadlineRaw === null ? undefined : parseInteger(deadlineRaw, '--deadline-ms');
    const timestampRaw = getArgValue('--timestamp-ms=');
    const timestampMs =
        timestampRaw === null ? Date.now() : parseInteger(timestampRaw, '--timestamp-ms');
    const timeoutRaw =
        getArgValue('--timeout-ms=') ?? process.env.PROPOSAL_PUBLISH_TIMEOUT_MS ?? '10000';
    const timeoutMs = parseInteger(timeoutRaw, '--timeout-ms');

    const { baseUrl, chainId } = await resolveProposalPublishApiTarget();
    const bearerToken =
        getArgValue('--bearer-token=') ?? process.env.PROPOSAL_PUBLISH_BEARER_TOKEN ?? undefined;
    const signer = await resolveProposalSigner();

    const payload = buildSignedProposalPayload({
        address: signer.account.address,
        chainId,
        timestampMs,
        requestId,
        commitmentSafe,
        ogModule,
        transactions,
        explanation,
        metadata,
        deadline,
    });
    const signature = await signer.signMessage(payload);

    const body = {
        chainId,
        requestId,
        commitmentSafe,
        ogModule,
        transactions,
        explanation,
        auth: {
            type: 'eip191',
            address: signer.account.address,
            timestampMs,
            signature,
        },
    };
    if (metadata !== undefined) body.metadata = metadata;
    if (deadline !== undefined) body.deadline = deadline;

    if (hasFlag('--dry-run', process.argv)) {
        console.log(
            JSON.stringify(
                {
                    baseUrl,
                    payload,
                    body,
                    headers: bearerToken
                        ? {
                              Authorization: `Bearer ${bearerToken}`,
                              'Content-Type': 'application/json',
                          }
                        : {
                              'Content-Type': 'application/json',
                          },
                },
                null,
                2
            )
        );
        return;
    }

    const endpoint = `${baseUrl}/v1/proposals/publish`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    let response;
    let responseJson;
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (bearerToken) {
            headers.Authorization = `Bearer ${bearerToken}`;
        }
        response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: abortController.signal,
        });
        const raw = await response.text();
        try {
            responseJson = raw ? JSON.parse(raw) : {};
        } catch (error) {
            responseJson = { raw };
        }
    } finally {
        clearTimeout(timeout);
    }

    const output = {
        endpoint,
        signer: signer.account.address,
        requestId,
        status: response.status,
        ok: response.ok,
        response: responseJson,
    };
    console.log(JSON.stringify(output, null, 2));

    if (!response.ok) {
        process.exitCode = 1;
    }
}

if (isDirectScriptExecution(import.meta.url)) {
    main().catch((error) => {
        console.error('[oya-node] send signed proposal failed:', error?.message ?? error);
        process.exit(1);
    });
}

export {
    buildProposalPublishBaseUrl as buildBaseUrl,
    resolveProposalPublishApiTarget,
    resolveProposalSigner,
};
