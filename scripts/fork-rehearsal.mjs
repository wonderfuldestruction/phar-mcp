#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodePacked,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  toHex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";

const liveBroadcast = process.env.LIVE_BROADCAST === "1";
const selectedPhases = process.env.PHAR_MCP_PHASES
  ? new Set(process.env.PHAR_MCP_PHASES.split(",").map((phase) => phase.trim()).filter(Boolean))
  : null;
const rpcUrl = process.env.FORK_RPC_URL
  ?? (liveBroadcast ? "https://api.avax.network/ext/bc/C/rpc" : "http://127.0.0.1:8545");
if (!liveBroadcast && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl)) {
  throw new Error("fork-rehearsal refuses non-local RPC URLs unless LIVE_BROADCAST=1.");
}

const keyFile = process.env.PHAR_MCP_KEY_FILE ?? ".secrets/phar-mcp-expendable-wallet.txt";
const keyMatch = readFileSync(keyFile, "utf8").match(/Private key:\s*(0x[0-9a-fA-F]{64})/);
if (!keyMatch) {
  throw new Error(`Could not read private key from ${keyFile}`);
}

const account = privateKeyToAccount(keyMatch[1]);
const expectedWallet = (process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000").toLowerCase();
if (account.address.toLowerCase() !== expectedWallet) {
  throw new Error(`Loaded key address ${account.address} does not match expected wallet.`);
}
if (liveBroadcast && process.env.PHAR_MCP_LIVE_CONFIRM?.toLowerCase() !== expectedWallet) {
  throw new Error("Live broadcast requires PHAR_MCP_LIVE_CONFIRM to equal the expendable wallet address.");
}

const transportOptions = { retryCount: 0, timeout: 120_000 };
const publicClient = createPublicClient({ chain: avalanche, transport: http(rpcUrl, transportOptions) });
const walletClient = createWalletClient({ account, chain: avalanche, transport: http(rpcUrl, transportOptions) });

const USDC = contractRegistry.usdcNative.address;
const WAVAX = contractRegistry.wavax.address;
const PHAR = contractRegistry.pharToken.address;
const XPHAR = contractRegistry.xPharToken.address;
const P33 = contractRegistry.p33.address;
const ROUTER = contractRegistry.router.address;
const UNIVERSAL_ROUTER = contractRegistry.universalRouter.address;
const MIXED_ROUTE_QUOTER = contractRegistry.mixedRouteQuoterV1.address;
const CL_FACTORY = contractRegistry.ramsesV3Factory.address;
const POSITION_MANAGER = contractRegistry.ramsesV3PositionManager.address;
const CL_WAVAX_USDC_10_POOL = "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534";
const DLMM_ROUTER = contractRegistry.dlmmRouter.address;
const DLMM_POOL = contractRegistry.dlmmWavaxUsdc5Pool.address;
const AUTO_VAULT = contractRegistry.autoVault.address;
const MAX_UINT128 = (1n << 128n) - 1n;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const UNIVERSAL_ROUTER_CONTRACT_BALANCE = 1n << 255n;
const MIXED_ROUTE_V2_VOLATILE_FLAG = 0x800001;
const trackedAllowanceTokens = [
  ["USDC", USDC],
  ["PHAR", PHAR],
  ["xPHAR", XPHAR],
  ["p33", P33]
];
const trackedSpenders = [
  ["legacyRouter", ROUTER],
  ["universalRouter", UNIVERSAL_ROUTER],
  ["swapRouter", contractRegistry.swapRouter.address],
  ["positionManager", POSITION_MANAGER],
  ["dlmmRouter", DLMM_ROUTER],
  ["xPharToken", XPHAR],
  ["p33", P33],
  ["voteModule", contractRegistry.voteModule.address],
  ["autoVault", AUTO_VAULT]
];

const report = {
  timestamp: new Date().toISOString(),
  mode: liveBroadcast ? "live" : "fork",
  rpcUrl,
  wallet: account.address,
  liveConfirmationAddress: liveBroadcast ? process.env.PHAR_MCP_LIVE_CONFIRM : null,
  selectedPhases: selectedPhases ? [...selectedPhases] : null,
  phases: []
};

const knownErrorAbi = [
  { type: "error", name: "LOCKED", inputs: [] },
  { type: "error", name: "DepositTooSmall", inputs: [] },
  { type: "error", name: "EXPIRED", inputs: [] },
  { type: "error", name: "EXCESSIVE_INPUT_AMOUNT", inputs: [] },
  { type: "error", name: "ETH_TRANSFER_FAILED", inputs: [] },
  { type: "error", name: "INSUFFICIENT_A_AMOUNT", inputs: [] },
  { type: "error", name: "INSUFFICIENT_B_AMOUNT", inputs: [] },
  { type: "error", name: "INSUFFICIENT_LIQUIDITY_BURNED", inputs: [] },
  { type: "error", name: "INSUFFICIENT_LIQUIDITY_MINTED", inputs: [] },
  { type: "error", name: "INSUFFICIENT_OUTPUT_AMOUNT", inputs: [] },
  { type: "error", name: "INVALID_PATH", inputs: [] },
  { type: "error", name: "SAFE_TRANSFER_FAILED", inputs: [] },
  { type: "error", name: "LBRouter__MaxAmountInExceeded", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "LBRouter__InsufficientAmountOut", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "LBRouter__DeadlineExceeded", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "LBRouter__AmountSlippageCaught", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "LBRouter__BrokenSwapSafetyCheck", inputs: [] },
  { type: "error", name: "LBFactory__PresetIsLockedForUsers", inputs: [{ type: "address" }, { type: "uint256" }] }
];

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const transactionHash = error && typeof error === "object" && "transactionHash" in error
    ? error.transactionHash
    : undefined;
  const receiptStatus = error && typeof error === "object" && "receipt" in error
    ? error.receipt?.status
    : undefined;
  const customErrorData = message.match(/custom error (0x[0-9a-fA-F]{8}):\s*([0-9a-fA-F]+)/);
  const explicitRevertData = message.match(/(?:revert data|data):\s*(0x[0-9a-fA-F]{8,})/i);
  const revertData = customErrorData
    ? `${customErrorData[1]}${customErrorData[2]}`
    : explicitRevertData?.[1];
  const selector = revertData?.slice(0, 10);
  let decoded;

  if (revertData) {
    try {
      const decodedError = decodeErrorResult({ abi: knownErrorAbi, data: revertData });
      const abiError = knownErrorAbi.find((item) => item.name === decodedError.errorName);
      decoded = abiError ? `${abiError.name}(${abiError.inputs.map((input) => input.type).join(",")})` : decodedError.errorName;
    } catch {
      decoded = undefined;
    }
  }

  return { message, transactionHash, receiptStatus, selector, decoded };
}

function stringify(value) {
  return JSON.stringify(value, (_key, inner) => typeof inner === "bigint" ? inner.toString() : inner, 2);
}

function floorToSpacing(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}

async function readBalance(token, decimals) {
  const raw = await publicClient.readContract({
    address: token,
    abi: contractAbis.erc20Read,
    functionName: "balanceOf",
    args: [account.address]
  });
  return { raw, formatted: formatUnits(raw, decimals) };
}

async function readTokenBalance(token, owner, decimals) {
  const raw = await publicClient.readContract({
    address: token,
    abi: contractAbis.erc20Read,
    functionName: "balanceOf",
    args: [owner]
  });
  return { raw, formatted: formatUnits(raw, decimals) };
}

async function routerDustSnapshot(label) {
  return {
    label,
    WAVAX: await readTokenBalance(WAVAX, UNIVERSAL_ROUTER, 18),
    PHAR: await readTokenBalance(PHAR, UNIVERSAL_ROUTER, 18),
    USDC: await readTokenBalance(USDC, UNIVERSAL_ROUTER, 6)
  };
}

function assertNoRouterDustIncrease(before, after) {
  for (const token of ["WAVAX", "PHAR", "USDC"]) {
    if (BigInt(after[token].raw) > BigInt(before[token].raw)) {
      throw new Error(`UniversalRouter ${token} balance increased from ${before[token].raw} to ${after[token].raw}`);
    }
  }
}

async function snapshot(label) {
  const avax = await publicClient.getBalance({ address: account.address });
  return {
    label,
    AVAX: { raw: avax, formatted: formatEther(avax) },
    USDC: await readBalance(USDC, 6),
    PHAR: await readBalance(PHAR, 18),
    xPHAR: await readBalance(XPHAR, 18),
    p33: await readBalance(P33, 18),
    autoVaultShares: await readBalance(AUTO_VAULT, 18)
  };
}

async function allowanceSnapshot(label) {
  const allowances = {};
  for (const [symbol, token] of trackedAllowanceTokens) {
    allowances[symbol] = {};
    for (const [spenderName, spender] of trackedSpenders) {
      allowances[symbol][spenderName] = {
        spender,
        raw: await publicClient.readContract({
          address: token,
          abi: contractAbis.erc20Read,
          functionName: "allowance",
          args: [account.address, spender]
        })
      };
    }
  }

  return {
    label,
    allowances,
    dlmmPoolApprovals: {
      wavaxUsdc5ToRouter: await publicClient.readContract({
        address: DLMM_POOL,
        abi: contractAbis.dlmmPool,
        functionName: "isApprovedForAll",
        args: [account.address, DLMM_ROUTER]
      })
    }
  };
}

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") {
    const error = new Error(`Transaction failed: ${hash}`);
    error.transactionHash = hash;
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

async function write(label, contract, functionName, args, value = 0n, gas) {
  const hash = await walletClient.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    value,
    ...(gas ? { gas } : {})
  });
  const receipt = await wait(hash);
  return { ok: true, label, hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
}

async function approve(token, spender, amount) {
  return write(
    `approve ${token} -> ${spender}`,
    { address: token, abi: contractAbis.erc20Approval },
    "approve",
    [spender, amount]
  );
}

async function revokeAllowanceIfNeeded(steps, label, token, spender) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: contractAbis.erc20Read,
    functionName: "allowance",
    args: [account.address, spender]
  });
  if (allowance > 0n) {
    return step(steps, label, () => approve(token, spender, 0n));
  }
  steps.push({ ok: true, label, skipped: true, result: "Allowance already zero." });
  return { ok: true, label, skipped: true };
}

function encodeUniversalRouterSwapInput({ recipient, amountIn, amountOutMin, path, payerIsUser }) {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bool" }
    ],
    [recipient, amountIn, amountOutMin, path, payerIsUser]
  );
}

function encodeUniversalRouterPaymentInput({ recipient, amountMinimum }) {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" }
    ],
    [recipient, amountMinimum]
  );
}

function encodeUniversalRouterV2Path(route) {
  return encodeAbiParameters(
    [{
      type: "tuple[]",
      components: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "stable", type: "bool" }
      ]
    }],
    [route]
  );
}

async function forkWriteFrom(label, from, contract, functionName, args, value = 0n) {
  if (liveBroadcast) {
    throw new Error(`${label} is fork-only and must never run in live broadcast mode.`);
  }

  await publicClient.request({
    method: "anvil_setBalance",
    params: [from, toHex(parseEther("10"))]
  });
  await publicClient.request({
    method: "anvil_impersonateAccount",
    params: [from]
  });

  const impersonatedWallet = createWalletClient({
    account: from,
    chain: avalanche,
    transport: http(rpcUrl, transportOptions)
  });

  try {
    const hash = await impersonatedWallet.writeContract({
      address: contract.address,
      abi: contract.abi,
      functionName,
      args,
      value
    });
    const receipt = await wait(hash);
    return { ok: true, label, from, hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  } finally {
    await publicClient.request({
      method: "anvil_stopImpersonatingAccount",
      params: [from]
    });
  }
}

async function phase(name, fn) {
  if (selectedPhases && !selectedPhases.has(name)) {
    report.phases.push({
      name,
      ok: true,
      status: "skipped",
      skipped: true,
      reason: "Skipped by PHAR_MCP_PHASES."
    });
    return;
  }

  const forkSnapshot = !liveBroadcast
    ? await publicClient.request({ method: "evm_snapshot", params: [] })
    : null;
  const entry = { name, ok: false, status: "running", before: await snapshot(`${name}:before`), steps: [] };
  try {
    const outcome = await fn(entry.steps);
    entry.after = await snapshot(`${name}:after`);
    entry.status = outcome?.status ?? "passed";
    if (outcome?.reason) entry.reason = outcome.reason;
    entry.ok = entry.status === "passed";
  } catch (error) {
    entry.status = "failed";
    entry.error = describeError(error);
    entry.after = await snapshot(`${name}:after-error`);
  }
  if (forkSnapshot) {
    try {
      entry.forkSnapshotReverted = await publicClient.request({
        method: "evm_revert",
        params: [forkSnapshot]
      });
    } catch (error) {
      entry.forkSnapshotRevertError = describeError(error);
    }
  }
  report.phases.push(entry);
  if (entry.status === "failed" && process.env.STOP_ON_FAIL === "1") {
    throw new Error(`${name} failed: ${entry.error}`);
  }
}

async function step(steps, label, fn) {
  try {
    const result = await fn();
    steps.push(result);
    return result;
  } catch (error) {
    steps.push({ ok: false, label, error: describeError(error) });
    throw error;
  }
}

async function fallbackStep(steps, label, fn) {
  try {
    const result = await fn();
    steps.push(result);
    return { ok: true, result };
  } catch (error) {
    const failure = { ok: false, label, error: describeError(error), fallbackAllowed: true };
    steps.push(failure);
    return { ok: false, failure };
  }
}

async function readStep(steps, label, fn) {
  try {
    const result = await fn();
    steps.push({ ok: true, label, result });
    return result;
  } catch (error) {
    steps.push({ ok: false, label, error: describeError(error) });
    throw error;
  }
}

await phase("legacy_swap_usdc_to_phar", async (steps) => {
  const amountIn = parseUnits("0.5", 6);
  const route = [{ from: USDC, to: PHAR, stable: false }];
  const quote = await readStep(steps, "quote USDC->PHAR", () => publicClient.readContract({
    address: ROUTER,
    abi: contractAbis.router,
    functionName: "getAmountsOut",
    args: [amountIn, route]
  }));
  const amountOutMin = quote[quote.length - 1] * 95n / 100n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  await step(steps, "approve USDC -> legacy router", () => approve(USDC, ROUTER, amountIn));
  await step(
    steps,
    "swapExactTokensForTokens USDC->PHAR",
    () => write(
      "swapExactTokensForTokens USDC->PHAR",
      { address: ROUTER, abi: contractAbis.router },
      "swapExactTokensForTokens",
      [amountIn, amountOutMin, route, account.address, deadline]
    )
  );
});

await phase("mixed_route_exact_in", async (steps) => {
  const amountIn = parseUnits(process.env.MIXED_ROUTE_AMOUNT_USDC ?? "0.01", 6);
  const mixedRouteMinBps = BigInt(process.env.MIXED_ROUTE_MIN_BPS ?? (liveBroadcast ? "9500" : "0"));
  const quotePath = encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [USDC, MIXED_ROUTE_V2_VOLATILE_FLAG, WAVAX, 5, PHAR]
  );
  const quote = await readStep(steps, "mixed quote USDC legacy volatile -> WAVAX -> PHAR CL5", () => publicClient.readContract({
    address: MIXED_ROUTE_QUOTER,
    abi: contractAbis.mixedRouteQuoterV1,
    functionName: "quoteExactInput",
    args: [quotePath, amountIn]
  }));
  const amountOut = BigInt(Array.isArray(quote) ? quote[0] : quote.amountOut ?? quote);
  const amountOutMin = amountOut * mixedRouteMinBps / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const v2Path = encodeUniversalRouterV2Path([{ from: USDC, to: WAVAX, stable: false }]);
  const v3Path = encodePacked(["address", "int24", "address"], [WAVAX, 5, PHAR]);
  const commands = "0x0800";
  const inputs = [
    encodeUniversalRouterSwapInput({
      recipient: ADDRESS_THIS,
      amountIn,
      amountOutMin: 0n,
      path: v2Path,
      payerIsUser: true
    }),
    encodeUniversalRouterSwapInput({
      recipient: account.address,
      amountIn: UNIVERSAL_ROUTER_CONTRACT_BALANCE,
      amountOutMin,
      path: v3Path,
      payerIsUser: false
    })
  ];

  await readStep(steps, "mixed UniversalRouter command plan", async () => ({
    universalRouter: UNIVERSAL_ROUTER,
    mixedRouteQuoter: MIXED_ROUTE_QUOTER,
    commands,
    amountIn,
    amountOut,
    amountOutMin,
    quotePath,
    v2Path,
    v3Path
  }));
  await step(steps, "approve USDC -> UniversalRouter", () => approve(USDC, UNIVERSAL_ROUTER, amountIn));
  try {
    await step(
      steps,
      "UniversalRouter mixed V2/V3 exact-in USDC->PHAR",
      () => write(
        "UniversalRouter mixed V2/V3 exact-in USDC->PHAR",
        { address: UNIVERSAL_ROUTER, abi: contractAbis.universalRouter },
        "execute",
        [commands, inputs, deadline]
      )
    );
  } catch (error) {
    try {
      await step(steps, "revoke UniversalRouter USDC approval after failure", () => approve(USDC, UNIVERSAL_ROUTER, 0n));
    } catch {
      // Preserve the original execute failure while recording the cleanup attempt in steps.
    }
    throw error;
  }
  await step(steps, "revoke UniversalRouter USDC approval", () => approve(USDC, UNIVERSAL_ROUTER, 0n));

  if (liveBroadcast && process.env.MIXED_ROUTE_LIVE_NATIVE !== "1") {
    steps.push({
      ok: true,
      label: "mixed native exact-in cases skipped live",
      skipped: true,
      reason: "Native mixed-route wrap/unwrap cases are fork-proven by default and require MIXED_ROUTE_LIVE_NATIVE=1 for live broadcast."
    });
    return;
  }

  const pharUsdcPair = await readStep(steps, "legacy pairFor PHAR/USDC volatile", () => publicClient.readContract({
    address: contractRegistry.pairFactory.address,
    abi: contractAbis.pairFactory,
    functionName: "getPair",
    args: [PHAR, USDC, false]
  }));
  const routerDustBeforeNative = await readStep(steps, "UniversalRouter dust before native mixed routes", () => routerDustSnapshot("before-native-mixed"));
  const nativeInAmount = parseEther(process.env.MIXED_ROUTE_NATIVE_IN_AVAX ?? "0.001");
  const nativeInQuotePath = encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [WAVAX, 5, PHAR, MIXED_ROUTE_V2_VOLATILE_FLAG, USDC]
  );
  const nativeInQuote = await readStep(steps, "mixed quote AVAX(WAVAX) -> PHAR CL5 -> USDC legacy volatile", () => publicClient.readContract({
    address: MIXED_ROUTE_QUOTER,
    abi: contractAbis.mixedRouteQuoterV1,
    functionName: "quoteExactInput",
    args: [nativeInQuotePath, nativeInAmount]
  }));
  const nativeInAmountOut = BigInt(Array.isArray(nativeInQuote) ? nativeInQuote[0] : nativeInQuote.amountOut ?? nativeInQuote);
  const nativeInAmountOutMin = nativeInAmountOut * mixedRouteMinBps / 10_000n;
  const nativeInV3Path = encodePacked(["address", "int24", "address"], [WAVAX, 5, PHAR]);
  const nativeInV2Path = encodeUniversalRouterV2Path([{ from: PHAR, to: USDC, stable: false }]);
  const nativeInCommands = "0x0b0008";
  const nativeInInputs = [
    encodeUniversalRouterPaymentInput({ recipient: ADDRESS_THIS, amountMinimum: nativeInAmount }),
    encodeUniversalRouterSwapInput({
      recipient: pharUsdcPair,
      amountIn: nativeInAmount,
      amountOutMin: 0n,
      path: nativeInV3Path,
      payerIsUser: false
    }),
    encodeUniversalRouterSwapInput({
      recipient: account.address,
      amountIn: 0n,
      amountOutMin: nativeInAmountOutMin,
      path: nativeInV2Path,
      payerIsUser: false
    })
  ];

  await readStep(steps, "mixed native-input UniversalRouter command plan", async () => ({
    commands: nativeInCommands,
    amountIn: nativeInAmount,
    amountOut: nativeInAmountOut,
    amountOutMin: nativeInAmountOutMin,
    quotePath: nativeInQuotePath,
    v3Path: nativeInV3Path,
    v2Path: nativeInV2Path
  }));
  await step(
    steps,
    "UniversalRouter mixed native-input exact-in AVAX->USDC",
    () => write(
      "UniversalRouter mixed native-input exact-in AVAX->USDC",
      { address: UNIVERSAL_ROUTER, abi: contractAbis.universalRouter },
      "execute",
      [nativeInCommands, nativeInInputs, deadline],
      nativeInAmount
    )
  );
  const routerDustAfterNativeInput = await readStep(steps, "UniversalRouter dust after native-input mixed route", () => routerDustSnapshot("after-native-input-mixed"));
  assertNoRouterDustIncrease(routerDustBeforeNative, routerDustAfterNativeInput);

  const nativeOutAmountIn = parseUnits(process.env.MIXED_ROUTE_NATIVE_OUT_USDC ?? "0.1", 6);
  const nativeOutQuotePath = encodePacked(
    ["address", "uint24", "address", "uint24", "address"],
    [USDC, MIXED_ROUTE_V2_VOLATILE_FLAG, PHAR, 5, WAVAX]
  );
  const nativeOutQuote = await readStep(steps, "mixed quote USDC legacy volatile -> PHAR -> AVAX(WAVAX) CL5", () => publicClient.readContract({
    address: MIXED_ROUTE_QUOTER,
    abi: contractAbis.mixedRouteQuoterV1,
    functionName: "quoteExactInput",
    args: [nativeOutQuotePath, nativeOutAmountIn]
  }));
  const nativeOutAmount = BigInt(Array.isArray(nativeOutQuote) ? nativeOutQuote[0] : nativeOutQuote.amountOut ?? nativeOutQuote);
  const nativeOutAmountMin = nativeOutAmount * mixedRouteMinBps / 10_000n;
  const nativeOutV2Path = encodeUniversalRouterV2Path([{ from: USDC, to: PHAR, stable: false }]);
  const nativeOutV3Path = encodePacked(["address", "int24", "address"], [PHAR, 5, WAVAX]);
  const nativeOutCommands = "0x08000c";
  const nativeOutInputs = [
    encodeUniversalRouterSwapInput({
      recipient: ADDRESS_THIS,
      amountIn: nativeOutAmountIn,
      amountOutMin: 0n,
      path: nativeOutV2Path,
      payerIsUser: true
    }),
    encodeUniversalRouterSwapInput({
      recipient: ADDRESS_THIS,
      amountIn: UNIVERSAL_ROUTER_CONTRACT_BALANCE,
      amountOutMin: nativeOutAmountMin,
      path: nativeOutV3Path,
      payerIsUser: false
    }),
    encodeUniversalRouterPaymentInput({ recipient: account.address, amountMinimum: nativeOutAmountMin })
  ];

  await readStep(steps, "mixed native-output UniversalRouter command plan", async () => ({
    commands: nativeOutCommands,
    amountIn: nativeOutAmountIn,
    amountOut: nativeOutAmount,
    amountOutMin: nativeOutAmountMin,
    quotePath: nativeOutQuotePath,
    v2Path: nativeOutV2Path,
    v3Path: nativeOutV3Path
  }));
  await step(steps, "approve USDC -> UniversalRouter for native output", () => approve(USDC, UNIVERSAL_ROUTER, nativeOutAmountIn));
  try {
    await step(
      steps,
      "UniversalRouter mixed native-output exact-in USDC->AVAX",
      () => write(
        "UniversalRouter mixed native-output exact-in USDC->AVAX",
        { address: UNIVERSAL_ROUTER, abi: contractAbis.universalRouter },
        "execute",
        [nativeOutCommands, nativeOutInputs, deadline]
      )
    );
  } catch (error) {
    try {
      await step(steps, "revoke UniversalRouter USDC approval after native-output failure", () => approve(USDC, UNIVERSAL_ROUTER, 0n));
    } catch {
      // Preserve the original execute failure while recording the cleanup attempt in steps.
    }
    throw error;
  }
  await step(steps, "revoke UniversalRouter USDC approval after native output", () => approve(USDC, UNIVERSAL_ROUTER, 0n));
  const routerDustAfterNativeOutput = await readStep(steps, "UniversalRouter dust after native-output mixed route", () => routerDustSnapshot("after-native-output-mixed"));
  assertNoRouterDustIncrease(routerDustAfterNativeInput, routerDustAfterNativeOutput);
});

await phase("phar_xphar_p33_roundtrip", async (steps) => {
  const configuredConvertAmount = parseUnits(process.env.PHAR_TO_XPHAR_AMOUNT ?? "1.03", 18);
  const p33Deposit = parseUnits(process.env.P33_DEPOSIT_AMOUNT ?? "0.03", 18);
  const p33Preflight = await readStep(steps, "p33 preflight", async () => ({
    asset: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "asset" }),
    xPhar: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "xPhar" }),
    operator: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "operator" }),
    period: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "getPeriod" }),
    isUnlocked: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "isUnlocked" }),
    isCooldownActive: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "isCooldownActive" }),
    xPharBalance: await publicClient.readContract({ address: XPHAR, abi: contractAbis.erc20Read, functionName: "balanceOf", args: [account.address] }),
    maxDeposit: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "maxDeposit", args: [account.address] }),
    previewDeposit: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "previewDeposit", args: [p33Deposit] }),
    periodUnlockStatus: await publicClient.readContract({
      address: P33,
      abi: contractAbis.p33,
      functionName: "periodUnlockStatus",
      args: [await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "getPeriod" })]
    })
  }));
  if (liveBroadcast && (!p33Preflight.isUnlocked || !p33Preflight.periodUnlockStatus)) {
    steps.push({
      ok: true,
      label: "p33 deposit skipped",
      skipped: true,
      result: "Skipped live PHAR conversion and p33 deposit because p33.isUnlocked() or periodUnlockStatus(getPeriod()) is false and deposit would revert LOCKED()."
    });
    return {
      status: "partial",
      reason: "PHAR -> xPHAR and p33 deposit/redeem skipped because p33.isUnlocked() or periodUnlockStatus(getPeriod()) is false and deposit would revert LOCKED()."
    };
  }
  if (BigInt(p33Preflight.xPharBalance) >= p33Deposit) {
    steps.push({
      ok: true,
      label: "PHAR -> xPHAR conversion skipped",
      skipped: true,
      result: `Wallet already has enough xPHAR for probe deposit: balance=${p33Preflight.xPharBalance} required=${p33Deposit}`
    });
  } else {
    const shortfall = p33Deposit - BigInt(p33Preflight.xPharBalance);
    const convertAmount = configuredConvertAmount > shortfall ? configuredConvertAmount : shortfall;
    await step(steps, "approve PHAR -> xPHAR", () => approve(PHAR, XPHAR, convertAmount));
    await step(
      steps,
      "convertEmissionsToken PHAR->xPHAR",
      () => write(
        "convertEmissionsToken PHAR->xPHAR",
        { address: XPHAR, abi: contractAbis.xPharToken },
        "convertEmissionsToken",
        [convertAmount]
      )
    );
  }
  if (!liveBroadcast && (!p33Preflight.isUnlocked || !p33Preflight.periodUnlockStatus)) {
    await step(
      steps,
      "fork impersonate p33 operator unlock",
      () => forkWriteFrom(
        "fork impersonate p33 operator unlock",
        p33Preflight.operator,
        { address: P33, abi: contractAbis.p33 },
        "unlock",
        []
      )
    );
    await readStep(steps, "p33 post-unlock preflight", async () => {
      const period = await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "getPeriod" });
      const isUnlocked = await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "isUnlocked" });
      const periodUnlockStatus = await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "periodUnlockStatus", args: [period] });
      if (!isUnlocked || !periodUnlockStatus) {
        throw new Error(`p33 remained locked on fork after operator unlock: isUnlocked=${isUnlocked} periodUnlockStatus=${periodUnlockStatus}`);
      }
      return { period, isUnlocked, periodUnlockStatus };
    });
  }
  await step(steps, "approve xPHAR -> p33", () => approve(XPHAR, P33, p33Deposit));
  await step(
    steps,
    "p33 deposit xPHAR",
    () => write(
      "p33 deposit xPHAR",
      { address: P33, abi: contractAbis.p33 },
      "deposit",
      [p33Deposit, account.address]
    )
  );
  const shares = await publicClient.readContract({
    address: P33,
    abi: contractAbis.erc20Read,
    functionName: "balanceOf",
    args: [account.address]
  });
  if (shares > 0n) {
    await step(
      steps,
      "p33 redeem to xPHAR",
      () => write(
        "p33 redeem to xPHAR",
        { address: P33, abi: contractAbis.p33 },
        "redeem",
        [shares, account.address, account.address]
      )
    );
  }
});

await phase("p33_mint_withdraw_roundtrip", async (steps) => {
  const mintShares = parseUnits(process.env.P33_MINT_SHARES ?? "0.01", 18);
  const maxMintAssets = parseUnits(process.env.P33_MINT_MAX_ASSETS ?? "0.02", 18);
  const p33Preflight = await readStep(steps, "p33 mint/withdraw preflight", async () => ({
    asset: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "asset" }),
    xPhar: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "xPhar" }),
    operator: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "operator" }),
    period: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "getPeriod" }),
    isUnlocked: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "isUnlocked" }),
    isCooldownActive: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "isCooldownActive" }),
    xPharBalance: await publicClient.readContract({ address: XPHAR, abi: contractAbis.erc20Read, functionName: "balanceOf", args: [account.address] }),
    p33Balance: await publicClient.readContract({ address: P33, abi: contractAbis.erc20Read, functionName: "balanceOf", args: [account.address] }),
    maxMint: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "maxMint", args: [account.address] }),
    previewMint: await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "previewMint", args: [mintShares] }),
    periodUnlockStatus: await publicClient.readContract({
      address: P33,
      abi: contractAbis.p33,
      functionName: "periodUnlockStatus",
      args: [await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "getPeriod" })]
    })
  }));
  if (liveBroadcast && (!p33Preflight.isUnlocked || !p33Preflight.periodUnlockStatus)) {
    steps.push({
      ok: true,
      label: "p33 mint/withdraw skipped",
      skipped: true,
      result: "Skipped live p33 mint/withdraw because p33.isUnlocked() or periodUnlockStatus(getPeriod()) is false and mint would revert LOCKED()."
    });
    return {
      status: "partial",
      reason: "p33 mint/withdraw skipped because p33.isUnlocked() or periodUnlockStatus(getPeriod()) is false and mint would revert LOCKED()."
    };
  }
  if (!liveBroadcast && (!p33Preflight.isUnlocked || !p33Preflight.periodUnlockStatus)) {
    await step(
      steps,
      "fork impersonate p33 operator unlock for mint",
      () => forkWriteFrom(
        "fork impersonate p33 operator unlock for mint",
        p33Preflight.operator,
        { address: P33, abi: contractAbis.p33 },
        "unlock",
        []
      )
    );
    await readStep(steps, "p33 mint/withdraw post-unlock preflight", async () => {
      const period = await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "getPeriod" });
      const isUnlocked = await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "isUnlocked" });
      const periodUnlockStatus = await publicClient.readContract({ address: P33, abi: contractAbis.p33, functionName: "periodUnlockStatus", args: [period] });
      if (!isUnlocked || !periodUnlockStatus) {
        throw new Error(`p33 remained locked on fork before mint: isUnlocked=${isUnlocked} periodUnlockStatus=${periodUnlockStatus}`);
      }
      return { period, isUnlocked, periodUnlockStatus };
    });
  }
  const requiredAssets = BigInt(p33Preflight.previewMint);
  if (requiredAssets > maxMintAssets) {
    throw new Error(`p33 mint preview requires ${requiredAssets} xPHAR, above cap ${maxMintAssets}`);
  }
  if (BigInt(p33Preflight.xPharBalance) < requiredAssets) {
    throw new Error(`p33 mint requires ${requiredAssets} xPHAR, wallet has ${p33Preflight.xPharBalance}`);
  }
  let approvalWasSet = false;
  let caughtError = null;
  try {
    await step(steps, "approve xPHAR -> p33 for mint", () => approve(XPHAR, P33, requiredAssets));
    approvalWasSet = true;
    await step(
      steps,
      "p33 mint shares",
      () => write(
        "p33 mint shares",
        { address: P33, abi: contractAbis.p33 },
        "mint",
        [mintShares, account.address]
      )
    );
    const sharesAfterMint = await readStep(steps, "p33 shares after mint", () => publicClient.readContract({
      address: P33,
      abi: contractAbis.erc20Read,
      functionName: "balanceOf",
      args: [account.address]
    }));
    const maxWithdraw = await readStep(steps, "p33 maxWithdraw after mint", () => publicClient.readContract({
      address: P33,
      abi: contractAbis.p33,
      functionName: "maxWithdraw",
      args: [account.address]
    }));
    const assetsForWithdraw = await readStep(steps, "p33 previewRedeem shares for withdraw", () => publicClient.readContract({
      address: P33,
      abi: contractAbis.p33,
      functionName: "previewRedeem",
      args: [sharesAfterMint]
    }));
    const withdrawAssets = BigInt(assetsForWithdraw) <= BigInt(maxWithdraw) ? BigInt(assetsForWithdraw) : BigInt(maxWithdraw);
    if (withdrawAssets <= 0n) {
      throw new Error(`p33 withdraw asset preview returned ${withdrawAssets}`);
    }
    await readStep(steps, "p33 previewWithdraw assets", () => publicClient.readContract({
      address: P33,
      abi: contractAbis.p33,
      functionName: "previewWithdraw",
      args: [withdrawAssets]
    }));
    const withdrawTx = await step(
      steps,
      "p33 withdraw assets",
      () => write(
        "p33 withdraw assets",
        { address: P33, abi: contractAbis.p33 },
        "withdraw",
        [withdrawAssets, account.address, account.address]
      )
    );
    const remainingShares = await readStep(steps, "p33 shares after withdraw", () => publicClient.readContract({
      address: P33,
      abi: contractAbis.erc20Read,
      functionName: "balanceOf",
      args: [account.address],
      blockNumber: withdrawTx.blockNumber
    }));
    if (BigInt(remainingShares) !== 0n) {
      throw new Error(`p33 mint/withdraw left residual shares ${remainingShares}`);
    }
  } catch (error) {
    caughtError = error;
  } finally {
    if (approvalWasSet) {
      await revokeAllowanceIfNeeded(steps, "revoke xPHAR -> p33 after mint/withdraw", XPHAR, P33);
    }
  }
  if (caughtError) {
    throw caughtError;
  }
});

await phase("autovault_deposit_withdraw", async (steps) => {
  const amount = parseUnits(process.env.AUTO_VAULT_DEPOSIT_AMOUNT ?? "1", 18);
  await readStep(steps, "AutoVault preflight", async () => ({
    isUnlocked: await publicClient.readContract({ address: AUTO_VAULT, abi: contractAbis.autoVault, functionName: "isUnlocked" }),
    outputTokens: await publicClient.readContract({ address: AUTO_VAULT, abi: contractAbis.autoVault, functionName: "getOutputTokens" }),
    balanceOf: await publicClient.readContract({ address: AUTO_VAULT, abi: contractAbis.autoVault, functionName: "balanceOf", args: [account.address] }),
    earned: await publicClient.readContract({ address: AUTO_VAULT, abi: contractAbis.autoVault, functionName: "earned", args: [account.address] }),
    outputPreference: await publicClient.readContract({ address: AUTO_VAULT, abi: contractAbis.autoVault, functionName: "outputPreference", args: [account.address] })
  }));
  await step(steps, "approve xPHAR -> AutoVault", () => approve(XPHAR, AUTO_VAULT, amount));
  await step(
    steps,
    "AutoVault deposit",
    () => write(
      "AutoVault deposit",
      { address: AUTO_VAULT, abi: contractAbis.autoVault },
      "deposit",
      [amount, USDC]
    )
  );
  const shares = await publicClient.readContract({
    address: AUTO_VAULT,
    abi: contractAbis.autoVault,
    functionName: "balanceOf",
    args: [account.address]
  });
  if (shares > 0n) {
    await step(
      steps,
      "AutoVault withdraw",
      () => write(
        "AutoVault withdraw",
        { address: AUTO_VAULT, abi: contractAbis.autoVault },
        "withdraw",
        [shares]
      )
    );
  }
});

await phase("legacy_lp_add_remove", async (steps) => {
  const usdcAmount = parseUnits("0.25", 6);
  const avaxAmount = parseEther("0.001");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const pair = await readStep(steps, "legacy pairFor WAVAX/USDC", () => publicClient.readContract({
    address: ROUTER,
    abi: contractAbis.router,
    functionName: "pairFor",
    args: [WAVAX, USDC, false]
  }));
  await step(steps, "approve USDC -> legacy router", () => approve(USDC, ROUTER, usdcAmount));
  await step(
    steps,
    "addLiquidityETH USDC/WAVAX",
    () => write(
      "addLiquidityETH USDC/WAVAX",
      { address: ROUTER, abi: contractAbis.router },
      "addLiquidityETH",
      [USDC, false, usdcAmount, 0n, 0n, account.address, deadline],
      avaxAmount
    )
  );
  const lpBalance = await readStep(steps, "legacy LP balance after add", () => publicClient.readContract({
    address: pair,
    abi: contractAbis.erc20Read,
    functionName: "balanceOf",
    args: [account.address]
  }));
  if (lpBalance > 0n) {
    const removeMinBps = BigInt(process.env.LEGACY_REMOVE_MIN_BPS ?? (liveBroadcast ? "9500" : "0"));
    const removeQuote = await readStep(steps, "quoteRemoveLiquidity WAVAX/USDC", async () => {
      const result = await publicClient.readContract({
        address: ROUTER,
        abi: contractAbis.router,
        functionName: "quoteRemoveLiquidity",
        args: [WAVAX, USDC, false, lpBalance]
      });
      const amountWAVAX = BigInt(result[0]);
      const amountUSDC = BigInt(result[1]);
      return {
        liquidity: lpBalance,
        amountWAVAX,
        amountUSDC,
        removeMinBps,
        amountWAVAXMin: amountWAVAX * removeMinBps / 10_000n,
        amountUSDCMin: amountUSDC * removeMinBps / 10_000n
      };
    });
    await step(steps, "approve legacy LP -> legacy router", () => approve(pair, ROUTER, lpBalance));
    if (liveBroadcast) {
      await step(
        steps,
        "removeLiquidityETH USDC/WAVAX",
        () => write(
          "removeLiquidityETH USDC/WAVAX",
          { address: ROUTER, abi: contractAbis.router },
          "removeLiquidityETH",
          [USDC, false, lpBalance, removeQuote.amountUSDCMin, removeQuote.amountWAVAXMin, account.address, deadline]
        )
      );
    } else {
      const erc20Remove = await fallbackStep(
        steps,
        "removeLiquidity WAVAX/USDC",
        () => write(
          "removeLiquidity WAVAX/USDC",
          { address: ROUTER, abi: contractAbis.router },
          "removeLiquidity",
          [WAVAX, USDC, false, lpBalance, removeQuote.amountWAVAXMin, removeQuote.amountUSDCMin, account.address, deadline]
        )
      );
      if (!erc20Remove.ok) {
        await step(
          steps,
          "removeLiquidityETH USDC/WAVAX fallback",
          () => write(
            "removeLiquidityETH USDC/WAVAX fallback",
            { address: ROUTER, abi: contractAbis.router },
            "removeLiquidityETH",
            [USDC, false, lpBalance, removeQuote.amountUSDCMin, removeQuote.amountWAVAXMin, account.address, deadline]
          )
        );
      }
    }
    await step(steps, "revoke legacy router USDC approval", () => approve(USDC, ROUTER, 0n));
  }
});

await phase("cl_lp_mint_decrease_collect_burn", async (steps) => {
  const tickSpacing = 10;
  const amount0Desired = parseEther("0.001");
  const amount1Desired = parseUnits("0.01", 6);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const pool = await readStep(steps, "CL factory getPool WAVAX/USDC tickSpacing 10", () => publicClient.readContract({
    address: CL_FACTORY,
    abi: contractAbis.ramsesV3Factory,
    functionName: "getPool",
    args: [WAVAX, USDC, tickSpacing]
  }));

  if (String(pool).toLowerCase() !== CL_WAVAX_USDC_10_POOL.toLowerCase()) {
    throw new Error(`Unexpected CL pool for WAVAX/USDC/10: ${pool}`);
  }

  const slot0 = await readStep(steps, "CL pool slot0", () => publicClient.readContract({
    address: pool,
    abi: contractAbis.ramsesV3Pool,
    functionName: "slot0"
  }));
  await readStep(steps, "CL pool liquidity", () => publicClient.readContract({
    address: pool,
    abi: contractAbis.ramsesV3Pool,
    functionName: "liquidity"
  }));

  const tick = Number(slot0.tick ?? slot0[1]);
  const baseTick = floorToSpacing(tick, tickSpacing);
  const tickLower = baseTick - tickSpacing * 100;
  const tickUpper = baseTick + tickSpacing * 100;

  await step(steps, "approve USDC -> CL position manager", () => approve(USDC, POSITION_MANAGER, amount1Desired));
  const beforeNftBalance = await readStep(steps, "CL NFT balance before mint", () => publicClient.readContract({
    address: POSITION_MANAGER,
    abi: contractAbis.ramsesV3PositionManager,
    functionName: "balanceOf",
    args: [account.address]
  }));

  await step(
    steps,
    "CL mint WAVAX/USDC NFT",
    () => write(
      "CL mint WAVAX/USDC NFT",
      { address: POSITION_MANAGER, abi: contractAbis.ramsesV3PositionManager },
      "mint",
      [{
        token0: WAVAX,
        token1: USDC,
        tickSpacing,
        tickLower,
        tickUpper,
        amount0Desired,
        amount1Desired,
        amount0Min: amount0Desired * 95n / 100n,
        amount1Min: 8500n,
        recipient: account.address,
        deadline
      }],
      amount0Desired
    )
  );

  const tokenId = await readStep(steps, "CL minted tokenId", () => publicClient.readContract({
    address: POSITION_MANAGER,
    abi: contractAbis.ramsesV3PositionManager,
    functionName: "tokenOfOwnerByIndex",
    args: [account.address, beforeNftBalance]
  }));
  const position = await readStep(steps, "CL position after mint", () => publicClient.readContract({
    address: POSITION_MANAGER,
    abi: contractAbis.ramsesV3PositionManager,
    functionName: "positions",
    args: [tokenId]
  }));
  const liquidity = BigInt(String(position.liquidity ?? position[5]));

  if (liquidity > 0n) {
    await step(
      steps,
      "CL decrease full liquidity",
      () => write(
        "CL decrease full liquidity",
        { address: POSITION_MANAGER, abi: contractAbis.ramsesV3PositionManager },
        "decreaseLiquidity",
        [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }],
        0n,
        10_000_000n
      )
    );
    await step(
      steps,
      "CL collect owed tokens",
      () => write(
        "CL collect owed tokens",
        { address: POSITION_MANAGER, abi: contractAbis.ramsesV3PositionManager },
        "collect",
        [{ tokenId, recipient: account.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]
      )
    );
    await step(
      steps,
      "CL burn empty NFT",
      () => write(
        "CL burn empty NFT",
        { address: POSITION_MANAGER, abi: contractAbis.ramsesV3PositionManager },
        "burn",
        [tokenId]
      )
    );
    await step(steps, "revoke CL position manager USDC approval", () => approve(USDC, POSITION_MANAGER, 0n));
  }
});

await phase("dlmm_swap_lp_remove", async (steps) => {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const nativeSwapAmount = parseEther("0.001");
  const path = { pairBinSteps: [5n], versions: [2], tokenPath: [WAVAX, USDC] };
  await step(
    steps,
    "DLMM swapExactNATIVEForTokens",
    () => write(
      "DLMM swapExactNATIVEForTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapExactNATIVEForTokens",
      [1n, path, account.address, deadline],
      nativeSwapAmount
    )
  );
  const activeId = await readStep(steps, "DLMM active bin after swap", () => publicClient.readContract({
    address: DLMM_POOL,
    abi: contractAbis.dlmmPool,
    functionName: "getActiveId"
  }));
  const binOffset = BigInt(process.env.DLMM_LIQUIDITY_BIN_OFFSET ?? "1");
  const liquidityBinId = BigInt(activeId) + binOffset;
  const amountX = parseEther(process.env.DLMM_LIQUIDITY_NATIVE_AMOUNT_AVAX ?? "0.001");
  const amountY = parseUnits(process.env.DLMM_LIQUIDITY_USDC_AMOUNT ?? "0", 6);
  const liquidityParameters = {
    tokenX: WAVAX,
    tokenY: USDC,
    binStep: 5n,
    amountX,
    amountY,
    amountXMin: 0n,
    amountYMin: 0n,
    activeIdDesired: BigInt(activeId),
    idSlippage: 2n,
    deltaIds: [binOffset],
    distributionX: [parseEther("1")],
    distributionY: [amountY === 0n ? 0n : parseEther("1")],
    to: account.address,
    refundTo: account.address,
    deadline
  };
  await readStep(steps, "DLMM off-active liquidity parameters", async () => ({
    router: DLMM_ROUTER,
    pool: DLMM_POOL,
    liquidityBinId,
    binOffset,
    liquidityParameters
  }));
  const balanceBefore = await readStep(steps, "DLMM off-active bin balance before add", () => publicClient.readContract({
    address: DLMM_POOL,
    abi: contractAbis.dlmmPool,
    functionName: "balanceOf",
    args: [account.address, liquidityBinId]
  }));
  if (amountY > 0n) {
    await step(steps, "approve USDC -> DLMM router", () => approve(USDC, DLMM_ROUTER, amountY));
  }
  await step(
    steps,
    "DLMM addLiquidityNATIVE off-active bin",
    () => write(
      "DLMM addLiquidityNATIVE off-active bin",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "addLiquidityNATIVE",
      [liquidityParameters],
      amountX
    )
  );
  if (amountY > 0n) {
    await step(steps, "revoke DLMM router USDC approval", () => approve(USDC, DLMM_ROUTER, 0n));
  }

  const balanceAfterAdd = await readStep(steps, "DLMM off-active bin balance after add", () => publicClient.readContract({
    address: DLMM_POOL,
    abi: contractAbis.dlmmPool,
    functionName: "balanceOf",
    args: [account.address, liquidityBinId]
  }));
  const binBalance = balanceAfterAdd - BigInt(balanceBefore);
  await readStep(steps, "DLMM off-active bin added balance delta", async () => ({
    liquidityBinId,
    balanceBefore,
    balanceAfterAdd,
    binBalance
  }));
  if (binBalance <= 0n) {
    throw new Error(`DLMM off-active bin add did not increase balance for id ${liquidityBinId}`);
  }
  if (binBalance > 0n) {
    await step(
      steps,
      "DLMM approveForAll router",
      () => write(
        "DLMM approveForAll router",
        { address: DLMM_POOL, abi: contractAbis.dlmmPool },
        "approveForAll",
        [DLMM_ROUTER, true]
      )
    );
    await step(
      steps,
      "DLMM removeLiquidityNATIVE off-active bin",
      () => write(
        "DLMM removeLiquidityNATIVE off-active bin",
        { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
        "removeLiquidityNATIVE",
        [USDC, 5, 0n, 0n, [liquidityBinId], [binBalance], account.address, deadline]
      )
    );
    const balanceAfterRemove = await readStep(steps, "DLMM off-active bin balance after remove", () => publicClient.readContract({
      address: DLMM_POOL,
      abi: contractAbis.dlmmPool,
      functionName: "balanceOf",
      args: [account.address, liquidityBinId]
    }));
    if (BigInt(balanceAfterRemove) > BigInt(balanceBefore)) {
      throw new Error(`DLMM off-active bin remove left unexpected balance for id ${liquidityBinId}: before=${balanceBefore} after=${balanceAfterRemove}`);
    }
    await step(
      steps,
      "DLMM revoke approveForAll router",
      () => write(
        "DLMM revoke approveForAll router",
        { address: DLMM_POOL, abi: contractAbis.dlmmPool },
        "approveForAll",
        [DLMM_ROUTER, false]
      )
    );
  }
});

await phase("dlmm_swap_variants", async (steps) => {
  if (liveBroadcast) {
    steps.push({
      ok: true,
      label: "DLMM swap variants skipped live",
      skipped: true,
      result: "Exact-output and fee-on-transfer DLMM swap variants are fork-only in this harness to avoid extra live wallet spend."
    });
    return { status: "partial", reason: "DLMM swap variant coverage is fork-only." };
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const nativeToUsdcPath = { pairBinSteps: [5n], versions: [2], tokenPath: [WAVAX, USDC] };
  const usdcToNativePath = { pairBinSteps: [5n], versions: [2], tokenPath: [USDC, WAVAX] };
  const usdcAmountIn = parseUnits("0.005", 6);
  const smallUsdcOut = 1000n;
  const smallNativeOut = parseEther("0.000001");
  const exactOutBufferBps = BigInt(process.env.DLMM_EXACT_OUT_BUFFER_BPS ?? "50000");
  const exactOutUsdcMaxFloor = parseUnits(process.env.DLMM_EXACT_OUT_USDC_MAX_FLOOR ?? "1", 6);

  const nativeExactOutQuote = await readStep(steps, "DLMM variant quote native exact-out USDC", () => publicClient.readContract({
    address: DLMM_ROUTER,
    abi: contractAbis.dlmmRouter,
    functionName: "getSwapIn",
    args: [DLMM_POOL, smallUsdcOut, true]
  }));
  const nativeAmountInMax = BigInt(nativeExactOutQuote[0]) * exactOutBufferBps / 10_000n + 1n;
  await step(
    steps,
    "DLMM swapNATIVEForExactTokens",
    () => write(
      "DLMM swapNATIVEForExactTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapNATIVEForExactTokens",
      [smallUsdcOut, nativeToUsdcPath, account.address, deadline],
      nativeAmountInMax
    )
  );
  await step(
    steps,
    "DLMM swapExactNATIVEForTokensSupportingFeeOnTransferTokens",
    () => write(
      "DLMM swapExactNATIVEForTokensSupportingFeeOnTransferTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapExactNATIVEForTokensSupportingFeeOnTransferTokens",
      [1n, nativeToUsdcPath, account.address, deadline],
      parseEther("0.0001")
    )
  );

  const usdcExactNativeQuote = await readStep(steps, "DLMM variant quote USDC exact-out native", () => publicClient.readContract({
    address: DLMM_ROUTER,
    abi: contractAbis.dlmmRouter,
    functionName: "getSwapIn",
    args: [DLMM_POOL, smallNativeOut, false]
  }));
  const usdcExactTokenQuote = await readStep(steps, "DLMM variant quote USDC exact-out WAVAX", () => publicClient.readContract({
    address: DLMM_ROUTER,
    abi: contractAbis.dlmmRouter,
    functionName: "getSwapIn",
    args: [DLMM_POOL, smallNativeOut, false]
  }));
  const maxUsdcForNativeOut = [BigInt(usdcExactNativeQuote[0]) * exactOutBufferBps / 10_000n + 1n, exactOutUsdcMaxFloor]
    .reduce((max, value) => value > max ? value : max, 0n);
  let maxUsdcForTokenOut = [BigInt(usdcExactTokenQuote[0]) * exactOutBufferBps / 10_000n + 1n, exactOutUsdcMaxFloor]
    .reduce((max, value) => value > max ? value : max, 0n);
  const tokenVariantApproval = [parseUnits("0.1", 6), maxUsdcForNativeOut + maxUsdcForTokenOut + usdcAmountIn * 4n]
    .reduce((max, value) => value > max ? value : max, 0n);
  await step(steps, "approve USDC -> DLMM router for swap variants", () => approve(USDC, DLMM_ROUTER, tokenVariantApproval));
  await step(
    steps,
    "DLMM swapTokensForExactNATIVE",
    () => write(
      "DLMM swapTokensForExactNATIVE",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapTokensForExactNATIVE",
      [smallNativeOut, maxUsdcForNativeOut, usdcToNativePath, account.address, deadline]
    )
  );
  const usdcExactTokenQuoteAfterNative = await readStep(steps, "DLMM variant quote USDC exact-out WAVAX after native exact-out", () => publicClient.readContract({
    address: DLMM_ROUTER,
    abi: contractAbis.dlmmRouter,
    functionName: "getSwapIn",
    args: [DLMM_POOL, smallNativeOut, false]
  }));
  maxUsdcForTokenOut = [BigInt(usdcExactTokenQuoteAfterNative[0]) * exactOutBufferBps / 10_000n + 1n, exactOutUsdcMaxFloor]
    .reduce((max, value) => value > max ? value : max, 0n);
  await step(
    steps,
    "DLMM swapTokensForExactTokens",
    () => write(
      "DLMM swapTokensForExactTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapTokensForExactTokens",
      [smallNativeOut, maxUsdcForTokenOut, usdcToNativePath, account.address, deadline]
    )
  );
  await step(
    steps,
    "DLMM swapExactTokensForNATIVE",
    () => write(
      "DLMM swapExactTokensForNATIVE",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapExactTokensForNATIVE",
      [usdcAmountIn, 1n, usdcToNativePath, account.address, deadline]
    )
  );
  await step(
    steps,
    "DLMM swapExactTokensForNATIVESupportingFeeOnTransferTokens",
    () => write(
      "DLMM swapExactTokensForNATIVESupportingFeeOnTransferTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapExactTokensForNATIVESupportingFeeOnTransferTokens",
      [usdcAmountIn, 1n, usdcToNativePath, account.address, deadline]
    )
  );
  await step(
    steps,
    "DLMM swapExactTokensForTokens",
    () => write(
      "DLMM swapExactTokensForTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapExactTokensForTokens",
      [usdcAmountIn, 1n, usdcToNativePath, account.address, deadline]
    )
  );
  await step(
    steps,
    "DLMM swapExactTokensForTokensSupportingFeeOnTransferTokens",
    () => write(
      "DLMM swapExactTokensForTokensSupportingFeeOnTransferTokens",
      { address: DLMM_ROUTER, abi: contractAbis.dlmmRouter },
      "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      [usdcAmountIn, 1n, usdcToNativePath, account.address, deadline]
    )
  );
  await step(steps, "revoke DLMM router USDC approval after swap variants", () => approve(USDC, DLMM_ROUTER, 0n));
});

report.final = {
  balances: await snapshot("final"),
  approvals: await allowanceSnapshot("final")
};
report.summary = {
  phases: report.phases.length,
  passed: report.phases.filter((entry) => entry.status === "passed").length,
  partial: report.phases.filter((entry) => entry.status === "partial").length,
  skipped: report.phases.filter((entry) => entry.status === "skipped").length,
  failed: report.phases.filter((entry) => entry.status === "failed").length
};
report.ok = report.summary.failed === 0;

console.log(stringify(report));
