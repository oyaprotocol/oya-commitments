import { readIpfsPublicGatewayBytesWithMessages } from './read-ipfs-public-gateway-bytes.js';
import type { ReadIpfsPublicGatewayOptions } from './read-ipfs-public-gateway-bytes.js';
import type { ReadIpfsTextResult } from './read-ipfs-text.js';
import { assertAsciiBytes } from './validation-utils.js';

async function readIpfsPublicGatewayText(
    options: ReadIpfsPublicGatewayOptions
): Promise<ReadIpfsTextResult> {
    const result = await readIpfsPublicGatewayBytesWithMessages(options, {
        abortErrorMessage: 'readIpfsPublicGatewayText was aborted by the caller.',
        fallbackErrorBaseMessage: 'IPFS public gateway text read failed',
    });
    assertAsciiBytes(
        result.bytes,
        'IPFS public gateway response contained non-ASCII bytes.'
    );

    return {
        cid: result.cid,
        uri: result.uri,
        text: new TextDecoder('utf-8').decode(result.bytes),
        byteLength: result.byteLength,
        attemptCount: result.attemptCount,
    };
}

export { readIpfsPublicGatewayText };
