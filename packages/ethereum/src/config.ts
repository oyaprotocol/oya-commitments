import { createHttpConfig } from '@oyaprotocol/utils';
import type { CreateHttpConfigOptions, HttpConfig } from '@oyaprotocol/utils';

function createEthereumRpcConfig(options: CreateHttpConfigOptions): HttpConfig {
    return createHttpConfig(options);
}

export { createEthereumRpcConfig };
