import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatBalance, operatorBalance } from './operator-balance.mjs';
import { formatGasPolicy } from '../src/gas-policy.mjs';
import { loadProfile } from './operator-profile.mjs';
import { formatStatus, operatorStatus, result } from './operator-status.mjs';

export async function main(args, { env = process.env, log = console.log } = {}) {
    let values, positionals;
    const emit = value => log((values?.json ?? args.includes('--json')) ? JSON.stringify(value) : formatStatus(value));
    try {
        ({ values, positionals } = parseArgs({ args, allowPositionals: true,
            options: { profile: { type: 'string' }, json: { type: 'boolean' } } }));
        if (positionals.length !== 1 || !['status', 'gas-policy', 'balance', 'monitor-once'].includes(positionals[0]) ||
            args.filter(arg => arg === '--json').length > 1 ||
            args.filter(arg => arg === '--profile' || arg.startsWith('--profile=')).length > 1 ||
            !(values.profile ?? env.OYA_OPERATOR_PROFILE)) throw new Error();
    } catch {
        emit(result('arguments'));
        return 2;
    }
    const file = values.profile ?? env.OYA_OPERATOR_PROFILE;
    const [command] = positionals;
    let profile;
    try {
        profile = await loadProfile(file, command);
        if (command === 'gas-policy') {
            log(values.json ? JSON.stringify(profile) : formatGasPolicy(profile));
            return 0;
        }
    }
    catch { emit(result('configuration')); return 2; }
    if (command === 'monitor-once') {
        const [health, balance] = await Promise.all([
            profile.health ? operatorStatus(profile.health) : result('configuration', profile.identity),
            profile.balance ? operatorBalance(profile.balance) : { status: 'configuration', balanceWei: null },
        ]);
        const healthState = health.healthy ? 'healthy' : health.verified ? 'degraded' : 'unknown';
        const balanceState = balance.status === 'observed' ? 'observed'
            : balance.status === 'not_applicable' ? 'not_applicable' : 'unknown';
        const report = { version: 1, health: { ...health, state: healthState }, balance: { ...balance, state: balanceState } };
        log(values.json ? JSON.stringify(report) :
            `Health (${healthState}): ${formatStatus(health)}\nBalance (${balanceState}): ${profile.balance ? formatBalance(balance) : 'Invalid balance configuration.'}`);
        if (!profile.health || !profile.balance) return 2;
        return health.healthy && balanceState !== 'unknown' ? 0 : 1;
    }
    if (command === 'balance') {
        const snapshot = await operatorBalance(profile);
        log(values.json ? JSON.stringify(snapshot) : formatBalance(snapshot));
        return snapshot.balanceWei === null && snapshot.mode === 'ledger' ? 1 : 0;
    }
    const observed = await operatorStatus(profile);
    emit(observed);
    return observed.healthy ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exitCode = await main(process.argv.slice(2));
}
