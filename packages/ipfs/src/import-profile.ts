// File portion of unixfs-v1-2025, plus canonical text output and no directory wrapper.
// Keep these explicit: provider defaults may differ or change between releases.
const IPFS_ADD_QUERY = new URLSearchParams({
    'cid-version': '1',
    'cid-base': 'base32',
    hash: 'sha2-256',
    chunker: 'size-1048576',
    'raw-leaves': 'true',
    trickle: 'false',
    'max-file-links': '1024',
    'wrap-with-directory': 'false',
    inline: 'false',
    'preserve-mode': 'false',
    'preserve-mtime': 'false',
    pin: 'true',
    progress: 'false',
}).toString();

export { IPFS_ADD_QUERY };
