// CLI preload: fail the process if verification touches signing or private files.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Wallet, BaseWallet, SigningKey } from 'ethers';

const denied = () => { process.stderr.write(new Error('Forbidden evidence side effect').stack + '\n'); process.exit(99); };
Wallet.createRandom = denied;
BaseWallet.prototype.signMessage = denied;
BaseWallet.prototype.signTransaction = denied;
BaseWallet.prototype.signTypedData = denied;
SigningKey.prototype.sign = denied;
const open = promises.open;
promises.open = async (path, flags, ...args) => {
    if (!process.argv.slice(3).includes(path) || flags !== (fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)) denied();
    return open(path, flags, ...args);
};
// Node's module loader also uses public fs reads on some supported versions.
const runtime = fileURLToPath(new URL('../', import.meta.url));
const sourceOnly = original => (path, ...args) => {
    const name = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    if (!name.startsWith(runtime) || !/\.(?:m?js|json)$/.test(name)) denied();
    return original(path, ...args);
};
promises.readFile = sourceOnly(promises.readFile);
fs.readFile = sourceOnly(fs.readFile);
fs.readFileSync = sourceOnly(fs.readFileSync);
const openSync = fs.openSync;
fs.openSync = sourceOnly((path, flags, ...args) => {
    if (flags !== 'r' && flags !== fs.constants.O_RDONLY) denied();
    return openSync(path, flags, ...args);
});
for (const name of ['writeFile', 'appendFile', 'unlink', 'rename', 'mkdir', 'rm']) promises[name] = denied;
for (const name of ['open', 'writeFile', 'writeFileSync',
    'createReadStream', 'createWriteStream', 'appendFile', 'unlink', 'rename', 'mkdir', 'rm']) fs[name] = denied;
syncBuiltinESMExports();
const environment = process.env;
process.env = new Proxy(environment, { get(target, key) {
    if (typeof key === 'string' && /^OYA_/.test(key)) denied();
    return Reflect.get(target, key);
} });
