import { createHttpConfig } from '@oyaprotocol/utils';
function normalizeUrl(url) {
    return url.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
}
function createIpfsConfig(options) {
    return createHttpConfig(options, normalizeUrl);
}
export { createIpfsConfig };
//# sourceMappingURL=config.js.map