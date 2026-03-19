import { randomUUID } from 'node:crypto';
import {
    resolveAgentRuntimeConfig,
    resolveConfiguredChainId,
} from '../src/lib/agent-config.js';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSignedMessagePayload } from '../src/lib/message-signing.js';
import {
    getArgValue,
    hasFlag,
    isDirectScriptExecution,
    loadAgentConfigForScript,
    loadScriptEnv,
    repoRoot,
    resolveAgentModulePath,
    resolveAgentRef,
} from './lib/cli-runtime.mjs';

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

function normalizePrivateKey(value) {
    if (!value) {
        throw new Error(
            'Missing signing key. Provide --private-key or MESSAGE_API_SIGNER_PRIVATE_KEY.'
        );
    }
    return value.startsWith('0x') ? value : `0x${value}`;
}

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('base URL must be a non-empty string.');
    }
    return value.trim().replace(/\/+$/, '');
}

function parseBaseUrlParts(value, label) {
    let parsed;
    try {
        parsed = new URL(normalizeBaseUrl(value));
    } catch (error) {
        throw new Error(`${label} must be a valid URL.`);
    }

    const scheme = parsed.protocol.replace(/:$/, '');
    if (!scheme) {
        throw new Error(`${label} must include a scheme.`);
    }
    if (!parsed.hostname) {
        throw new Error(`${label} must include a host.`);
    }

    let port;
    if (parsed.port) {
        port = parseInteger(parsed.port, `${label} port`);
    } else if (scheme === 'http') {
        port = 80;
    } else if (scheme === 'https') {
        port = 443;
    } else {
        throw new Error(`${label} must include an explicit port for scheme "${scheme}".`);
    }

    return {
        scheme,
        host: parsed.hostname,
        port,
        pathname: parsed.pathname,
        search: parsed.search,
    };
}

function formatBaseUrl({ scheme, host, port, pathname = '', search = '' }) {
    const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const normalizedPath =
        pathname && pathname !== '/'
            ? pathname.replace(/\/+$/, '')
            : '';
    return `${scheme}://${authorityHost}:${port}${normalizedPath}${search}`;
}

async function resolveMessageApiConfigForAgent({
    agentRef,
    chainId,
    repoRootPath = repoRoot,
    env = process.env,
}) {
    const {
        modulePath: resolvedModulePath,
        configPath: agentConfigPath,
        agentConfigStack,
    } = await loadAgentConfigForScript(agentRef, {
        repoRootPath,
        env,
    });
    const agentConfigFile = agentConfigStack;
    const runtimeChainId = resolveConfiguredChainId({
        agentConfigFile,
        explicitChainId: chainId,
    });

    const runtimeConfig = resolveAgentRuntimeConfig({
        baseConfig: {
            chainId: runtimeChainId,
            commitmentSafe: undefined,
            ogModule: undefined,
            watchAssets: [],
            watchErc1155Assets: [],
            messageApiEnabled: false,
            messageApiHost: '127.0.0.1',
            messageApiPort: 8787,
            messageApiKeys: {},
            messageApiRequireSignerAllowlist: true,
            messageApiSignerAllowlist: [],
            messageApiSignatureMaxAgeSeconds: 300,
            messageApiMaxBodyBytes: 8192,
            messageApiMaxTextLength: 2000,
            messageApiQueueLimit: 500,
            messageApiBatchSize: 25,
            messageApiDefaultTtlSeconds: 3600,
            messageApiMinTtlSeconds: 30,
            messageApiMaxTtlSeconds: 86400,
            messageApiIdempotencyTtlSeconds: 86400,
            messageApiRateLimitPerMinute: 30,
            messageApiRateLimitBurst: 10,
        },
        agentConfigFile,
        chainId: runtimeChainId,
    });

    return {
        ...runtimeConfig,
        hasMessageApiConfig: Boolean(runtimeConfig.agentConfig?.messageApi),
        modulePath: resolvedModulePath,
        configPath: agentConfigPath,
    };
}

async function resolveMessageApiTarget({
    argv = process.argv,
    env = process.env,
    repoRootPath = repoRoot,
} = {}) {
    const explicit = getArgValue('--url=', argv);
    const explicitHost = getArgValue('--host=', argv);
    const explicitPortRaw = getArgValue('--port=', argv);
    const explicitPort =
        explicitPortRaw === null ? undefined : parseInteger(explicitPortRaw, 'port');
    const explicitScheme = getArgValue('--scheme=', argv);

    const agentRef = resolveAgentRef({ argv, env });
    const chainId = getArgValue('--chain-id=', argv) ?? undefined;
    const runtimeConfig = await resolveMessageApiConfigForAgent({
        agentRef,
        chainId,
        repoRootPath,
        env,
    });

    const baseParts = {
        scheme: 'http',
        host: runtimeConfig.messageApiHost,
        port: runtimeConfig.messageApiPort,
    };

    return {
        baseUrl: explicit
            ? normalizeBaseUrl(explicit)
            : formatBaseUrl({
                  ...baseParts,
                  scheme: explicitScheme ?? baseParts.scheme,
                  host: explicitHost ?? baseParts.host,
                  port: explicitPort ?? baseParts.port,
              }),
        chainId: runtimeConfig.chainId,
    };
}

async function buildBaseUrl({
    argv = process.argv,
    env = process.env,
    repoRootPath = repoRoot,
} = {}) {
    const target = await resolveMessageApiTarget({
        argv,
        env,
        repoRootPath,
    });
    return target.baseUrl;
}

function printUsage() {
    console.log(`Usage:
  node agent/scripts/send-signed-message.mjs --text="Pause proposals for 2 hours" [options]

Required:
  --text=<string>                      Message text
  --private-key=<hex>                  Signer private key (or MESSAGE_API_SIGNER_PRIVATE_KEY)

Optional:
  --url=<base-url>                     Full base URL, e.g. http://127.0.0.1:8787
  --host=<host>                        Used if --url is omitted; overrides module config host
  --port=<int>                         Used if --url is omitted; overrides module config port
  --scheme=<http|https>                Used if --url is omitted (default http)
  --module=<agent-ref>                 Agent module whose config.json should supply messageApi host/port
  --chain-id=<int>                     Optional assertion; must match the module config's selected chain when provided
  --bearer-token=<string>              Optional bearer token (or MESSAGE_API_BEARER_TOKEN)
  --command=<string>                   Optional command field
  --args-json='<json-object>'          Optional args object
  --metadata-json='<json-object>'      Optional metadata object
  --request-id=<string>                Optional (auto-generated when omitted)
  --deadline-ms=<int>                  Optional absolute deadline (Unix ms)
  --timestamp-ms=<int>                 Optional signature timestamp (default now)
  --timeout-ms=<int>                   HTTP timeout (default 10000)
  --dry-run                            Print signed payload and request body without sending
  --help                               Show this help
`);
}

async function main() {
    if (hasFlag('--help', process.argv) || hasFlag('-h', process.argv)) {
        printUsage();
        return;
    }

    const text = getArgValue('--text=');
    if (!text || !text.trim()) {
        throw new Error('--text is required and must be non-empty.');
    }

    const normalizedPrivateKey = normalizePrivateKey(
        getArgValue('--private-key=') ?? process.env.MESSAGE_API_SIGNER_PRIVATE_KEY
    );
    const account = privateKeyToAccount(normalizedPrivateKey);

    const { baseUrl, chainId } = await resolveMessageApiTarget();
    const bearerToken =
        getArgValue('--bearer-token=') ?? process.env.MESSAGE_API_BEARER_TOKEN ?? undefined;
    const command = getArgValue('--command=') ?? undefined;
    const args = parseOptionalObject(getArgValue('--args-json='), '--args-json');
    const metadata = parseOptionalObject(getArgValue('--metadata-json='), '--metadata-json');
    const requestId =
        getArgValue('--request-id=') ?? `sig-${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (!requestId.trim()) {
        throw new Error('--request-id cannot be blank.');
    }

    const deadlineRaw = getArgValue('--deadline-ms=');
    const deadline = deadlineRaw === null ? undefined : parseInteger(deadlineRaw, '--deadline-ms');
    const timestampRaw = getArgValue('--timestamp-ms=');
    const timestampMs =
        timestampRaw === null ? Date.now() : parseInteger(timestampRaw, '--timestamp-ms');
    const timeoutRaw = getArgValue('--timeout-ms=') ?? process.env.MESSAGE_API_TIMEOUT_MS ?? '10000';
    const timeoutMs = parseInteger(timeoutRaw, '--timeout-ms');

    const payload = buildSignedMessagePayload({
        address: account.address,
        chainId,
        timestampMs,
        text,
        command,
        args,
        metadata,
        requestId,
        deadline,
    });
    const signature = await account.signMessage({ message: payload });

    const body = {
        text,
        ...(chainId !== undefined ? { chainId } : {}),
        requestId,
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

    const endpoint = `${baseUrl}/v1/messages`;
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
        signer: account.address,
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
        console.error('[agent] send signed message failed:', error?.message ?? error);
        process.exit(1);
    });
}

export {
    buildBaseUrl,
    resolveMessageApiConfigForAgent,
    resolveMessageApiTarget,
    resolveAgentModulePath,
};
