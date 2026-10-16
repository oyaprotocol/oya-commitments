// Keep a reference to the list so credentials generated later are also redacted.
export function createFixtureRedactor(secrets, paths = []) {
    return value => {
        let output = String(value ?? '');
        for (const secret of secrets) {
            if (secret) output = output.replaceAll(secret, '[redacted]');
        }
        for (const [path, replacement] of paths) output = output.replaceAll(path, replacement);
        return output;
    };
}
