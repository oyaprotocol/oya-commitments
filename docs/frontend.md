# Web Frontend

`frontend/` provides a lightweight UI for entering Safe + Optimistic Governor parameters and generating the same deployment flow as the script. It uses the connected wallet to submit transactions.

## Setup

```shell
cd frontend
npm install
npm run dev
```

## Environment Overrides

Set `VITE_MODULE_PROXY_FACTORY` before starting or building the UI to prefill the factory address. See the [frontend configuration guide](../frontend/README.md#environment-variables) for local setup.
