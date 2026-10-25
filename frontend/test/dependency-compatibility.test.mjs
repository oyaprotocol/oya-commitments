import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Resolve through the consumers so nested dependency copies are exercised too.
const require = createRequire(import.meta.url);
const connectorsRequire = createRequire(require.resolve('@wagmi/connectors'));
const providerRequire = createRequire(connectorsRequire.resolve('@walletconnect/ethereum-provider'));
const appkitRequire = createRequire(providerRequire.resolve('@reown/appkit'));
const cdpRequire = createRequire(require.resolve('@coinbase/cdp-sdk'));

for (const [consumer, consumerRequire] of [
  ['WalletConnect', providerRequire],
  ['Reown', appkitRequire],
]) {
  test(`${consumer} pairing URIs preserve encoded relay data with the updated parser`, () => {
    const { formatUri, parseUri } = consumerRequire('@walletconnect/utils');
    const pairing = {
      protocol: 'wc',
      version: 2,
      topic: 'a'.repeat(64),
      symKey: '0'.repeat(64), // Public, all-zero test fixture; never used for a session.
      relay: { protocol: 'irn', data: 'space + unicode ✓ & percent %' },
      expiryTimestamp: 2000000000,
    };
    const decoded = parseUri(formatUri(pairing));
    for (const key of ['version', 'topic', 'symKey', 'relay', 'expiryTimestamp']) {
      assert.deepEqual(decoded[key], pairing[key]);
    }
  });

  test(`${consumer} decodes malformed percent sequences without stalling`, () => {
    // Isolate synchronous decoding so the timeout can stop a regressed decoder.
    const output = execFileSync(process.execPath, ['-e', `
      const { parseUri } = require(process.argv[1]);
      for (const malformed of ['%FF'.repeat(256), '%E0%A4'.repeat(256)]) {
        parseUri('wc:fixture@2?relay-protocol=irn&relay-data=' + malformed);
      }
      process.stdout.write('decoded');
    `, consumerRequire.resolve('@walletconnect/utils')], {
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(output, 'decoded');
  });
}

test('Reown wallet events accept valid messages and reject invalid payloads with Zod 4', async () => {
  const { W3mFrameSchema, W3mFrameConstants } = await import(
    pathToFileURL(appkitRequire.resolve('@reown/appkit-wallet'))
  );
  const theme = {
    type: W3mFrameConstants.APP_SYNC_THEME,
    payload: { themeMode: 'dark', themeVariables: { accent: '#123456', radius: 4 } },
  };
  assert.deepEqual(W3mFrameSchema.appEvent.parse(theme), theme);
  assert.equal(W3mFrameSchema.appEvent.safeParse({
    ...theme, payload: { themeVariables: { radius: {} } },
  }).success, false);
  const chain = {
    type: W3mFrameConstants.FRAME_GET_CHAIN_ID_SUCCESS,
    payload: { chainId: 'eip155:1' },
  };
  assert.deepEqual(W3mFrameSchema.frameEvent.parse(chain), chain);
  assert.equal(W3mFrameSchema.frameEvent.safeParse({
    ...chain, payload: { chainId: null },
  }).success, false);
});

for (const format of ['ESM', 'CommonJS']) {
  const load = async (file) => format === 'ESM'
    ? import(new URL(`./policies/${file}.js`, import.meta.resolve('@coinbase/cdp-sdk')))
    : cdpRequire(`./policies/${file}.js`);

  test(`Coinbase ${format} preserves typed-data policy validation with Zod 4`, async () => {
    const { CreatePolicyBodySchema } = await load('types');
    const criterion = {
      type: 'evmTypedDataField',
      types: { types: { Mail: [{ name: 'contents', type: 'string' }] }, primaryType: 'Mail' },
      conditions: [{ path: 'contents', match: '^hello$' }],
    };
    const policy = {
      scope: 'account',
      rules: [{ action: 'accept', operation: 'signEvmTypedData', criteria: [criterion] }],
    };
    assert.deepEqual(CreatePolicyBodySchema.parse(policy), policy);
    for (const invalidTypes of [{ Mail: 'not an array' }, { Mail: [{ name: 42, type: 'string' }] }]) {
      const invalid = structuredClone(policy);
      invalid.rules[0].criteria[0].types.types = invalidTypes;
      assert.equal(CreatePolicyBodySchema.safeParse(invalid).success, false);
    }
    const invalid = structuredClone(policy);
    invalid.rules[0].action = 'unknown';
    assert.equal(CreatePolicyBodySchema.safeParse(invalid).success, false);
  });

  test(`Coinbase ${format} bounds oversized policy arrays before validating entries`, async () => {
    const { CreatePolicyBodySchema, MAX_POLICY_RULES } = await load('types');
    const result = CreatePolicyBodySchema.safeParse({
      scope: 'account', rules: Array(MAX_POLICY_RULES + 1).fill({}),
    });
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    assert.equal(result.error.issues[0].code, 'too_big');
    assert.deepEqual(result.error.issues[0].path, ['rules']);
  });
}

test('Coinbase ABI schemas retain address, function, and typed-data validation', () => {
  const { Abi, Address, TypedData } = cdpRequire('abitype/zod');
  assert.equal(Address.safeParse('0x' + '11'.repeat(20)).success, true);
  assert.equal(Address.safeParse('not-an-address').success, false);
  const abi = [{
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  }];
  assert.deepEqual(Abi.parse(abi), abi);
  assert.equal(Abi.safeParse([{ ...abi[0], inputs: [{ type: 'invalid' }] }]).success, false);
  assert.equal(TypedData.safeParse({ Mail: [{ name: 'contents', type: 'string' }] }).success, true);
  assert.equal(TypedData.safeParse({ Mail: [{ name: 'contents', type: 'MissingType' }] }).success, false);
});

test('RainbowKit still constructs the default wallet connectors', async () => {
  const { getDefaultWallets } = await import('@rainbow-me/rainbowkit');
  const { connectors, wallets } = getDefaultWallets({
    appName: 'Dependency compatibility test', projectId: 'offline-test',
  });
  assert.ok(connectors.length > 0);
  assert.ok(connectors.every(connector => typeof connector === 'function'));
  const walletIds = wallets.flatMap(group => group.wallets.map(wallet => wallet({
    appName: 'Dependency compatibility test', projectId: 'offline-test',
  }).id));
  for (const id of ['safe', 'rainbow', 'baseAccount', 'metaMask', 'walletConnect']) {
    assert.ok(walletIds.includes(id), `Missing default wallet: ${id}`);
  }
});
