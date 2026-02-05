# Web Frontend

`frontend/` provides a lightweight UI for entering Safe + Optimistic Governor parameters and generating the same deployment flow as the script. It uses the connected wallet to submit transactions.

## Setup

```shell
cd frontend
npm install
npm run dev
```

## Environment Overrides

The UI supports `MODULE_PROXY_FACTORY` (optionally with `VITE_` or `NEXT_PUBLIC_` prefixes). Other defaults are currently hardcoded in `frontend/src/App.jsx` and can be edited there or wired to env vars.
