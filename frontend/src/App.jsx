import { useMemo, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import {
  encodeAbiParameters,
  encodeFunctionData,
  hexToSignature,
  isAddress,
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

const defaults = {
  safeSingleton: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
  safeProxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  safeFallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  ogMasterCopy: '0x28CeBFE94a03DbCA9d17143e9d2Bd1155DC26D5d',
  ogIdentifier: 'ASSERT_TRUTH2',
  ogLiveness: '172800',
  safeSaltNonce: '1',
  ogSaltNonce: '1',
};

const zeroLike = '0x0000000000000000000000000000000000000000';

function App() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [form, setForm] = useState({
    rules: '',
    collateral: '',
    bondAmount: '',
    liveness: defaults.ogLiveness,
    identifier: defaults.ogIdentifier,
    safeSaltNonce: defaults.safeSaltNonce,
    ogSaltNonce: defaults.ogSaltNonce,
    safeSingleton: defaults.safeSingleton,
    safeProxyFactory: defaults.safeProxyFactory,
    safeFallbackHandler: defaults.safeFallbackHandler,
    ogMasterCopy: defaults.ogMasterCopy,
    moduleProxyFactory: '',
  });
  const [deployment, setDeployment] = useState({
    moduleProxyFactory: '',
    safe: '',
    ogModule: '',
  });
  const [txHashes, setTxHashes] = useState({
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

    if (!form.moduleProxyFactory) {
      setError('ModuleProxyFactory address is required (deploy one externally or set MODULE_PROXY_FACTORY).');
      return;
    }

    setIsSubmitting(true);
    setError('');
    setStatus('Preparing deployment...');
    setDeployment({ moduleProxyFactory: '', safe: '', ogModule: '' });
    setTxHashes({ safeProxy: '', ogModule: '', enableModule: '' });

    try {
      const account = walletClient.account.address;
      const safeSaltNonce = BigInt(form.safeSaltNonce || '0');
      const ogSaltNonce = BigInt(form.ogSaltNonce || '0');
      const bondAmount = BigInt(form.bondAmount || '0');
      const liveness = BigInt(form.liveness || '0');
      const identifier = stringToHex(form.identifier, { size: 32 });

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
        address: form.moduleProxyFactory,
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
      const packedSignature = signatureToHex({ r, s, v });

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

      setDeployment({
        moduleProxyFactory: form.moduleProxyFactory,
        safe: safeProxy,
        ogModule,
      });
      setStatus('Deployment complete.');
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
