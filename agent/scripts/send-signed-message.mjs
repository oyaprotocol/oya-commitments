import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSignedMessagePayload } from '../src/lib/message-signing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config();
dotenv.config({ path: path.resolve(repoRoot, 'agent/.env') });

function getArgValue(prefix) {
    const arg = process.argv.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : null;
}

function hasFlag(flag) {
    return process.argv.includes(flag);
}

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

function buildBaseUrl() {
    const explicit = getArgValue('--url=') ?? process.env.MESSAGE_API_URL;
    if (explicit) {
        return explicit.replace(/\/+$/, '');
    }
    const host = getArgValue('--host=') ?? process.env.MESSAGE_API_HOST ?? '127.0.0.1';
    const portRaw = getArgValue('--port=') ?? process.env.MESSAGE_API_PORT ?? '8787';
    const port = parseInteger(portRaw, 'port');
    const scheme = getArgValue('--scheme=') ?? process.env.MESSAGE_API_SCHEME ?? 'http';
    return `${scheme}://${host}:${port}`;
}

function printUsage() {
    console.log(`Usage:
  node agent/scripts/send-signed-message.mjs --text="Pause proposals for 2 hours" [options]

Required:
  --text=<string>                      Message text
  --private-key=<hex>                  Signer private key (or MESSAGE_API_SIGNER_PRIVATE_KEY)

Optional:
  --url=<base-url>                     Full base URL, e.g. http://127.0.0.1:8787
  --host=<host>                        Used if --url is omitted (default 127.0.0.1)
  --port=<int>                         Used if --url is omitted (default 8787)
  --scheme=<http|https>                Used if --url is omitted (default http)
  --command=<string>                   Optional command field
  --args-json='<json-object>'          Optional args object
  --metadata-json='<json-object>'      Optional metadata object
  --idempotency-key=<string>           Optional (auto-generated when omitted)
  --ttl-seconds=<int>                  Optional message TTL
  --timestamp-ms=<int>                 Optional signature timestamp (default now)
  --timeout-ms=<int>                   HTTP timeout (default 10000)
  --dry-run                            Print signed payload and request body without sending
  --help                               Show this help
`);
}

async function main() {
    if (hasFlag('--help') || hasFlag('-h')) {
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

    const baseUrl = buildBaseUrl();
    const command = getArgValue('--command=') ?? undefined;
    const args = parseOptionalObject(getArgValue('--args-json='), '--args-json');
    const metadata = parseOptionalObject(getArgValue('--metadata-json='), '--metadata-json');
    const idempotencyKey =
        getArgValue('--idempotency-key=') ?? `sig-${Date.now()}-${randomUUID().slice(0, 8)}`;
    if (!idempotencyKey.trim()) {
        throw new Error('--idempotency-key cannot be blank.');
    }

    const ttlRaw = getArgValue('--ttl-seconds=');
    const ttlSeconds = ttlRaw === null ? undefined : parseInteger(ttlRaw, '--ttl-seconds');
    const timestampRaw = getArgValue('--timestamp-ms=');
    const timestampMs =
        timestampRaw === null ? Date.now() : parseInteger(timestampRaw, '--timestamp-ms');
    const timeoutRaw = getArgValue('--timeout-ms=') ?? process.env.MESSAGE_API_TIMEOUT_MS ?? '10000';
    const timeoutMs = parseInteger(timeoutRaw, '--timeout-ms');

    const payload = buildSignedMessagePayload({
        address: account.address,
        timestampMs,
        text,
        command,
        args,
        metadata,
        idempotencyKey,
        ttlSeconds,
    });
    const signature = await account.signMessage({ message: payload });

    const body = {
        text,
        idempotencyKey,
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
    if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;

    if (hasFlag('--dry-run')) {
        console.log(
            JSON.stringify(
                {
                    baseUrl,
                    payload,
                    body,
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
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
        idempotencyKey,
        status: response.status,
        ok: response.ok,
        response: responseJson,
    };
    console.log(JSON.stringify(output, null, 2));

    if (!response.ok) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('[agent] send signed message failed:', error?.message ?? error);
    process.exit(1);
});
