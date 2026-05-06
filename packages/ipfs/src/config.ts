import { createHttpConfig } from '@oyaprotocol/utils';
import type { CreateHttpConfigOptions, HttpConfig } from '@oyaprotocol/utils';

function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}

function createIpfsConfig(options: CreateHttpConfigOptions): HttpConfig {
    return createHttpConfig(options, normalizeUrl);
}

export { createIpfsConfig };
