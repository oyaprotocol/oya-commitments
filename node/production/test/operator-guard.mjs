import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowed = new Set(JSON.parse(process.env.TEST_OPERATOR_FILES));
for (const name of ['scripts/operator-node.mjs', 'scripts/operator-profile.mjs', 'scripts/operator-status.mjs',
    'src/public-settings.mjs', 'src/defaults.mjs', 'src/health.mjs']) {
    allowed.add(fileURLToPath(new URL(`../${name}`, import.meta.url)));
}
const check = file => {
    const path = file instanceof URL ? fileURLToPath(file) : String(file);
    if (!allowed.has(resolve(path))) throw new Error('Unexpected file access');
};
for (const [object, methods] of [[fs, ['readFileSync', 'openSync']], [promises, ['readFile', 'open']]]) {
    for (const name of methods) {
        const original = object[name];
        object[name] = (file, ...args) => { check(file); return original(file, ...args); };
    }
}
syncBuiltinESMExports();
registerHooks({
    resolve(specifier, context, next) {
        if (!specifier.startsWith('node:') && !specifier.startsWith('.') && !specifier.startsWith('file:')) {
            throw new Error('Host dependency import');
        }
        if (/signer|secrets|child_process|local-config|inbox\/worker/.test(specifier)) throw new Error('Secret or lifecycle import');
        return next(specifier, context);
    },
});
const env = process.env;
process.env = new Proxy(env, {
    get(target, key) {
        if (/PRIVATE_KEY|AUTHORIZATION|TOKEN|KEYCHAIN/.test(String(key))) throw new Error('Secret environment access');
        return target[key];
    },
});
