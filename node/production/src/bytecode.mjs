// Only an empty byte string means no contract; malformed RPC data must not trigger deployment.
export function hasBytecode(code) {
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error('Invalid bytecode.');
    return code !== '0x';
}
