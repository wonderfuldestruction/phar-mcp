#!/usr/bin/env node
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import { walletPositionsRead } from "../dist/queryTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });
const dlmmRewardedPool = process.env.PHAR_MCP_REWARDED_DLMM_POOL ?? "0x87206a5a6eDDd4e22423425BA66C2591551BFc6f";
const maxClTokenIds = Number(process.env.WALLET_STATE_MAX_CL_TOKEN_IDS ?? "50");
const dlmmMaxIds = Number(process.env.WALLET_STATE_DLMM_MAX_IDS ?? "64");
const dlmmActiveIdRadius = Number(process.env.WALLET_STATE_DLMM_ACTIVE_ID_RADIUS ?? "2");
const dlmmExtraWavaxUsdcIds = (process.env.WALLET_STATE_DLMM_WAVAX_USDC_EXTRA_IDS ?? "8337715,8337716,8337717,8337718,8337719,8337720")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const tokens = [
  ["USDC", contractRegistry.usdcNative.address, 6],
  ["WAVAX", contractRegistry.wavax.address, 18],
  ["PHAR", contractRegistry.pharToken.address, 18],
  ["xPHAR", contractRegistry.xPharToken.address, 18],
  ["p33", contractRegistry.p33.address, 18],
  ["AutoVault", contractRegistry.autoVault.address, 18]
];

const allowanceTokens = tokens.filter(([symbol]) => symbol !== "AutoVault");

const spenders = [
  ["legacyRouter", contractRegistry.router.address],
  ["universalRouter", contractRegistry.universalRouter.address],
  ["swapRouter", contractRegistry.swapRouter.address],
  ["positionManager", contractRegistry.ramsesV3PositionManager.address],
  ["dlmmRouter", contractRegistry.dlmmRouter.address],
  ["xPharToken", contractRegistry.xPharToken.address],
  ["p33", contractRegistry.p33.address],
  ["voteModule", contractRegistry.voteModule.address],
  ["autoVault", contractRegistry.autoVault.address]
];

async function readContract(address, abi, functionName, args = []) {
  try {
    return { ok: true, value: await client.readContract({ address, abi, functionName, args }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function readValue(read) {
  if (!read || typeof read !== "object" || read.ok !== true || !Object.hasOwn(read, "result")) return null;
  return typeof read.result === "bigint" ? read.result.toString() : read.result;
}

function centeredIds(center, radius) {
  if (!center || radius < 0) return [];
  const out = [];
  for (let offset = -radius; offset <= radius; offset += 1) {
    const id = center + BigInt(offset);
    if (id >= 0n) out.push(id.toString());
  }
  return out;
}

function walletPositionSummary(walletPositions) {
  const clResult = walletPositions?.protocol?.clNfts?.ok ? walletPositions.protocol.clNfts.result : null;
  const clTokenIds = (clResult?.tokenIds ?? []).map((id) => id.toString());
  const dlmmPools = Array.isArray(walletPositions?.protocol?.dlmmPools) ? walletPositions.protocol.dlmmPools : [];
  const dlmmPoolSummaries = dlmmPools.map((pool) => {
    const nonzeroBinBalances = (pool.nonzeroBalances ?? []).map((entry) => ({
      id: entry.id?.toString?.() ?? String(entry.id),
      balanceRaw: readValue(entry.balance)
    }));
    return {
      pair: pool.pair,
      operator: pool.operator,
      rewarder: pool.rewarder,
      idsCheckedCount: (pool.idsChecked ?? []).length,
      idsChecked: (pool.idsChecked ?? []).map((id) => id.toString()),
      nonzeroBinBalanceCount: nonzeroBinBalances.length,
      nonzeroBinBalances,
      rangeScanTruncated: Boolean(pool.rangeScanTruncated),
      isApprovedForAll: pool.isApprovedForAll,
      warning: pool.warning ?? null
    };
  });
  const rewards = walletPositions?.protocol?.rewards;
  const rewardResult = rewards?.ok ? rewards.result : null;

  return {
    account: walletPositions.account,
    blockTag: walletPositions.blockTag,
    tokenCount: walletPositions.tokens?.length ?? 0,
    spenderCount: walletPositions.spenders?.length ?? 0,
    clNfts: {
      balanceRaw: readValue(clResult?.balance),
      discoveredTokenIds: clTokenIds,
      positionCount: clResult?.positions?.length ?? 0,
      truncated: Boolean(clResult?.truncated),
      hasActivePositions: clTokenIds.length > 0
    },
    dlmmPools: {
      poolCount: dlmmPoolSummaries.length,
      idsCheckedCount: dlmmPoolSummaries.reduce((sum, pool) => sum + pool.idsCheckedCount, 0),
      nonzeroBinBalanceCount: dlmmPoolSummaries.reduce((sum, pool) => sum + pool.nonzeroBinBalanceCount, 0),
      hasNonzeroBinBalances: dlmmPoolSummaries.some((pool) => pool.nonzeroBinBalanceCount > 0),
      pools: dlmmPoolSummaries
    },
    rewardClaimability: {
      included: Boolean(rewards),
      ok: rewards?.ok ?? null,
      claimable: rewardResult?.claimable ?? null,
      blockers: rewardResult?.blockers ?? [],
      rewardContext: walletPositions?.protocol?.rewardContext ?? null
    },
    note: "Derived from pharaoh_wallet_positions_read-equivalent bounded discovery. Empty CL NFT and DLMM bin arrays mean no positions were found inside this report's scan scope."
  };
}

function approvalCleanupSummary(allowances, dlmmPoolApprovals) {
  const allowanceEntries = Object.entries(allowances ?? {});
  const allowanceSpenders = new Set();
  const nonzeroAllowanceRows = [];
  const allowanceReadErrors = [];
  let allowanceRowCount = 0;

  for (const [token, spendersByName] of Object.entries(allowances ?? {})) {
    for (const [spenderName, allowance] of Object.entries(spendersByName ?? {})) {
      allowanceRowCount += 1;
      allowanceSpenders.add(spenderName);
      const row = {
        token,
        spenderName,
        spender: allowance?.spender ?? null,
        raw: allowance?.raw ?? null,
        formatted: allowance?.formatted ?? null
      };

      if (typeof allowance?.raw !== "string") {
        allowanceReadErrors.push({
          standard: "ERC20",
          ...row,
          error: allowance?.error ?? "allowance raw value missing"
        });
        continue;
      }

      try {
        if (BigInt(allowance.raw) !== 0n) nonzeroAllowanceRows.push(row);
      } catch (error) {
        allowanceReadErrors.push({
          standard: "ERC20",
          ...row,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const nonzeroDlmmApprovalRows = [];
  const dlmmApprovalReadErrors = [];
  let dlmmApprovalRowCount = 0;
  for (const [key, approved] of Object.entries(dlmmPoolApprovals ?? {})) {
    dlmmApprovalRowCount += 1;
    if (typeof approved !== "boolean") {
      dlmmApprovalReadErrors.push({
        standard: "DLMM_POOL",
        key,
        error: approved?.error ?? "approval value is not boolean"
      });
      continue;
    }
    if (approved) nonzeroDlmmApprovalRows.push({ key, approved });
  }

  const allTrackedAllowancesZero = nonzeroAllowanceRows.length === 0 && allowanceReadErrors.length === 0;
  const approvalsCleared = allTrackedAllowancesZero &&
    nonzeroDlmmApprovalRows.length === 0 &&
    dlmmApprovalReadErrors.length === 0;

  return {
    approvalsCleared,
    allTrackedAllowancesZero,
    allowanceTokenCount: allowanceEntries.length,
    allowanceSpenderCount: allowanceSpenders.size,
    allowanceRowCount,
    nonzeroAllowanceRowCount: nonzeroAllowanceRows.length,
    nonzeroAllowanceRows,
    allowanceReadErrorCount: allowanceReadErrors.length,
    allowanceReadErrors,
    dlmmApprovalRowCount,
    dlmmApprovedRowCount: nonzeroDlmmApprovalRows.length,
    nonzeroDlmmApprovalRows,
    dlmmApprovalReadErrorCount: dlmmApprovalReadErrors.length,
    dlmmApprovalReadErrors,
    approvalReadFailureCount: allowanceReadErrors.length + dlmmApprovalReadErrors.length,
    note: "Derived from tracked ERC20 allowances plus DLMM pool approval flags. approvalsCleared is false if any tracked approval is nonzero or any approval read fails."
  };
}

const balances = {};
for (const [symbol, address, decimals] of tokens) {
  const raw = await readContract(address, contractAbis.erc20Read, "balanceOf", [wallet]);
  balances[symbol] = raw.ok
    ? { address, raw: raw.value.toString(), formatted: formatUnits(raw.value, decimals) }
    : { address, error: raw.error };
}

const allowances = {};
for (const [symbol, tokenAddress, decimals] of allowanceTokens) {
  allowances[symbol] = {};
  for (const [spenderName, spender] of spenders) {
    const raw = await readContract(tokenAddress, contractAbis.erc20Read, "allowance", [wallet, spender]);
    allowances[symbol][spenderName] = raw.ok
      ? { spender, raw: raw.value.toString(), formatted: formatUnits(raw.value, decimals) }
      : { spender, error: raw.error };
  }
}

const dlmmApproval = await readContract(
  contractRegistry.dlmmWavaxUsdc5Pool.address,
  contractAbis.dlmmPool,
  "isApprovedForAll",
  [wallet, contractRegistry.dlmmRouter.address]
);
const dlmmPoolApprovals = {
  wavaxUsdc5ToRouter: dlmmApproval.ok ? dlmmApproval.value : { error: dlmmApproval.error }
};
const approvalCleanup = approvalCleanupSummary(allowances, dlmmPoolApprovals);

const avaxRaw = await client.getBalance({ address: wallet });
const activeIdRead = await readContract(
  contractRegistry.dlmmWavaxUsdc5Pool.address,
  contractAbis.dlmmPool,
  "getActiveId"
);
const activeId = activeIdRead.ok ? BigInt(activeIdRead.value.toString()) : null;
const wavaxUsdcIds = [...new Set([...centeredIds(activeId, dlmmActiveIdRadius), ...dlmmExtraWavaxUsdcIds])].sort((a, b) => {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const walletPositionsInput = {
  account: wallet,
  includeAllowances: true,
  includeProtocol: true,
  includeRewards: true,
  maxClTokenIds,
  dlmmPools: [
    {
      pair: contractRegistry.dlmmWavaxUsdc5Pool.address,
      ids: wavaxUsdcIds,
      scanRewardedRange: false
    },
    {
      pair: dlmmRewardedPool,
      ids: [],
      scanRewardedRange: true,
      maxIds: dlmmMaxIds
    }
  ]
};
const walletPositions = await walletPositionsRead(client, walletPositionsInput);
const positionSummary = walletPositionSummary(walletPositions);

console.log(stringify({
  timestamp: new Date().toISOString(),
  chainId: 43114,
  wallet,
  rpcUrl,
  balances: {
    AVAX: { raw: avaxRaw.toString(), formatted: formatEther(avaxRaw) },
    ...balances
  },
  allowances,
  dlmmPoolApprovals,
  approvalsCleared: approvalCleanup.approvalsCleared,
  approvalCleanupSummary: approvalCleanup,
  walletPositionsScan: {
    maxClTokenIds,
    dlmmActiveIdRadius,
    dlmmExtraWavaxUsdcIds,
    dlmmWavaxUsdc5ActiveId: activeId?.toString() ?? null,
    dlmmPools: walletPositionsInput.dlmmPools
  },
  walletPositionSummary: positionSummary,
  walletPositions
}));
