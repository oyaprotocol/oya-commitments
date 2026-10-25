export function supportsComposeVersion(version) {
    const match = /^v?(\d+)\.(\d+)\.\d+(?:[-+][\w.-]+)?$/.exec(version.trim());
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    // env_file.format: raw requires 2.30; later major versions also qualify.
    return major > 2 || (major === 2 && minor >= 30);
}
