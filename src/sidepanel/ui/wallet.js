/**
 * Real Wallet connectivity and state management based on x402-Project & Lute-Connect:
 * https://github.com/marotipatre/x402-Project
 * https://github.com/GalaxyPay/lute-connect
 *
 * Supported Wallets:
 *   - Lute Wallet (via official Lute-Connect protocol: https://lute.app/connect)
 *   - Pera Wallet (via window.pera / window.algorand / Pera Web)
 *   - Defly Wallet (via window.defly / window.algorand)
 *   - Exodus Wallet (via window.exodus.algorand / window.algorand)
 *   - KMD / LocalNet (local Algorand node)
 */

import { els } from '../core/dom.js';
import { icon } from '../lib/icons.js';
import { flashHint, setHint } from './hint.js';
import {
  autoPayEnabled,
  autoPayConfigured,
  autoPayAddress,
  autoPayProblem,
  setAutoPayEnabled,
  userSeedSet,
  userSeedAddress,
  setUserSeed,
  clearUserSeed
} from '../payments/auto-pay.js';

export const NETWORKS = {
  testnet: {
    id: 'testnet',
    name: 'Algorand TestNet',
    genesisID: 'testnet-v1.0',
    algodUrl: 'https://testnet-api.algonode.cloud',
    usdcAssetId: 10458941,
    explorerUrl: 'https://lora.algokit.io/testnet/account/',
    peraExplorerUrl: 'https://testnet.explorer.perawallet.app/accounts/',
    faucetUrl: 'https://lora.algokit.io/testnet/fund'
  },
  mainnet: {
    id: 'mainnet',
    name: 'Algorand MainNet',
    genesisID: 'mainnet-v1.0',
    algodUrl: 'https://mainnet-api.algonode.cloud',
    usdcAssetId: 31566704,
    explorerUrl: 'https://lora.algokit.io/mainnet/account/',
    peraExplorerUrl: 'https://explorer.perawallet.app/accounts/',
    faucetUrl: null
  },
  localnet: {
    id: 'localnet',
    name: 'Algorand LocalNet (KMD)',
    genesisID: 'sandnet-v1.0',
    algodUrl: 'http://localhost:4001',
    kmdUrl: 'http://localhost:4002',
    usdcAssetId: 0,
    explorerUrl: 'https://lora.algokit.io/localnet/account/',
    peraExplorerUrl: '',
    faucetUrl: null
  }
};

export const SUPPORTED_WALLETS = [
  {
    id: 'lute',
    name: 'Lute Wallet',
    letter: 'L',
    iconClass: 'wallet-icon-lute',
    tag: 'Web & Extension',
    desc: 'Connect to your existing accounts on Lute (lute.app)',
    url: 'https://lute.app/connect'
  },
  {
    id: 'pera',
    name: 'Pera Wallet',
    letter: 'P',
    iconClass: 'wallet-icon-pera',
    tag: 'Official',
    desc: 'Official Algorand mobile & web wallet (Pera Web)',
    url: 'https://web.perawallet.app'
  },
  {
    id: 'defly',
    name: 'Defly Wallet',
    letter: 'D',
    iconClass: 'wallet-icon-defly',
    tag: 'DeFi',
    desc: 'Algorand DeFi & micropayment mobile wallet',
    url: 'https://defly.app'
  },
  {
    id: 'exodus',
    name: 'Exodus',
    letter: 'E',
    iconClass: 'wallet-icon-exodus',
    tag: 'Web3',
    desc: 'Multi-asset Web3 browser wallet',
    url: 'https://www.exodus.com'
  },
  {
    id: 'kmd',
    name: 'KMD / LocalNet',
    letter: '⚡',
    iconClass: 'wallet-icon-kmd',
    tag: 'DevNet',
    desc: 'Connect to local Algorand KMD node instance',
    url: 'http://localhost:4002'
  }
];

export const walletState = {
  connected: false,
  providerId: null,
  providerName: '',
  address: '',
  network: 'testnet', // 'testnet' | 'mainnet' | 'localnet'
  algoBalance: '0.00',
  usdcBalance: '0.00',
  minBalance: '0.10',
  round: null,
  loading: false,
  connectingProvider: null,
  error: null
};

const STORAGE_KEY = 'agent_wallet_session_v4';
const ALGORAND_ADDRESS_REGEX = /^[A-Z2-7]{58}$/;

/**
 * Validate an Algorand public address format
 */
export function isValidAlgorandAddress(addr) {
  if (!addr || typeof addr !== 'string') return false;
  return ALGORAND_ADDRESS_REGEX.test(addr.trim());
}

/**
 * Ellipse an address for display: "2B4X...9K1Z"
 */
export function ellipseAddress(address, prefix = 4, suffix = 4) {
  if (!address) return '';
  const trimmed = address.trim();
  if (trimmed.length <= prefix + suffix) return trimmed;
  return `${trimmed.slice(0, prefix)}…${trimmed.slice(-suffix)}`;
}

/**
 * Initialize wallet from chrome storage and fetch live balances.
 */
export async function initWallet() {
  try {
    const saved = await chrome.storage?.local?.get(STORAGE_KEY);
    if (saved && saved[STORAGE_KEY]?.connected && saved[STORAGE_KEY]?.address) {
      Object.assign(walletState, saved[STORAGE_KEY]);
      await refreshWalletBalance();
    }
  } catch (err) {
    // Retain clean fallback
  }

  renderWalletUI();
}

/**
 * Save active wallet state to persistent storage.
 */
async function saveWalletState() {
  try {
    await chrome.storage?.local?.set({
      [STORAGE_KEY]: {
        connected: walletState.connected,
        providerId: walletState.providerId,
        providerName: walletState.providerName,
        address: walletState.address,
        network: walletState.network,
        algoBalance: walletState.algoBalance,
        usdcBalance: walletState.usdcBalance,
        minBalance: walletState.minBalance
      }
    });
  } catch (err) {
    // Retain clean fallback
  }
}

/**
 * Fetch real on-chain balance from Algorand node for the active address.
 */
export async function refreshWalletBalance() {
  if (!walletState.connected || !walletState.address) return;

  const currentNetwork = NETWORKS[walletState.network] || NETWORKS.testnet;
  const url = `${currentNetwork.algodUrl}/v2/accounts/${walletState.address}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      
      // Real ALGO balance in microAlgos
      if (data.amount != null) {
        walletState.algoBalance = (data.amount / 1_000_000).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4
        });
      }
      
      // Minimum balance required
      if (data['min-balance'] != null) {
        walletState.minBalance = (data['min-balance'] / 1_000_000).toFixed(3);
      }

      walletState.round = data.round;

      // Real USDC ASA balance
      if (Array.isArray(data.assets) && currentNetwork.usdcAssetId) {
        const usdc = data.assets.find((a) => a['asset-id'] === currentNetwork.usdcAssetId);
        if (usdc && usdc.amount != null) {
          walletState.usdcBalance = (usdc.amount / 1_000_000).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          });
        } else {
          walletState.usdcBalance = '0.00 (Opt-in needed)';
        }
      } else {
        walletState.usdcBalance = '0.00';
      }

      await saveWalletState();
    } else if (res.status === 404) {
      walletState.algoBalance = '0.00 (Unfunded)';
      walletState.usdcBalance = '0.00';
    }
  } catch (err) {
    // balance fetch failed silently
  }

  renderWalletUI();
}

/**
 * Official Lute Connect implementation (postMessage protocol)
 */
function requestLuteConnect(genesisID) {
  return new Promise((resolve, reject) => {
    const useExt = window.lute;
    let win;
    const left = 100 + (window.screenX || 0);
    const top = 100 + (window.screenY || 0);
    const params = `width=500,height=750,left=${left},top=${top}`;

    if (useExt) {
      window.dispatchEvent(
        new CustomEvent('lute-connect', {
          detail: { action: 'connect', genesisID }
        })
      );
    } else {
      // Must open https://lute.app/connect
      win = window.open('https://lute.app/connect', 'Sidebar AI', params);
    }

    const type = useExt ? 'connect-response' : 'message';

    const messageHandler = (event) => {
      if (!useExt && event.origin !== 'https://lute.app') return;
      const data = event.data || event.detail;
      if (!data) return;

      // Lute event received

      switch (data.action) {
        case 'ready':
          // Reply with network / genesisID to tell Lute to show account select screen
          win?.postMessage({ action: 'network', genesisID }, '*');
          break;
        case 'connect':
          window.removeEventListener(type, messageHandler);
          if (Array.isArray(data.addrs) && data.addrs.length > 0) {
            resolve(data.addrs[0]);
          } else if (Array.isArray(data.accounts) && data.accounts.length > 0) {
            resolve(typeof data.accounts[0] === 'string' ? data.accounts[0] : data.accounts[0].address);
          } else if (data.addr || data.address) {
            resolve(data.addr || data.address);
          } else {
            reject(new Error('No accounts returned from Lute'));
          }
          break;
        case 'error':
          window.removeEventListener(type, messageHandler);
          reject(new Error(data.message || 'Lute error'));
          break;
        case 'close':
          window.removeEventListener(type, messageHandler);
          reject(new Error('Lute connect cancelled'));
          break;
      }
    };

    window.addEventListener(type, messageHandler);

    // Regularly handshake in case ready was fired before listener
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      if (tries > 45 || !win || win.closed) {
        clearInterval(interval);
        return;
      }
      try {
        win.postMessage({ action: 'network', genesisID }, '*');
      } catch {}
    }, 800);
  });
}

/**
 * Ask Lute to sign, over the same postMessage protocol it connects with.
 *
 * This is the half that was missing, and its absence had no symptom anywhere.
 * `connectWallet` supports Lute two ways: an injected `window.lute` from the
 * browser extension, and — for everyone else — a popup at lute.app/connect that
 * hands back an address over postMessage. `getWalletSigner` only ever knew the
 * first: it looked for an injected object with a `signTxns` method and threw if
 * there was none. So a web-connected Lute showed an address, showed a balance,
 * reported itself connected, and could not sign a single transaction. From the
 * panel that is a run finishing with no wallet prompt at all — reported as
 * exactly that, twice, while every layer either side of it tested green.
 *
 * Mirrors lute-connect 2.0.1 (GalaxyPay/lute-connect) rather than inventing a
 * shape: `/sign` rather than `/connect`, `sign-txns-response` rather than
 * `connect-response`, and the same ready → sign → signed handshake with the
 * same origin guard. Getting any of those wrong is a popup that opens and never
 * answers, which is worse than the failure it replaces.
 *
 * ARC-0001 in, ARC-0001 out: an array of `{txn}` where `txn` is base64 msgpack,
 * answered in the same ORDER — a reordered group has a different group id and
 * the chain rejects it.
 */
function requestLuteSign(txns) {
  return new Promise((resolve, reject) => {
    const useExt = window.lute;
    let win;
    const left = 100 + (window.screenX || 0);
    const top = 100 + (window.screenY || 0);
    const params = `width=500,height=750,left=${left},top=${top}`;

    // What Lute is asked to sign. `signers` is deliberately absent: omitting it
    // means "sign this with whatever account owns it", which is what we want,
    // where an empty array means the opposite — do not sign this one.
    const request = txns.map((txn) => (typeof txn === 'string' ? { txn } : txn));

    if (useExt) {
      window.dispatchEvent(
        new CustomEvent('lute-connect', { detail: { action: 'sign', txns: request } })
      );
    } else {
      win = window.open('https://lute.app/sign', 'Sidebar AI', params);
      if (!win) {
        reject(new Error('Lute could not open — allow pop-ups for this extension and try again.'));
        return;
      }
    }

    const type = useExt ? 'sign-txns-response' : 'message';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(type, messageHandler);
      clearInterval(interval);
      fn(value);
    };

    function messageHandler(event) {
      if (!useExt && event.origin !== 'https://lute.app') return;
      const detail = event.data || event.detail;
      if (!detail) return;

      switch (detail.action) {
        case 'ready':
          // The popup announces itself; the request follows. Repeated below in
          // case `ready` fired before this listener existed.
          win?.postMessage({ action: 'sign', txns: request }, '*');
          break;
        case 'signed':
          finish(resolve, detail.txns);
          break;
        case 'error':
          finish(reject, new Error(detail.message || 'Lute could not sign this'));
          break;
        case 'close':
          finish(reject, new Error('payment declined'));
          break;
      }
    }

    window.addEventListener(type, messageHandler);

    /**
     * Re-handshake, and notice a window the user simply closed.
     *
     * The same belt-and-braces the connect flow carries: `ready` can fire before
     * the listener is attached, and a popup closed with the X sends nothing at
     * all — without this the promise never settles and the run's billing hangs
     * silently forever.
     */
    let tries = 0;
    const interval = setInterval(() => {
      tries += 1;
      if (useExt) return;
      if (win?.closed) {
        finish(reject, new Error('payment declined'));
        return;
      }
      if (tries > 150) {
        finish(reject, new Error('Lute did not answer'));
        return;
      }
      try {
        win?.postMessage({ action: 'sign', txns: request }, '*');
      } catch {
        /* the popup is on another origin until it loads; ignore and retry */
      }
    }, 800);
  });
}

/**
 * Connect to a wallet (Lute, Pera, Defly, Exodus, KMD).
 */
export async function connectWallet(providerId) {
  const provider = SUPPORTED_WALLETS.find((w) => w.id === providerId);
  if (!provider) return;

  walletState.loading = true;
  walletState.connectingProvider = provider;
  walletState.error = null;
  renderWalletUI();

  const currentNetwork = NETWORKS[walletState.network] || NETWORKS.testnet;

  try {
    let resolvedAddress = '';

    // 1. Check for Injected Browser Extension (Lute / Pera / Defly / Exodus)
    const injected = window.algorand || window.exodus?.algorand || window.pera || window.defly || window.lute;
    if (injected && typeof injected.enable === 'function') {
      try {
        const accounts = await injected.enable({
          genesisID: currentNetwork.genesisID
        });
        if (Array.isArray(accounts) && accounts.length > 0) {
          resolvedAddress = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].address;
        } else if (accounts?.address) {
          resolvedAddress = accounts.address;
        }
      } catch (enableErr) {
        // injected wallet not available, continue to web flow
      }
    }

    // 2. If already resolved from extension, finalize
    if (resolvedAddress && isValidAlgorandAddress(resolvedAddress)) {
      await finalizeConnection(provider.id, provider.name, resolvedAddress);
      return;
    }

    // 3. For Lute Wallet: Use official Lute Connect Handshake (https://lute.app/connect)
    if (providerId === 'lute') {
      // Start Lute Connect handshake
      renderLuteConnectStage(provider);

      try {
        const addr = await requestLuteConnect(currentNetwork.genesisID);
        if (addr && isValidAlgorandAddress(addr)) {
          await finalizeConnection(provider.id, provider.name, addr);
        }
      } catch (err) {
        // Lute connect was cancelled or closed
      }
      return;
    }

    // 4. For Pera Wallet: Open Pera Web
    if (providerId === 'pera') {
      const peraUrl = `https://web.perawallet.app`;
      const popup = window.open(peraUrl, 'pera_connect_popup', 'width=520,height=720,menubar=no,status=no,toolbar=no');
      renderWebWalletStage(provider, popup, peraUrl);
      return;
    }

    // 5. For Defly Wallet:
    if (providerId === 'defly') {
      const deflyUrl = `https://defly.app`;
      const popup = window.open(deflyUrl, 'defly_connect_popup', 'width=520,height=720,menubar=no,status=no,toolbar=no');
      renderWebWalletStage(provider, popup, deflyUrl);
      return;
    }

    // 6. For KMD (LocalNet):
    if (providerId === 'kmd') {
      const kmdUrl = NETWORKS.localnet.kmdUrl;
      try {
        const res = await fetch(`${kmdUrl}/v1/wallets`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) {
          walletState.loading = false;
          flashHint('LocalNet KMD not reachable. Please start algokit localnet.', 3500);
          renderWalletUI();
          return;
        }
        const data = await res.json();
        const firstWallet = data.wallets?.[0];
        if (!firstWallet) {
          walletState.loading = false;
          flashHint('No wallets found in local KMD instance.', 3500);
          renderWalletUI();
          return;
        }
        resolvedAddress = firstWallet.id;
        await finalizeConnection(provider.id, provider.name, resolvedAddress);
      } catch (err) {
        walletState.loading = false;
        flashHint('LocalNet KMD not running (http://localhost:4002). Start algokit localnet.', 3500);
        renderWalletUI();
      }
      return;
    }

  } catch (err) {
    walletState.loading = false;
    walletState.error = err.message;
    flashHint(err.message || 'Could not connect wallet', 3500);
    renderWalletUI();
  }
}

/**
 * Finalize wallet connection and save state
 */
export async function finalizeConnection(providerId, providerName, address) {
  walletState.connected = true;
  walletState.providerId = providerId;
  walletState.providerName = providerName;
  walletState.address = address.trim();
  walletState.loading = false;
  walletState.connectingProvider = null;
  walletState.error = null;

  await saveWalletState();
  await refreshWalletBalance();
  flashHint(`Connected to ${providerName} (${ellipseAddress(address)})`, 3000);
  renderWalletUI();
}

/**
 * Render the dedicated Lute Wallet Connect stage (with direct Lute.app/connect flow & quick sync)
 */
function renderLuteConnectStage(provider) {
  if (!els.walletContent) return;

  const currentNetwork = NETWORKS[walletState.network] || NETWORKS.testnet;

  els.walletContent.innerHTML = `
    <div class="wallet-direct-connect-box">
      <div class="wallet-direct-header">
        <div class="wallet-badge-icon ${provider.iconClass}">${provider.letter}</div>
        <div>
          <div class="wallet-direct-title">Connecting to Lute Wallet</div>
          <div class="wallet-direct-desc">Connecting to your account on <strong>lute.app</strong></div>
        </div>
      </div>

      <div class="wallet-lute-status-card">
        <div class="wallet-lute-spinner"></div>
        <div class="wallet-lute-status-text">
          <strong>Lute Connect Ready</strong>
          <span>Select your account in the Lute window to connect, or paste/click below to sync instantly.</span>
        </div>
      </div>

      <div class="wallet-quick-sync-box">
        <label class="wallet-input-label" for="wallet-lute-quick-input">Active Account on Lute (Copy from Lute screen)</label>
        <div class="wallet-sync-input-row">
          <input
            type="text"
            id="wallet-lute-quick-input"
            class="sheet-filter"
            placeholder="Paste your ZYQRMS... address from Lute"
            spellcheck="false"
            autocomplete="off"
          />
          <button class="primary-btn" id="wallet-lute-sync-btn" style="white-space:nowrap;padding:6px 12px;font-size:12px;">
            Connect
          </button>
        </div>
      </div>

      <div class="wallet-direct-actions">
        <button class="wallet-action-btn" id="wallet-lute-reopen">
          ${icon('externalLink', 13)} Re-open Lute Connect
        </button>
        <button class="ghost-btn" id="wallet-lute-cancel">Cancel</button>
      </div>

      <div class="wallet-faucet-hint">
        Active on Lute? Click on your account in Lute (or copy address) to sync instantly!
      </div>
    </div>
  `;

  const cancelBtn = els.walletContent.querySelector('#wallet-lute-cancel');
  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    walletState.loading = false;
    walletState.connectingProvider = null;
    renderWalletSheet();
  });

  const reopenBtn = els.walletContent.querySelector('#wallet-lute-reopen');
  reopenBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    requestLuteConnect(currentNetwork.genesisID).then((addr) => {
      if (addr) finalizeConnection(provider.id, provider.name, addr);
    }).catch(() => {});
  });

  // Quick sync input
  const quickInput = els.walletContent.querySelector('#wallet-lute-quick-input');
  const syncBtn = els.walletContent.querySelector('#wallet-lute-sync-btn');

  const doQuickSync = () => {
    const val = quickInput?.value?.trim().toUpperCase();
    if (val && isValidAlgorandAddress(val)) {
      finalizeConnection(provider.id, provider.name, val);
    } else {
      flashHint('Please paste a valid 58-character Algorand address from Lute', 2500);
    }
  };

  syncBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    doQuickSync();
  });

  quickInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doQuickSync();
    }
  });

  // Try auto-reading clipboard if user just copied the address from Lute
  navigator.clipboard?.readText?.().then((text) => {
    const trimmed = text?.trim()?.toUpperCase();
    if (trimmed && isValidAlgorandAddress(trimmed) && quickInput) {
      quickInput.value = trimmed;
    }
  }).catch(() => {});
}

/**
 * Render generic Web Wallet stage (Pera Web / Defly)
 */
function renderWebWalletStage(provider, popupWindow, url) {
  if (!els.walletContent) return;

  els.walletContent.innerHTML = `
    <div class="wallet-direct-connect-box">
      <div class="wallet-direct-header">
        <div class="wallet-badge-icon ${provider.iconClass}">${provider.letter}</div>
        <div>
          <div class="wallet-direct-title">Connecting to ${provider.name}</div>
          <div class="wallet-direct-desc">Opening wallet portal to connect your existing accounts</div>
        </div>
      </div>

      <div class="wallet-lute-status-card">
        <div class="wallet-lute-spinner"></div>
        <div class="wallet-lute-status-text">
          <strong>${provider.name} Window Open</strong>
          <span>Approve the connection in your wallet to finish.</span>
        </div>
      </div>

      <div class="wallet-direct-actions">
        <button class="wallet-action-btn" id="wallet-web-reopen">
          ${icon('externalLink', 13)} Re-open ${provider.name}
        </button>
        <button class="ghost-btn" id="wallet-web-cancel">Cancel</button>
      </div>
    </div>
  `;

  const cancelBtn = els.walletContent.querySelector('#wallet-web-cancel');
  cancelBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    walletState.loading = false;
    walletState.connectingProvider = null;
    renderWalletSheet();
  });

  const reopenBtn = els.walletContent.querySelector('#wallet-web-reopen');
  reopenBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(url, `${provider.id}_connect_popup`, 'width=520,height=720,menubar=no,status=no,toolbar=no');
  });
}

/**
 * Disconnect active wallet.
 */
export async function disconnectWallet() {
  walletState.connected = false;
  walletState.providerId = null;
  walletState.providerName = '';
  walletState.address = '';
  walletState.algoBalance = '0.00';
  walletState.usdcBalance = '0.00';
  walletState.minBalance = '0.10';
  walletState.round = null;
  walletState.loading = false;
  walletState.connectingProvider = null;
  walletState.error = null;

  await saveWalletState();
  renderWalletUI();
  flashHint('Wallet disconnected', 2000);
}

/**
 * Switch active Algorand network (TestNet / MainNet / LocalNet).
 */
export async function switchNetwork(networkId) {
  if (!NETWORKS[networkId]) return;
  walletState.network = networkId;
  await saveWalletState();
  if (walletState.connected) {
    await refreshWalletBalance();
  }
  renderWalletUI();
  flashHint(`Switched to ${NETWORKS[networkId].name}`, 2000);
}

/**
 * Real Algorand Transaction Signer for x402 Protocol
 */
export function getWalletSigner() {
  if (!walletState.connected || !walletState.address) return null;

  return {
    address: walletState.address,
    signTransactions: async (txns) => {
      /**
       * An injected wallet first, then the road the user actually came in by.
       *
       * This used to be the injected branch and a throw, which quietly made
       * signing impossible for every wallet connected over the WEB — which is
       * most of them, and certainly Lute, whose connect flow is a popup and a
       * postMessage and leaves nothing on `window`. The panel showed an address
       * and a balance, reported itself connected, and could not move a single
       * microALGO: a run finished, `settleRun` reached the signer, and the
       * signer threw. No wallet prompt, twice reported, with every layer either
       * side of it testing green.
       *
       * ARC-0001 both ways: an array of `{txn}` where `txn` is base64 msgpack,
       * answered in the same order.
       */
      const injected =
        window.algorand || window.exodus?.algorand || window.pera || window.defly || window.lute;

      if (injected && typeof injected.signTxns === 'function') {
        return injected.signTxns(txns.map((t) => (typeof t === 'string' ? { txn: t } : t)));
      }

      if (walletState.providerId === 'lute') return requestLuteSign(txns);

      throw new Error(
        `${walletState.providerName || 'This wallet'} cannot sign from the side panel. ` +
          'Reconnect with Lute, or install this wallet as a browser extension.'
      );
    }
  };
}

/**
 * Update topbar button and sheet modal UI.
 */
export function renderWalletUI() {
  if (!els.walletPill || !els.walletLabel || !els.walletDot) return;

  const currentNetwork = NETWORKS[walletState.network] || NETWORKS.testnet;

  // 1. Topbar Pill
  if (walletState.connected) {
    els.walletPill.classList.add('connected');
    els.walletLabel.textContent = ellipseAddress(walletState.address, 4, 3);
    els.walletPill.title = `${walletState.providerName}\nAddress: ${walletState.address}\nNetwork: ${currentNetwork.name}\nALGO: ${walletState.algoBalance} | USDC: ${walletState.usdcBalance}`;
  } else {
    els.walletPill.classList.remove('connected');
    els.walletLabel.textContent = 'Connect';
    els.walletPill.title = 'Connect Wallet (x402 / Algorand)';
  }

  // 2. Sheet Content
  renderWalletSheet();
}

/**
 * Render the wallet sheet contents (Connected view or Wallet list)
 */
/**
 * The switch: pay for every agent step, or pay for nothing.
 *
 * It is drawn in BOTH branches of the sheet, connected and not, because with
 * the marketplace paying for itself a wallet is no longer needed to be charged
 * — so the one place someone would look for "am I being billed for this run"
 * must answer whether or not they ever connected anything.
 *
 * The note under it is the whole point of the block. Four states, and the two
 * that look identical from outside — off, and on with nothing behind it — need
 * opposite responses: one is a setting the user chose, the other is a deploy
 * with no account to pay from. Reporting them the same way is how the last
 * billing bug stayed invisible for a week.
 */
function autoPayBlock() {
  const on = autoPayEnabled();

  // The note is left EMPTY here and filled in by `bindAutoPay` as text — it
  // carries the marketplace's own words about why it cannot pay, which is
  // content off the wire and does not belong in an HTML string.
  const mine = userSeedSet();

  /**
   * The phrase is NEVER rendered back, not even masked — a masked field
   * holding a real secret is a secret one paste away from a screen, and there
   * is nothing the panel could do with it that showing the derived address
   * does not do better. So the box is always empty and the address above it is
   * what says whether saving worked.
   */
  return `
    <div class="wallet-autopay${on ? ' on' : ''}">
      <label class="wallet-autopay-row" for="wallet-autopay-toggle">
        <input type="checkbox" id="wallet-autopay-toggle" ${on ? 'checked' : ''}>
        <span class="wallet-autopay-title">Pay per agent step</span>
        <span class="wallet-autopay-state">${on ? 'On' : 'Off'}</span>
      </label>
      <p class="wallet-autopay-note" data-note></p>

      <div class="wallet-seed">
        <div class="wallet-seed-head">
          <span class="wallet-seed-label">Pay from my own account</span>
          <span class="wallet-seed-state${mine ? ' set' : ''}" data-seed-state></span>
        </div>
        <div class="wallet-seed-row">
          <input
            type="password"
            id="wallet-seed-input"
            class="wallet-seed-input"
            placeholder="25-word recovery phrase"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          >
          <button class="wallet-mini-btn" id="wallet-seed-show" title="Show what you typed">
            ${icon('eye', 14)}
          </button>
        </div>
        <div class="wallet-seed-actions">
          <button class="wallet-action-btn" id="wallet-seed-save">${mine ? 'Replace' : 'Save'}</button>
          ${mine ? '<button class="wallet-action-btn disconnect" id="wallet-seed-clear">Remove</button>' : ''}
        </div>
        <p class="wallet-seed-warn">
          A recovery phrase is total control of that account, with no undo. It is
          kept in this browser profile and sent to the marketplace over HTTPS to
          sign each payment. Use a throwaway account.
        </p>
      </div>
    </div>
  `;
}

/**
 * Bind it, and write the note as TEXT.
 *
 * The note carries a reason string that came off the wire — the marketplace's
 * own words about why it cannot pay — so it is set with `textContent` rather
 * than built into the markup above. Same rule as the fee block: this is the
 * surface where content we do not control sits next to a wallet address.
 */
function bindAutoPay(root) {
  const el = root.querySelector('[data-note]');
  if (el) el.textContent = autoPayNote();

  const toggle = root.querySelector('#wallet-autopay-toggle');
  toggle?.addEventListener('change', async (e) => {
    e.stopPropagation();
    const on = await setAutoPayEnabled(e.target.checked);

    /**
     * Repaint FIRST, hint second, and the order is not arbitrary. The note
     * under the switch now says something different — that is the half that
     * has to happen — and the hint is a two-second nicety. Sequencing the
     * repaint behind it means anything that throws in the hint leaves the
     * switch showing the state it was in before the click, which reads exactly
     * like a toggle that does not work.
     */
    renderWalletSheet();
    flashHint(
      on ? 'Agent steps will be paid for as they happen.' : 'Agent steps will not be charged.',
      2500
    );
  });

  /* ── the user's own account ───────────────────────────────────────────── */

  /**
   * Written as TEXT for the same reason as the note: this line names an address
   * that came back off the wire.
   */
  const stateEl = root.querySelector('[data-seed-state]');
  if (stateEl) {
    stateEl.textContent = userSeedSet()
      ? `paying from ${ellipseAddress(userSeedAddress(), 6, 4)}`
      : "not set — the marketplace's own account pays";
  }

  const input = root.querySelector('#wallet-seed-input');

  // A phrase is 25 words and easy to mistype; being able to read back what you
  // pasted before saving it is the difference between one attempt and four.
  root.querySelector('#wallet-seed-show')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });

  const save = root.querySelector('#wallet-seed-save');
  save?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!input || save.disabled) return;

    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Checking…';

    const result = await setUserSeed(input.value);

    /**
     * Cleared on BOTH paths, and immediately. On success it has been saved and
     * has no business staying on screen; on failure the commonest cause is a
     * paste that went somewhere it should not, and leaving it in a field that
     * can be un-masked keeps it there.
     */
    input.value = '';
    save.disabled = false;
    save.textContent = label;

    if (result.ok) {
      renderWalletSheet();
      flashHint(`Paying from ${ellipseAddress(result.address, 6, 4)}.`, 4000);
      if (result.funded === false) {
        flashHint(`${ellipseAddress(result.address, 6, 4)} has no funds — payments will fail.`, 8000);
      }
    } else {
      flashHint(`Not saved — ${result.reason}`, 8000);
    }
  });

  root.querySelector('#wallet-seed-clear')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await clearUserSeed();
    renderWalletSheet();
    flashHint("Removed. The marketplace's own account pays again.", 4000);
  });
}

/** The note text for the current state, kept next to the block that draws it. */
function autoPayNote() {
  const on = autoPayEnabled();
  const address = autoPayAddress();

  if (!on) return 'Nothing the agent does is charged for. No transaction is made.';

  if (autoPayConfigured() && isValidAlgorandAddress(address || '')) {
    // Whose account is the thing to lead with. "It is paying" and "it is paying
    // from MY account" are different facts, and only one of them is the one
    // somebody who saved a phrase is checking for.
    const whose = userSeedSet() ? 'your own account' : "the marketplace's account";
    return (
      `Each action settles by itself from ${whose}, ${ellipseAddress(address, 6, 4)} — ` +
      'one transaction per step, no signature asked.'
    );
  }

  /**
   * The reason is a whole sentence written by whoever produced it — the server
   * ends its own with a full stop, the local ones do not — so the trailing one
   * is trimmed rather than assumed either way. "configured.." reads as a bug in
   * the thing that is trying to explain a bug.
   */
  const reason = (autoPayProblem() || 'the marketplace has no account to pay from').replace(
    /\.\s*$/,
    ''
  );

  return (
    `Not settling automatically — ${reason}. ` +
    'Steps bank for one signature from your own wallet at the end of a run.'
  );
}

export function renderWalletSheet() {
  if (!els.walletContent) return;

  const currentNetwork = NETWORKS[walletState.network] || NETWORKS.testnet;

  if (walletState.connected) {
    // ---------------------- CONNECTED ACCOUNT VIEW ----------------------
    const loraUrl = `${currentNetwork.explorerUrl}${walletState.address}`;

    els.walletContent.innerHTML = `
      <div class="wallet-account-card">
        <div class="wallet-card-header">
          <div class="wallet-provider-tag">
            <span class="dot" style="background:#10b981;"></span>
            <span>${walletState.providerName}</span>
          </div>
          <div class="wallet-network-selector">
            <select id="wallet-network-select" class="wallet-select-clean" title="Switch Network">
              <option value="testnet" ${walletState.network === 'testnet' ? 'selected' : ''}>TestNet</option>
              <option value="mainnet" ${walletState.network === 'mainnet' ? 'selected' : ''}>MainNet</option>
              <option value="localnet" ${walletState.network === 'localnet' ? 'selected' : ''}>LocalNet (KMD)</option>
            </select>
          </div>
        </div>

        <div class="wallet-address-bar">
          <span class="wallet-address-text" title="${walletState.address}">${walletState.address}</span>
          <div class="wallet-btn-group">
            <button class="wallet-mini-btn" id="wallet-copy-btn" title="Copy Address">
              ${icon('copy', 14)}
            </button>
            <a class="wallet-mini-btn" href="${loraUrl}" target="_blank" rel="noreferrer" title="View in Lora / Algorand Explorer">
              ${icon('externalLink', 14)}
            </a>
          </div>
        </div>

        <div class="wallet-balances-grid">
          <div class="wallet-balance-box">
            <div class="wallet-balance-label">ALGO Balance</div>
            <div class="wallet-balance-val">${walletState.algoBalance} <span class="wallet-unit">ALGO</span></div>
          </div>
          <div class="wallet-balance-box">
            <div class="wallet-balance-label">x402 USDC Balance</div>
            <div class="wallet-balance-val">${walletState.usdcBalance} <span class="wallet-unit">USDC</span></div>
          </div>
        </div>

        <div class="wallet-x402-badge">
          ${icon('check', 13)}
          <span>x402 HTTP Payment Protocol Ready (${currentNetwork.name})</span>
        </div>

        ${autoPayBlock()}

        <div class="wallet-actions">
          ${
            currentNetwork.faucetUrl
              ? `<a class="wallet-action-btn" href="${currentNetwork.faucetUrl}" target="_blank" rel="noreferrer" title="Get free TestNet USDC / ALGO">
                  ${icon('sparkle', 13)} TestNet Faucet
                </a>`
              : `<button class="wallet-action-btn" id="wallet-refresh-btn" title="Refresh balances">
                  ${icon('refresh', 13)} Refresh
                </button>`
          }
          <button class="wallet-action-btn" id="wallet-testpay-btn"
                  title="Send one real x402 payment so you can check signing works">
            Test x402 payment
          </button>
          <button class="wallet-action-btn disconnect" id="wallet-disconnect-btn">
            Disconnect
          </button>
        </div>
      </div>
    `;

    bindAutoPay(els.walletContent);

    // Bind network switcher
    const netSelect = els.walletContent.querySelector('#wallet-network-select');
    netSelect?.addEventListener('change', (e) => {
      switchNetwork(e.target.value);
    });

    // Bind copy address
    const copyBtn = els.walletContent.querySelector('#wallet-copy-btn');
    copyBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(walletState.address);
        flashHint('Address copied to clipboard', 2000);
      } catch {
        flashHint('Failed to copy address', 2000);
      }
    });

    /**
     * Send one real payment, now, and say what happened either way.
     *
     * The whole value is that it is the SAME path a run settles through —
     * quote, wallet prompt, settle, receipt. A button that mocked any of
     * that would report on a road nobody uses.
     *
     * Awaited, unlike every other charge in this panel, and that is the one
     * deliberate difference: nothing is waiting on it, the user pressed it
     * on purpose, and the answer is the entire reason it exists.
     */
    const testPayBtn = els.walletContent.querySelector('#wallet-testpay-btn');
    testPayBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (testPayBtn.disabled) return;

      testPayBtn.disabled = true;
      const label = testPayBtn.textContent;

      /**
       * Two roads, two waits, and the label has to name the right one. Saying
       * "approve this in your wallet" over a payment that signs itself sends
       * the user looking for a popup that is never coming — the same class of
       * lie as the stage track announcing a provider window on a path that
       * opens none.
       */
      const unattended = autoPayConfigured();
      testPayBtn.textContent = unattended ? 'Paying…' : 'Waiting for your wallet…';
      flashHint(
        unattended
          ? 'Paying from the marketplace wallet — no signature needed…'
          : 'Approve the payment in your wallet…',
        4000
      );

      try {
        const { testPayment } = await import('../payments/run-billing.js');
        const { state } = await import('../core/state.js');
        const result = await testPayment(state.session?.id ?? null);

        if (result?.paid) {
          flashHint('Paid — the receipt is under your last answer.', 4000);
        } else {
          // The reason is the product here, so it is shown in full and for
          // long enough to read. It is also filed by `settleRun`'s wrapper,
          // so it survives the hint disappearing.
          flashHint(`Not charged — ${result?.reason || 'no reason given'}`, 9000);
        }
      } catch (error) {
        flashHint(`Test payment failed — ${error?.message || error}`, 9000);
      } finally {
        testPayBtn.disabled = false;
        testPayBtn.textContent = label;
      }
    });

    // Bind refresh
    const refreshBtn = els.walletContent.querySelector('#wallet-refresh-btn');
    refreshBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      flashHint('Fetching on-chain balance…', 1500);
      await refreshWalletBalance();
    });

    // Bind disconnect
    const discBtn = els.walletContent.querySelector('#wallet-disconnect-btn');
    discBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      disconnectWallet();
    });
  } else {
    // ---------------------- WALLET PROVIDER SELECTION LIST ----------------------
    els.walletContent.innerHTML = `
      <div class="wallet-network-bar">
        <span class="wallet-net-label">Active Network:</span>
        <select id="wallet-network-select" class="wallet-select-clean">
          <option value="testnet" ${walletState.network === 'testnet' ? 'selected' : ''}>Algorand TestNet (x402)</option>
          <option value="mainnet" ${walletState.network === 'mainnet' ? 'selected' : ''}>Algorand MainNet</option>
          <option value="localnet" ${walletState.network === 'localnet' ? 'selected' : ''}>LocalNet (KMD)</option>
        </select>
      </div>

      ${autoPayBlock()}

      <div class="sheet-list">
        ${SUPPORTED_WALLETS.map(
          (w) => `
          <button class="wallet-row" data-wallet-id="${w.id}">
            <div class="wallet-badge-icon ${w.iconClass}">${w.letter}</div>
            <div class="wallet-row-main">
              <div class="wallet-row-title">
                <span>${w.name}</span>
                ${w.tag ? `<span class="wallet-row-tag">${w.tag}</span>` : ''}
              </div>
              <div class="wallet-row-sub">${w.desc}</div>
            </div>
            <span class="caret" style="color:var(--fg-dim);">${icon('chevron', 14)}</span>
          </button>
        `
        ).join('')}
      </div>

      <div class="wallet-footer-info">
        <span>Powered by <a href="https://github.com/marotipatre/x402-Project" target="_blank" rel="noreferrer">x402 HTTP Payment Protocol</a> on Algorand</span>
      </div>
    `;

    // Bind network switcher
    const netSelect = els.walletContent.querySelector('#wallet-network-select');
    netSelect?.addEventListener('change', (e) => {
      switchNetwork(e.target.value);
    });

    // Bind wallet clicks
    els.walletContent.querySelectorAll('.wallet-row').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.walletId;
        if (id) connectWallet(id);
      });
    });

    bindAutoPay(els.walletContent);
  }
}
