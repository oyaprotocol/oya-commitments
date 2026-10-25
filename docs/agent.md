# Run a commitment-serving agent

The shared runner in `agent/` monitors a commitment and loads decision logic from `agent-library/agents/<name>/`. Use this path to serve a Safe/Optimistic Governor commitment. To run a publication node that accepts signed messages and publishes to IPFS, use [node setup](../node/production/deploy-with-agent.md).

## Choose and configure a module

1. Choose an existing module from the [agent library](../agent-library/README.md), or follow its [new-module workflow](../agent-library/README.md#building-a-new-agentic-commitment). Read the selected module's configuration and instructions before live use.
2. Install the runner dependencies and configure signing using the [runner setup reference](../agent/README.md#configure). Select the module with `AGENT_MODULE`. RPC access and a funded signer are required for live proposals; some modules need additional service credentials.
3. Put non-secret behavior in the module's `config.json`. Use `byChain.<chainId>.commitmentSafe` and `byChain.<chainId>.ogModule` for deployed commitment addresses, and `watchAssets` for the asset watchlist. The [configuration reference](../agent/README.md#agent-modules--commitments) explains overrides, defaults, and local-only settings. The old `COMMITMENT_SAFE`, `OG_MODULE`, and `WATCH_ASSETS` environment setup is superseded by this config stack.
4. Validate and smoke-test the module with the [local harness](../agent-library/README.md#building-a-new-agentic-commitment) before starting it against a live commitment. Keep private keys and API tokens in the supported secret store or ignored environment file, outside committed module configuration.

## Start the configured runner

After completing the setup above, run from the repository root:

```sh
npm --prefix agent start
```

Starting an agent may submit transactions according to the selected module and configuration. Use the module's documented test profile when you want a local simulation. [Signer options](signers.md) and the [extension policy](agent-extension-guidelines.md) cover credential choices and where new behavior belongs.

## Runner reference

See [What the agent does](../agent/README.md#what-the-agent-does) for signals, tools, proposal handling, and optional message APIs. Individual modules decide which of those capabilities to use. Creating a module, deploying its commitment, and running its agent are separate steps.
