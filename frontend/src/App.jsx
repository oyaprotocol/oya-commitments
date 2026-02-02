import { useEffect, useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
  hexToSignature,
  isAddress,
  numberToHex,
  signatureToHex,
  stringToHex,
  zeroAddress,
} from 'viem';
import { usePublicClient, useWalletClient } from 'wagmi';

const safeProxyFactoryAbi = [
  {
    type: 'function',
    name: 'createProxyWithNonce',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
];

const moduleProxyFactoryAbi = [
  {
    type: 'function',
    name: 'deployModule',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'masterCopy', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
];

const safeAbi = [
  {
    type: 'function',
    name: 'setup',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getTransactionHash',
    stateMutability: 'view',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'addOwnerWithThreshold',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: '_threshold', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeOwner',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'prevOwner', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: '_threshold', type: 'uint256' },
    ],
    outputs: [],
  },
];

const enableModuleAbi = [
  {
    type: 'function',
    name: 'enableModule',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'module', type: 'address' }],
    outputs: [],
  },
];

const ogSetupAbi = [
  {
    type: 'function',
    name: 'setUp',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'initParams', type: 'bytes' }],
    outputs: [],
  },
];

const MODULE_PROXY_FACTORY_BYTECODE =
  '0x60808060405234610016576102e4908161001b8239f35b5f80fdfe60806040526004361015610011575f80fd5b5f3560e01c63f1ab873c14610024575f80fd5b346100ce5760603660031901126100ce576004356001600160a01b03811681036100ce5760243567ffffffffffffffff81116100ce57366023820112156100ce5780600401359161007483610129565b6100816040519182610107565b83815236602485850101116100ce575f6020856100ca9660246100b09701838601378301015260443591610174565b6040516001600160a01b0390911681529081906020820190565b0390f35b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b6060810190811067ffffffffffffffff82111761010257604052565b6100d2565b90601f8019910116810190811067ffffffffffffffff82111761010257604052565b67ffffffffffffffff811161010257601f01601f191660200190565b3d1561016f573d9061015682610129565b916101646040519384610107565b82523d5f602084013e565b606090565b90929183519060208501918220604091825190602082019283528382015282815261019e816100e6565b5190206001600160a01b0384811694909190851561029657835172602d8060093d393df3363d3d373d3d3d363d7360681b6020820190815260609290921b6bffffffffffffffffffffffff191660338201526e5af43d82803e903d91602b57fd5bf360881b604782015260368152610215816100e6565b51905ff590811692831561027457815f92918380939951925af1610237610145565b501561026457507f2150ada912bf189ed721c44211199e270903fc88008c2a1e1e889ef30fe67c5f5f80a3565b51637dabd39960e01b8152600490fd5b50905163371e9e8960e21b81526001600160a01b039091166004820152602490fd5b8351633202e20d60e21b815260048101879052602490fdfea26469706673582212208f37f4bfb66727d4e6c07c613af0febf39dcd35dcf8d6037c9da73384d61b55764736f6c63430008170033';

function readEnv(key) {
  if (typeof process !== 'undefined' && process?.env?.[key]) {
    return process.env[key];
  }

  if (typeof import.meta !== 'undefined') {
    const metaEnv = import.meta?.env;
    if (metaEnv?.[key]) {
      return metaEnv[key];
    }
  }

  return undefined;
}

function readEnvWithPrefixes(key) {
  return readEnv(key) ?? readEnv(`VITE_${key}`) ?? readEnv(`NEXT_PUBLIC_${key}`);
}

const defaultModuleProxyFactory = readEnvWithPrefixes('MODULE_PROXY_FACTORY') ?? '';

const defaults = {
  safeSingleton: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
  safeProxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  safeFallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  ogMasterCopy: '0x28CeBFE94a03DbCA9d17143e9d2Bd1155DC26D5d',
  ogIdentifier: 'ASSERT_TRUTH2',
  ogLiveness: '172800',
  collateral: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  bondAmount: (250n * 10n ** 6n).toString(),
  safeSaltNonce: '1',
  ogSaltNonce: '1',
  moduleProxyFactory: defaultModuleProxyFactory,
};

const zeroLike = '0x0000000000000000000000000000000000000000';
const BURN_OWNER = '0x000000000000000000000000000000000000dEaD';
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001';

function App() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [form, setForm] = useState({
    rules: '',
    collateral: defaults.collateral,
    bondAmount: defaults.bondAmount,
    liveness: defaults.ogLiveness,
    identifier: defaults.ogIdentifier,
    safeSaltNonce: defaults.safeSaltNonce,
    ogSaltNonce: defaults.ogSaltNonce,
    safeSingleton: defaults.safeSingleton,
    safeProxyFactory: defaults.safeProxyFactory,
    safeFallbackHandler: defaults.safeFallbackHandler,
    ogMasterCopy: defaults.ogMasterCopy,
    moduleProxyFactory: defaults.moduleProxyFactory,
  });
  const [deployment, setDeployment] = useState({
    moduleProxyFactory: '',
    safe: '',
    ogModule: '',
  });
  const [txHashes, setTxHashes] = useState({
    moduleProxyFactory: '',
    safeProxy: '',
    ogModule: '',
    enableModule: '',
  });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isConnected = Boolean(walletClient?.account?.address);

  const missingWallet = !isConnected || !publicClient;

  const onChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const validatedAddresses = useMemo(() => {
    const required = {
      collateral: form.collateral,
      safeSingleton: form.safeSingleton,
      safeProxyFactory: form.safeProxyFactory,
      safeFallbackHandler: form.safeFallbackHandler,
      ogMasterCopy: form.ogMasterCopy,
    };
    const optional = {
      moduleProxyFactory: form.moduleProxyFactory,
    };
    const invalid = Object.entries(required).filter(([, value]) => !isAddress(value || ''));
    const invalidOptional = Object.entries(optional).filter(([, value]) => value && !isAddress(value));
    return { invalid, invalidOptional };
  }, [form]);

  const handleDeploy = async () => {
    if (missingWallet) {
      setError('Connect a wallet to deploy.');
      return;
    }

    if (!form.rules.trim()) {
      setError('OG rules are required.');
      return;
    }

    if (!form.collateral.trim()) {
      setError('Collateral address is required.');
      return;
    }

    if (!form.bondAmount.trim()) {
      setError('Bond amount is required.');
      return;
    }

    if (!form.liveness.trim()) {
      setError('Liveness is required.');
      return;
    }

    if (validatedAddresses.invalid.length || validatedAddresses.invalidOptional.length) {
      setError('One or more addresses are invalid.');
      return;
    }

    setIsSubmitting(true);
    setError('');
    setStatus('Preparing deployment...');
    setDeployment({ moduleProxyFactory: '', safe: '', ogModule: '' });
    setTxHashes({ moduleProxyFactory: '', safeProxy: '', ogModule: '', enableModule: '' });

    try {
      const account = walletClient.account.address;
      const safeSaltNonce = BigInt(form.safeSaltNonce || '0');
      const ogSaltNonce = BigInt(form.ogSaltNonce || '0');
      const bondAmount = BigInt(form.bondAmount || '0');
      const liveness = BigInt(form.liveness || '0');
      const identifier = stringToHex(form.identifier, { size: 32 });
      let moduleProxyFactory = form.moduleProxyFactory;

      if (!moduleProxyFactory) {
        setStatus('Deploying ModuleProxyFactory...');
        const deployTx = await walletClient.deployContract({
          abi: moduleProxyFactoryAbi,
          bytecode: MODULE_PROXY_FACTORY_BYTECODE,
          account,
        });
        setTxHashes((prev) => ({ ...prev, moduleProxyFactory: deployTx }));
        const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
        moduleProxyFactory = receipt.contractAddress ?? '';
        setForm((prev) => ({ ...prev, moduleProxyFactory }));
      }

      const safeInitializer = encodeFunctionData({
        abi: safeAbi,
        functionName: 'setup',
        args: [
          [account],
          1n,
          zeroAddress,
          '0x',
          form.safeFallbackHandler,
          zeroAddress,
          0n,
          zeroAddress,
        ],
      });

      setStatus('Deploying Safe proxy...');
      const safeSimulation = await publicClient.simulateContract({
        account,
        address: form.safeProxyFactory,
        abi: safeProxyFactoryAbi,
        functionName: 'createProxyWithNonce',
        args: [form.safeSingleton, safeInitializer, safeSaltNonce],
      });
      const safeTxHash = await walletClient.writeContract(safeSimulation.request);
      setTxHashes((prev) => ({ ...prev, safeProxy: safeTxHash }));
      await publicClient.waitForTransactionReceipt({ hash: safeTxHash });
      const safeProxy = safeSimulation.result;

      setStatus('Deploying Optimistic Governor module...');
      const ogInitParams = encodeAbiParameters(
        [
          { name: 'owner', type: 'address' },
          { name: 'collateral', type: 'address' },
          { name: 'bondAmount', type: 'uint256' },
          { name: 'rules', type: 'string' },
          { name: 'identifier', type: 'bytes32' },
          { name: 'liveness', type: 'uint64' },
        ],
        [safeProxy, form.collateral, bondAmount, form.rules, identifier, liveness]
      );

      const ogInitializerCall = encodeFunctionData({
        abi: ogSetupAbi,
        functionName: 'setUp',
        args: [ogInitParams],
      });

      const ogSimulation = await publicClient.simulateContract({
        account,
        address: moduleProxyFactory,
        abi: moduleProxyFactoryAbi,
        functionName: 'deployModule',
        args: [form.ogMasterCopy, ogInitializerCall, ogSaltNonce],
      });
      const ogTxHash = await walletClient.writeContract(ogSimulation.request);
      setTxHashes((prev) => ({ ...prev, ogModule: ogTxHash }));
      await publicClient.waitForTransactionReceipt({ hash: ogTxHash });
      const ogModule = ogSimulation.result;

      setStatus('Signing Safe enableModule transaction...');
      const safeNonce = await publicClient.readContract({
        address: safeProxy,
        abi: safeAbi,
        functionName: 'nonce',
      });

      const enableModuleCallData = encodeFunctionData({
        abi: enableModuleAbi,
        functionName: 'enableModule',
        args: [ogModule],
      });

      const txHash = await publicClient.readContract({
        address: safeProxy,
        abi: safeAbi,
        functionName: 'getTransactionHash',
        args: [
          safeProxy,
          0n,
          enableModuleCallData,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          safeNonce,
        ],
      });

      const signature = await walletClient.signMessage({ message: { raw: txHash } });
      const { r, s, v } = hexToSignature(signature);
      const safeV = (v >= 27n ? v : v + 27n) + 4n; // eth_sign flavor
      const packedSignature = concatHex([r, s, numberToHex(safeV, { size: 1 })]);

      setStatus('Enabling module on the Safe...');
      const execSimulation = await publicClient.simulateContract({
        account,
        address: safeProxy,
        abi: safeAbi,
        functionName: 'execTransaction',
        args: [
          safeProxy,
          0n,
          enableModuleCallData,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          packedSignature,
        ],
      });

      const enableTxHash = await walletClient.writeContract(execSimulation.request);
      setTxHashes((prev) => ({ ...prev, enableModule: enableTxHash }));
      await publicClient.waitForTransactionReceipt({ hash: enableTxHash });

      setStatus('Setting burn address as sole Safe owner...');
      const addOwnerCallData = encodeFunctionData({
        abi: safeAbi,
        functionName: 'addOwnerWithThreshold',
        args: [BURN_OWNER, 1n],
      });

      const addOwnerNonce = await publicClient.readContract({
        address: safeProxy,
        abi: safeAbi,
        functionName: 'nonce',
      });

      const addOwnerTxHash = await publicClient.readContract({
        address: safeProxy,
        abi: safeAbi,
        functionName: 'getTransactionHash',
        args: [
          safeProxy,
          0n,
          addOwnerCallData,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          addOwnerNonce,
        ],
      });

      const addOwnerSignature = await walletClient.signMessage({ message: { raw: addOwnerTxHash } });
      const { r: addOwnerR, s: addOwnerS, v: addOwnerVRaw } = hexToSignature(addOwnerSignature);
      const addOwnerV = (addOwnerVRaw >= 27n ? addOwnerVRaw : addOwnerVRaw + 27n) + 4n;
      const addOwnerPackedSignature = concatHex([
        addOwnerR,
        addOwnerS,
        numberToHex(addOwnerV, { size: 1 }),
      ]);

      const addOwnerExec = await publicClient.simulateContract({
        account,
        address: safeProxy,
        abi: safeAbi,
        functionName: 'execTransaction',
        args: [
          safeProxy,
          0n,
          addOwnerCallData,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          addOwnerPackedSignature,
        ],
      });

      const addOwnerTx = await walletClient.writeContract(addOwnerExec.request);
      await publicClient.waitForTransactionReceipt({ hash: addOwnerTx });

      setStatus('Removing deployer from Safe owners...');
      const removeOwnerCallData = encodeFunctionData({
        abi: safeAbi,
        functionName: 'removeOwner',
        args: [SENTINEL_OWNERS, account, 1n],
      });

      const removeOwnerNonce = await publicClient.readContract({
        address: safeProxy,
        abi: safeAbi,
        functionName: 'nonce',
      });

      const removeOwnerTxHash = await publicClient.readContract({
        address: safeProxy,
        abi: safeAbi,
        functionName: 'getTransactionHash',
        args: [
          safeProxy,
          0n,
          removeOwnerCallData,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          removeOwnerNonce,
        ],
      });

      const removeOwnerSignature = await walletClient.signMessage({ message: { raw: removeOwnerTxHash } });
      const { r: removeOwnerR, s: removeOwnerS, v: removeOwnerVRaw } = hexToSignature(removeOwnerSignature);
      const removeOwnerV = (removeOwnerVRaw >= 27n ? removeOwnerVRaw : removeOwnerVRaw + 27n) + 4n;
      const removeOwnerPackedSignature = concatHex([
        removeOwnerR,
        removeOwnerS,
        numberToHex(removeOwnerV, { size: 1 }),
      ]);

      const removeOwnerExec = await publicClient.simulateContract({
        account,
        address: safeProxy,
        abi: safeAbi,
        functionName: 'execTransaction',
        args: [
          safeProxy,
          0n,
          removeOwnerCallData,
          0,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          removeOwnerPackedSignature,
        ],
      });

      const removeOwnerTx = await walletClient.writeContract(removeOwnerExec.request);
      await publicClient.waitForTransactionReceipt({ hash: removeOwnerTx });

      setDeployment({
        moduleProxyFactory,
        safe: safeProxy,
        ogModule,
      });
      setStatus('Deployment complete (burn address is sole Safe owner).');
    } catch (err) {
      setError(err?.shortMessage || err?.message || 'Deployment failed.');
      setStatus('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">OG Deployer</p>
          <h1>Deploy Safe + Optimistic Governor</h1>
          <p className="subtext">
            Mirrors the <code>DeploySafeWithOptimisticGovernor.s.sol</code> flow with UI-driven parameters.
          </p>
        </div>
        <ConnectButton />
      </header>

      <section className="card">
        <h2>Governance Parameters</h2>
        <div className="grid">
          <label>
            OG Rules
            <textarea name="rules" value={form.rules} onChange={onChange} rows={4} />
          </label>
          <label>
            Collateral Address
            <input name="collateral" value={form.collateral} onChange={onChange} placeholder="0x..." />
          </label>
          <label>
            Bond Amount (uint256)
            <input name="bondAmount" value={form.bondAmount} onChange={onChange} placeholder="1000000000000000000" />
          </label>
          <label>
            Liveness (seconds)
            <input name="liveness" value={form.liveness} onChange={onChange} />
          </label>
          <label>
            Identifier String
            <input name="identifier" value={form.identifier} onChange={onChange} />
          </label>
          <label>
            Safe Salt Nonce
            <input name="safeSaltNonce" value={form.safeSaltNonce} onChange={onChange} />
          </label>
          <label>
            OG Salt Nonce
            <input name="ogSaltNonce" value={form.ogSaltNonce} onChange={onChange} />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Safe / OG Overrides</h2>
        <div className="grid">
          <label>
            Safe Singleton
            <input name="safeSingleton" value={form.safeSingleton} onChange={onChange} />
          </label>
          <label>
            Safe Proxy Factory
            <input name="safeProxyFactory" value={form.safeProxyFactory} onChange={onChange} />
          </label>
          <label>
            Safe Fallback Handler
            <input name="safeFallbackHandler" value={form.safeFallbackHandler} onChange={onChange} />
          </label>
          <label>
            OG Master Copy
            <input name="ogMasterCopy" value={form.ogMasterCopy} onChange={onChange} />
          </label>
          <label>
            Module Proxy Factory
            <input name="moduleProxyFactory" value={form.moduleProxyFactory} onChange={onChange} placeholder="0x..." />
            <span className="hint">Required unless you deploy a ModuleProxyFactory separately.</span>
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Deployment</h2>
        <div className="actions">
          <button type="button" onClick={handleDeploy} disabled={isSubmitting}>
            {isSubmitting ? 'Deploying…' : 'Deploy Safe + OG'}
          </button>
          <div className="status">
            {status && <p>{status}</p>}
            {error && <p className="error">{error}</p>}
            {missingWallet && <p className="hint">Connect a wallet and select the target network.</p>}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Outputs</h2>
        <div className="outputs">
          <div>
            <span>ModuleProxyFactory</span>
            <code>{deployment.moduleProxyFactory || zeroLike}</code>
          </div>
          <div>
            <span>Safe</span>
            <code>{deployment.safe || zeroLike}</code>
          </div>
          <div>
            <span>Optimistic Governor Module</span>
            <code>{deployment.ogModule || zeroLike}</code>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Transaction Hashes</h2>
        <div className="outputs">
          <div>
            <span>Safe Proxy Deployment</span>
            <code>{txHashes.safeProxy || '-'}</code>
          </div>
          <div>
            <span>OG Module Deployment</span>
            <code>{txHashes.ogModule || '-'}</code>
          </div>
          <div>
            <span>Enable Module</span>
            <code>{txHashes.enableModule || '-'}</code>
          </div>
        </div>
      </section>

    </div>
  );
}

export default App;
