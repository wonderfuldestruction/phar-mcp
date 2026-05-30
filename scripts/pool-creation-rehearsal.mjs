#!/usr/bin/env node
import { createPublicClient, createWalletClient, decodeErrorResult, http, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import {
  buildMappedWorkflowTx,
  clLiquidityActionMap,
  dlmmActionMap,
  legacyLiquidityActionMap
} from "../dist/workflowTools.js";

const rpcUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl)) {
  throw new Error("pool-creation-rehearsal only runs against a local fork RPC.");
}

const transport = http(rpcUrl, { timeout: 120_000, retryCount: 0 });
const publicClient = createPublicClient({ chain: avalanche, transport });
const account = privateKeyToAccount(process.env.ANVIL_TEST_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const walletClient = createWalletClient({ account, chain: avalanche, transport });

const PHAR = contractRegistry.pharToken.address;
const XPHAR = contractRegistry.xPharToken.address;
const ZERO = "0x0000000000000000000000000000000000000000";
const TICK_SPACING = 10;
const CLOSED_REFERENCE_BIN_STEP = 5;
const ACTIVE_ID_ONE_TO_ONE = 8_388_608;
const SQRT_PRICE_X96_ONE_TO_ONE = 2n ** 96n;
const dlmmPoolCreationErrorEvidence = {
  signature: "LBFactory__PresetIsLockedForUsers(address,uint256)",
  selector: "0x09f85fce",
  source: "Pharaoh DLMMFactory ABI custom-error selector and fork revert evidence",
  sourceUrl: contractRegistry.dlmmFactory.explorerUrl,
  meaning: "DLMM/LB factory preset exists but is closed to non-owner callers; router createLBPair bubbles the factory error."
};
const knownErrorAbi = [
  ...contractAbis.dlmmFactory.filter((item) => item.type === "error")
];

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function shortError(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function errorSelector(error) {
  return String(error?.message ?? error).match(/0x[0-9a-fA-F]{8}/)?.[0];
}

function errorSignature(item) {
  const inputs = (item.inputs ?? []).map((input) => input.type).join(",");
  return `${item.name}(${inputs})`;
}

function revertData(error) {
  const message = String(error?.message ?? error);
  const customErrorData = message.match(/custom error (0x[0-9a-fA-F]{8}):\s*([0-9a-fA-F]+)/);
  if (customErrorData) return `${customErrorData[1]}${customErrorData[2]}`;
  return message.match(/(?:revert data|data):\s*(0x[0-9a-fA-F]{8,})/i)?.[1];
}

function describeError(error) {
  const message = shortError(error);
  const data = revertData(error);
  const selector = data?.slice(0, 10) ?? errorSelector(error);
  let decodedError = null;

  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: knownErrorAbi, data });
      decodedError = {
        name: decoded.errorName,
        signature: errorSignature(decoded.abiItem),
        selector: toFunctionSelector(errorSignature(decoded.abiItem)),
        args: decoded.args ?? []
      };
    } catch {
      decodedError = null;
    }
  }

  return { message, selector, revertData: data ?? null, decodedError };
}

async function snapshot() {
  return publicClient.request({ method: "evm_snapshot", params: [] });
}

async function revert(snapshotId) {
  return publicClient.request({ method: "evm_revert", params: [snapshotId] });
}

async function sendBuiltTx(tx) {
  const hash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? "0"),
    gas: 10_000_000n
  });
  await publicClient.request({ method: "evm_mine", params: [] }).catch(() => undefined);
  return hash;
}

async function legacyPair(stable) {
  const pair = await publicClient.readContract({
    address: contractRegistry.pairFactory.address,
    abi: contractAbis.pairFactory,
    functionName: "getPair",
    args: [PHAR, XPHAR, stable]
  });
  const isPair = pair !== ZERO
    ? await publicClient.readContract({
      address: contractRegistry.pairFactory.address,
      abi: contractAbis.pairFactory,
      functionName: "isPair",
      args: [pair]
    }).catch(() => false)
    : false;
  return { pair, exists: pair !== ZERO, isPair };
}

async function clPool() {
  const pool = await publicClient.readContract({
    address: contractRegistry.ramsesV3Factory.address,
    abi: contractAbis.ramsesV3Factory,
    functionName: "getPool",
    args: [PHAR, XPHAR, TICK_SPACING]
  });
  const slot0 = pool !== ZERO
    ? await publicClient.readContract({
      address: pool,
      abi: contractAbis.ramsesV3Pool,
      functionName: "slot0"
    }).catch((error) => ({ error: shortError(error) }))
    : null;
  return { pool, exists: pool !== ZERO, slot0 };
}

function presetObject(preset) {
  return {
    baseFactor: preset[0],
    filterPeriod: preset[1],
    decayPeriod: preset[2],
    reductionFactor: preset[3],
    variableFeeControl: preset[4],
    protocolShare: preset[5],
    maxVolatilityAccumulator: preset[6],
    isOpen: preset[7]
  };
}

async function dlmmInfo(binStep) {
  const [pairInformation, preset] = await Promise.all([
    publicClient.readContract({
      address: contractRegistry.dlmmFactory.address,
      abi: contractAbis.dlmmFactory,
      functionName: "getLBPairInformation",
      args: [PHAR, XPHAR, binStep]
    }),
    publicClient.readContract({
      address: contractRegistry.dlmmFactory.address,
      abi: contractAbis.dlmmFactory,
      functionName: "getPreset",
      args: [binStep]
    })
  ]);
  return {
    binStep: BigInt(binStep),
    pairInformation,
    preset: presetObject(preset)
  };
}

async function dlmmCreationDiscovery() {
  const [allBinSteps, openBinSteps] = await Promise.all([
    publicClient.readContract({
      address: contractRegistry.dlmmFactory.address,
      abi: contractAbis.dlmmFactory,
      functionName: "getAllBinSteps"
    }),
    publicClient.readContract({
      address: contractRegistry.dlmmFactory.address,
      abi: contractAbis.dlmmFactory,
      functionName: "getOpenBinSteps"
    })
  ]);
  const binStepRows = await Promise.all(allBinSteps.map(async (binStep) => {
    const info = await dlmmInfo(binStep);
    return {
      binStep: BigInt(binStep),
      pairInformation: info.pairInformation,
      preset: info.preset,
      pairExists: info.pairInformation.LBPair !== ZERO
    };
  }));
  const openBinStepKeys = new Set(openBinSteps.map((binStep) => BigInt(binStep).toString()));
  const openAbsentCandidate = binStepRows.find((row) => openBinStepKeys.has(row.binStep.toString()) && !row.pairExists);
  return {
    allBinSteps,
    openBinSteps,
    binStepRows,
    openAbsentCandidate: openAbsentCandidate ? {
      binStep: openAbsentCandidate.binStep,
      preset: openAbsentCandidate.preset,
      pairInformation: openAbsentCandidate.pairInformation
    } : null,
    normalUserCreationStatus: openAbsentCandidate
      ? "open_candidate_available"
      : openBinSteps.length === 0
        ? "blocked_no_open_presets"
        : "blocked_no_absent_open_pair_for_test_tokens"
  };
}

async function runMutableCase({ domain, label, beforeRead, afterRead, tx, validate }) {
  const snapshotId = await snapshot();
  let result;
  try {
    const before = await beforeRead();
    const hash = await sendBuiltTx(tx);
    const after = await afterRead();
    const validation = validate(before, after);
    result = {
      domain,
      label,
      ok: validation.ok,
      status: validation.ok ? "passed" : "failed",
      hash,
      to: tx.to,
      signature: tx.signature,
      before,
      after,
      validation
    };
  } catch (error) {
    const described = describeError(error);
    result = {
      domain,
      label,
      ok: false,
      status: "failed",
      to: tx.to,
      signature: tx.signature,
      error: described.message,
      selector: described.selector,
      revertData: described.revertData,
      decodedError: described.decodedError
    };
  } finally {
    await revert(snapshotId).catch(() => undefined);
  }
  return result;
}

function validateLegacyCreation(before, after) {
  return {
    ok: before.exists === false && after.exists === true && after.isPair === true,
    expectation: "pair absent before transaction and registered as PairFactory.isPair after transaction"
  };
}

function validateClCreation(before, after) {
  const initialized = Array.isArray(after.slot0)
    && after.slot0[0] === SQRT_PRICE_X96_ONE_TO_ONE
    && after.slot0[6] === true;
  return {
    ok: before.exists === false && after.exists === true && initialized,
    expectation: "CL pool absent before transaction and initialized at sqrtPriceX96=2^96 after transaction"
  };
}

function validateDlmmCreation(before, after) {
  return {
    ok: before.pairInformation.LBPair === ZERO
      && after.pairInformation.LBPair !== ZERO
      && after.preset.isOpen === true,
    expectation: "DLMM pair absent before transaction and registered after transaction using an open binStep preset"
  };
}

function dlmmBlockedReason(discovery, binStep) {
  if (discovery.openBinSteps.length === 0) {
    return "DLMMFactory.getOpenBinSteps() currently returns no open presets, so normal users cannot create DLMM pairs on this fork baseline.";
  }
  return `DLMM factory preset is currently closed to normal users for binStep ${binStep}. Pair creation calldata is exposed, but fork execution is blocked by protocol configuration.`;
}

async function runBlockedCase({ domain, label, tx, binStep, discovery }) {
  const before = await dlmmInfo(binStep);
  try {
    await publicClient.call({
      account: account.address,
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? "0")
    });
    const after = await dlmmInfo(binStep);
    return {
      domain,
      label,
      ok: false,
      status: "unexpected_success",
      to: tx.to,
      signature: tx.signature,
      before,
      after
    };
  } catch (error) {
    const described = describeError(error);
    return {
      domain,
      label,
      ok: true,
      status: "blocked",
      to: tx.to,
      signature: tx.signature,
      before,
      selector: described.selector,
      decodedError: described.decodedError,
      error: described.message,
      blocker: dlmmBlockedReason(discovery, binStep)
    };
  }
}

const legacyVolatileTx = buildMappedWorkflowTx("createPair", legacyLiquidityActionMap, {
  args: [PHAR, XPHAR, false]
});
const legacyStableTx = buildMappedWorkflowTx("createPair", legacyLiquidityActionMap, {
  args: [PHAR, XPHAR, true]
});
const clCreatePoolTx = buildMappedWorkflowTx("createPool", clLiquidityActionMap, {
  args: [PHAR, XPHAR, TICK_SPACING, SQRT_PRICE_X96_ONE_TO_ONE]
});
const clCreateIfNeededTx = buildMappedWorkflowTx("createAndInitializePoolIfNecessary", clLiquidityActionMap, {
  args: [PHAR, XPHAR, TICK_SPACING, SQRT_PRICE_X96_ONE_TO_ONE]
});

const dlmmDiscovery = await dlmmCreationDiscovery();
const chainId = await publicClient.getChainId();
const forkStartBlock = await publicClient.getBlockNumber();
const results = [];
results.push(await runMutableCase({
  domain: "legacy",
  label: "PairFactory createPair(PHAR,xPHAR,volatile)",
  beforeRead: () => legacyPair(false),
  afterRead: () => legacyPair(false),
  tx: legacyVolatileTx,
  validate: validateLegacyCreation
}));
results.push(await runMutableCase({
  domain: "legacy",
  label: "PairFactory createPair(PHAR,xPHAR,stable)",
  beforeRead: () => legacyPair(true),
  afterRead: () => legacyPair(true),
  tx: legacyStableTx,
  validate: validateLegacyCreation
}));
results.push(await runMutableCase({
  domain: "cl",
  label: "RamsesV3Factory createPool(PHAR,xPHAR,10,1:1)",
  beforeRead: clPool,
  afterRead: clPool,
  tx: clCreatePoolTx,
  validate: validateClCreation
}));
results.push(await runMutableCase({
  domain: "cl",
  label: "PositionManager createAndInitializePoolIfNecessary(PHAR,xPHAR,10,1:1)",
  beforeRead: clPool,
  afterRead: clPool,
  tx: clCreateIfNeededTx,
  validate: validateClCreation
}));
if (dlmmDiscovery.openAbsentCandidate) {
  const binStep = dlmmDiscovery.openAbsentCandidate.binStep;
  const dlmmRouterOpenCreateTx = buildMappedWorkflowTx("routerCreateLBPair", dlmmActionMap, {
    args: [PHAR, XPHAR, ACTIVE_ID_ONE_TO_ONE, binStep]
  });
  const dlmmFactoryOpenCreateTx = buildMappedWorkflowTx("factoryCreateLBPair", dlmmActionMap, {
    args: [PHAR, XPHAR, ACTIVE_ID_ONE_TO_ONE, binStep]
  });
  results.push(await runMutableCase({
    domain: "dlmm",
    label: `DLMMRouter createLBPair(PHAR,xPHAR,activeId=8388608,binStep=${binStep})`,
    beforeRead: () => dlmmInfo(binStep),
    afterRead: () => dlmmInfo(binStep),
    tx: dlmmRouterOpenCreateTx,
    validate: validateDlmmCreation
  }));
  results.push(await runMutableCase({
    domain: "dlmm",
    label: `DLMMFactory createLBPair(PHAR,xPHAR,activeId=8388608,binStep=${binStep})`,
    beforeRead: () => dlmmInfo(binStep),
    afterRead: () => dlmmInfo(binStep),
    tx: dlmmFactoryOpenCreateTx,
    validate: validateDlmmCreation
  }));
} else {
  const dlmmRouterClosedCreateTx = buildMappedWorkflowTx("routerCreateLBPair", dlmmActionMap, {
    args: [PHAR, XPHAR, ACTIVE_ID_ONE_TO_ONE, CLOSED_REFERENCE_BIN_STEP]
  });
  const dlmmFactoryClosedCreateTx = buildMappedWorkflowTx("factoryCreateLBPair", dlmmActionMap, {
    args: [PHAR, XPHAR, ACTIVE_ID_ONE_TO_ONE, CLOSED_REFERENCE_BIN_STEP]
  });
  results.push(await runBlockedCase({
    domain: "dlmm",
    label: `DLMMRouter createLBPair(PHAR,xPHAR,activeId=8388608,binStep=${CLOSED_REFERENCE_BIN_STEP})`,
    tx: dlmmRouterClosedCreateTx,
    binStep: CLOSED_REFERENCE_BIN_STEP,
    discovery: dlmmDiscovery
  }));
  results.push(await runBlockedCase({
    domain: "dlmm",
    label: `DLMMFactory createLBPair(PHAR,xPHAR,activeId=8388608,binStep=${CLOSED_REFERENCE_BIN_STEP})`,
    tx: dlmmFactoryClosedCreateTx,
    binStep: CLOSED_REFERENCE_BIN_STEP,
    discovery: dlmmDiscovery
  }));
}

const finalBlockNumber = await publicClient.getBlockNumber();
const report = {
  timestamp: new Date().toISOString(),
  mode: "fork",
  chainId,
  rpcUrl,
  forkStartBlock,
  blockNumber: finalBlockNumber,
  account: account.address,
  pairUnderTest: {
    tokenA: PHAR,
    tokenB: XPHAR,
    reason: "PHAR/xPHAR had no legacy, CL, or DLMM pool for the tested parameters on the fork baseline, making it a real-token absent-pool creation target."
  },
  dlmmCreationDiscovery: dlmmDiscovery,
  dlmmPoolCreationErrorEvidence,
  summary: {
    cases: results.length,
    passed: results.filter((item) => item.ok && item.status === "passed").length,
    blockedAsExpected: results.filter((item) => item.ok && item.status === "blocked").length,
    failed: results.filter((item) => !item.ok).length
  },
  ok: results.every((item) => item.ok),
  results,
  note: "Fork-only pool creation rehearsal. No live transaction is broadcast. Successful mutable cases are isolated with evm_snapshot/evm_revert. DLMM createLBPair is recorded as protocol-config-blocked when no open preset is available for normal users; if an open absent PHAR/xPHAR binStep appears, the rehearsal attempts router and factory creation."
};

console.log(stringify(report));
if (report.summary.failed > 0 && process.env.STOP_ON_FAIL === "1") process.exit(1);
