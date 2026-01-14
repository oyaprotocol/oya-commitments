import React from 'react';
import ReactDOM from 'react-dom/client';
import { RainbowKitProvider, getDefaultWallets } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import {
  arbitrum,
  base,
  mainnet,
  optimism,
  sepolia,
} from 'wagmi/chains';
import '@rainbow-me/rainbowkit/styles.css';
import './styles.css';
import App from './App.jsx';

const chains = [mainnet, optimism, arbitrum, base, sepolia];

const { connectors } = getDefaultWallets({
  appName: 'OG Deployer',
  projectId: 'og-deployer',
});

const config = createConfig({
  chains,
  connectors,
  transports: chains.reduce((acc, chain) => {
    acc[chain.id] = http();
    return acc;
  }, {}),
});

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider chains={chains}>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);
