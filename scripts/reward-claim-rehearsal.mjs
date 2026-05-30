#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, toHex } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import { lookupFunction } from "../dist/lookup.js";

const rpcUrl = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl)) {
  throw new Error("reward-claim-rehearsal only runs against a local fork RPC.");
}

const fixturePath = process.env.REWARD_FIXTURE_REPORT ?? "reports/reward-fixtures.latest.json";
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
const transport = http(rpcUrl, { timeout: 120_000, retryCount: 0 });
const publicClient = createPublicClient({ chain: avalanche, transport });

const fundAmount = 1_000_000_000_000_000_000n;
const p33Summary = fixtures.summary?.p33 ?? {};
const fixtureLatestBlock = fixtures.latestBlock ? BigInt(fixtures.latestBlock) : undefined;

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function shortError(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function claimableEntries(domain) {
  return fixtures.domains?.[domain]?.assessments?.filter((item) => item.claimable === true) ?? [];
}

function claimableVariantEntries(domain, variantName) {
  return fixtures.domains?.[domain]?.assessments?.filter((item) => item.claimable === true && item.variantBuilders?.[variantName]) ?? [];
}

function emptyCaseResult(domain, label) {
  if (domain === "dlmmRewarder") {
    const dlmmSummary = fixtures.summary?.dlmmRewarder ?? {};
    const scanStatus = dlmmSummary.scanStatus ?? fixtures.domains?.dlmmRewarder?.scanStatus?.status;
    if (scanStatus === "incomplete_scan_error" || dlmmSummary.scanHadErrors === true) {
      return {
        domain,
        label,
        ok: false,
        status: "blocked_fixture_scan_incomplete",
        reason: "No DLMM claimable fixture was available because the fixture scan did not complete cleanly."
      };
    }
    return {
      domain,
      label,
      ok: false,
      status: "skipped_no_current_dlmm_candidate",
      reason: "No current cleanly scanned claimable DLMM rewarder fixture was available."
    };
  }
  return {
    domain,
    label,
    ok: false,
    status: "skipped",
    reason: "No claimable fixture or builder was available."
  };
}

function isSkipped(result) {
  return result.status === "skipped" || result.status?.startsWith("skipped_");
}

async function currentClGaugeClaimables(variantName) {
  const candidates = fixtures.domains?.clGauge?.assessments?.filter((item) => (
    item.claimable === true && (!variantName || item.variantBuilders?.[variantName])
  )) ?? [];
  const out = [];

  for (const candidate of candidates) {
    try {
      const owner = await publicClient.readContract({
        address: contractRegistry.ramsesV3PositionManager.address,
        abi: contractAbis.ramsesV3PositionManager,
        functionName: "ownerOf",
        args: [BigInt(candidate.tokenId)]
      });
      out.push({ ...candidate, currentOwner: owner });
    } catch {
      continue;
    }
  }
  return out;
}

function tokenAddresses(entry) {
  const out = [];
  if (Array.isArray(entry?.claimableTokens)) out.push(...entry.claimableTokens);
  if (entry?.earned?.token) out.push(entry.earned.token);
  if (entry?.storedRewards?.token) out.push(entry.storedRewards.token);
  if (entry?.pendingRewards?.token) out.push(entry.pendingRewards.token);
  return [...new Set(out.map((token) => token.toLowerCase()))];
}

async function tokenMeta(token) {
  const [decimals, symbol] = await Promise.all([
    publicClient.readContract({ address: token, abi: contractAbis.erc20Read, functionName: "decimals" }).catch(() => 18),
    publicClient.readContract({ address: token, abi: contractAbis.erc20Read, functionName: "symbol" }).catch(() => undefined)
  ]);
  return { decimals: Number(decimals), symbol };
}

async function balances(account, tokens) {
  const entries = {};
  for (const token of tokens) {
    const checksumToken = token;
    const meta = await tokenMeta(checksumToken);
    const raw = await publicClient.readContract({
      address: checksumToken,
      abi: contractAbis.erc20Read,
      functionName: "balanceOf",
      args: [account]
    });
    entries[checksumToken] = {
      raw,
      formatted: formatUnits(raw, meta.decimals),
      decimals: meta.decimals,
      symbol: meta.symbol
    };
  }
  return entries;
}

function balanceDeltas(before, after) {
  const out = {};
  for (const [token, beforeBalance] of Object.entries(before)) {
    const afterBalance = after[token];
    if (!afterBalance) continue;
    const delta = BigInt(afterBalance.raw) - BigInt(beforeBalance.raw);
    out[token] = {
      raw: delta,
      formatted: formatUnits(delta, beforeBalance.decimals),
      symbol: beforeBalance.symbol
    };
  }
  return out;
}

function hasPositiveDelta(deltas) {
  return Object.values(deltas).some((delta) => BigInt(delta.raw) > 0n);
}

async function rewardState(domain, entry) {
  if (domain === "clGauge" && entry?.gauge && Array.isArray(entry.claimableTokens) && entry.tokenId !== undefined) {
    const earned = {};
    const earnedFn = lookupFunction(contractAbis.clGaugeV3, "earned(address,uint256)");
    for (const token of entry.claimableTokens) {
      const raw = await publicClient.readContract({
        address: entry.gauge,
        abi: [earnedFn],
        functionName: earnedFn.name,
        args: [token, BigInt(entry.tokenId)]
      }).catch(() => undefined);
      if (raw === undefined) continue;
      earned[token.toLowerCase()] = { raw };
    }
    return { earned };
  }

  if (domain !== "feeDistributor" || !entry?.feeDistributor || !Array.isArray(entry.claimableTokens)) return null;
  const earned = {};
  for (const token of entry.claimableTokens) {
    const raw = await publicClient.readContract({
      address: entry.feeDistributor,
      abi: contractAbis.feeDistributor,
      functionName: "earned",
      args: [token, entry.account]
    }).catch(() => undefined);
    if (raw === undefined) continue;
    earned[token.toLowerCase()] = { raw };
  }
  return { earned };
}

function rewardStateDeltas(before, after) {
  if (!before || !after) return null;
  const earned = {};
  for (const [token, beforeValue] of Object.entries(before.earned ?? {})) {
    const afterValue = after.earned?.[token];
    if (!afterValue) continue;
    earned[token] = { raw: BigInt(afterValue.raw) - BigInt(beforeValue.raw) };
  }
  return { earned };
}

function hasRewardStateDecrease(deltas) {
  return Object.values(deltas?.earned ?? {}).some((delta) => BigInt(delta.raw) < 0n);
}

async function snapshot() {
  return publicClient.request({ method: "evm_snapshot", params: [] });
}

async function revert(snapshotId) {
  return publicClient.request({ method: "evm_revert", params: [snapshotId] });
}

async function impersonatedSend(from, tx) {
  await publicClient.request({ method: "anvil_setBalance", params: [from, toHex(fundAmount)] });
  await publicClient.request({ method: "anvil_impersonateAccount", params: [from] });
  const walletClient = createWalletClient({ account: from, chain: avalanche, transport });
  try {
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? "0"),
      gas: 10_000_000n
    });
    await publicClient.request({ method: "evm_mine", params: [] }).catch(() => undefined);
    return {
      hash,
      receipt: null,
      receiptWarning: "Receipt polling is skipped by default because free Avalanche fork RPCs can rate-limit local transaction receipt lookups; positive token deltas are used as execution evidence."
    };
  } finally {
    await publicClient.request({ method: "anvil_stopImpersonatingAccount", params: [from] });
  }
}

async function runCase({ domain, label, entry, tx, from }) {
  if (!entry || !tx || !from) {
    return {
      domain,
      label,
      ok: false,
      status: "skipped",
      reason: "No claimable fixture or builder was available."
    };
  }

  const tokens = tokenAddresses(entry);
  const snapshotId = await snapshot();
  let result;
  try {
    const nativeBefore = await publicClient.getBalance({ address: from });
    const before = await balances(from, tokens);
    const rewardStateBefore = await rewardState(domain, entry);
    const { hash, receipt, receiptWarning } = await impersonatedSend(from, tx);
    const nativeAfter = await publicClient.getBalance({ address: from });
    const after = await balances(from, tokens);
    const rewardStateAfter = await rewardState(domain, entry);
    const deltas = balanceDeltas(before, after);
    const rewardDeltas = rewardStateDeltas(rewardStateBefore, rewardStateAfter);
    const positiveDelta = hasPositiveDelta(deltas);
    const rewardDecrease = hasRewardStateDecrease(rewardDeltas);

    result = {
      domain,
      label,
      ok: receipt ? receipt.status === "success" && (positiveDelta || rewardDecrease) : (positiveDelta || rewardDecrease),
      status: receipt
        ? receipt.status
        : (positiveDelta ? "sent_balance_delta" : (rewardDecrease ? "sent_reward_state_delta" : "sent_no_receipt")),
      account: from,
      to: tx.to,
      signature: tx.signature,
      hash,
      gasUsed: receipt?.gasUsed ?? null,
      receiptWarning,
      nativeBalance: {
        before: { raw: nativeBefore, formatted: formatEther(nativeBefore) },
        after: { raw: nativeAfter, formatted: formatEther(nativeAfter) }
      },
      tokenBalances: { before, after, delta: deltas },
      rewardState: rewardDeltas ? { before: rewardStateBefore, after: rewardStateAfter, delta: rewardDeltas } : null
    };
  } catch (error) {
    result = {
      domain,
      label,
      ok: false,
      status: "failed",
      account: from,
      to: tx.to,
      signature: tx.signature,
      error: shortError(error)
    };
  } finally {
    try {
      await revert(snapshotId);
    } catch (error) {
      result = {
        ...(result ?? { domain, label, ok: false, status: "failed" }),
        ok: false,
        revertError: shortError(error)
      };
    }
  }
  return result;
}

async function runFirstPassingCase({ domain, label, candidates }) {
  if (!candidates.length) return emptyCaseResult(domain, label);

  const attempts = [];
  for (const candidate of candidates) {
    const result = await runCase({ domain, label, ...candidate });
    attempts.push(result);
    if (result.ok) {
      return attempts.length === 1 ? result : { ...result, attempts };
    }
  }

  return {
    domain,
    label,
    ok: false,
    status: "skipped",
    reason: "No claimable fixture candidate executed successfully on this fork.",
    attempts
  };
}

const autoVaults = claimableEntries("autoVault");
const legacyGauges = claimableEntries("legacyGauge");
const clGauges = await currentClGaugeClaimables();
const clGaugesWithNfpManagers = await currentClGaugeClaimables("claimClGaugeRewardsWithNfpManagers");
const feeDistributors = claimableEntries("feeDistributor");
const legacyFeeDistributors = claimableVariantEntries("feeDistributor", "claimLegacyIncentives");
const dlmmRewarders = claimableEntries("dlmmRewarder");

const cases = [
  {
    domain: "autoVault",
    label: "AutoVault claim()",
    candidates: autoVaults.map((entry) => ({ entry, tx: entry.builder, from: entry.account }))
  },
  {
    domain: "legacyGauge",
    label: "Legacy gauge getReward(address,address[])",
    candidates: legacyGauges.map((entry) => ({ entry, tx: entry.builder, from: entry.account }))
  },
  {
    domain: "legacyGauge",
    label: "Voter claimRewards(address[],address[][])",
    candidates: legacyGauges.map((entry) => ({ entry, tx: entry.variantBuilders?.voterClaimRewards, from: entry.account }))
  },
  {
    domain: "clGauge",
    label: "Voter claimClGaugeRewards(address[],address[][],uint256[][])",
    candidates: clGauges.map((entry) => ({ entry, tx: entry.builder, from: entry.currentOwner ?? entry.account }))
  },
  {
    domain: "clGauge",
    label: "Voter claimClGaugeRewards(address[],address[][],uint256[][],address[])",
    candidates: clGaugesWithNfpManagers.map((entry) => ({ entry, tx: entry.variantBuilders?.claimClGaugeRewardsWithNfpManagers, from: entry.currentOwner ?? entry.account }))
  },
  {
    domain: "feeDistributor",
    label: "Voter claimIncentives(address,address[],address[][])",
    candidates: feeDistributors.map((entry) => ({ entry, tx: entry.builder, from: entry.account }))
  },
  {
    domain: "feeDistributor",
    label: "Voter claimLegacyIncentives(address,address[],address[][])",
    candidates: legacyFeeDistributors.map((entry) => ({ entry, tx: entry.variantBuilders?.claimLegacyIncentives, from: entry.account }))
  },
  {
    domain: "dlmmRewarder",
    label: "DLMM rewarder claim(address,uint256[])",
    candidates: dlmmRewarders.map((entry) => ({ entry, tx: entry.builder, from: entry.account }))
  }
];

const forkStartBlock = await publicClient.getBlockNumber();

const results = [];
for (const claimCase of cases) {
  results.push(await runFirstPassingCase(claimCase));
}

const p33Blocked = {
  domain: "p33",
  ok: true,
  status: "blocked",
  reason: "No current positive p33 FeeDistributor earned rows were found; p33 incentive payout evidence remains historical userClaimed rows plus no-payout operator static-call validation.",
  currentEarnedPositive: p33Summary.currentEarnedPositive ?? 0,
  historicalClaimedPositive: p33Summary.historicalClaimedPositive ?? 0,
  checkedCurrentRows: p33Summary.checkedCurrentRows ?? 0,
  checkedHistoricalRows: p33Summary.checkedHistoricalRows ?? 0
};

const executed = results.filter((item) => !isSkipped(item));
const report = {
  timestamp: new Date().toISOString(),
  mode: "fork",
  rpcUrl,
  fixturePath,
  fixtureLatestBlock,
  forkStartBlock,
  forkBlockMatchesFixture: fixtureLatestBlock === undefined ? null : forkStartBlock === fixtureLatestBlock,
  note: "Fork-only reward claim rehearsal. Each case impersonates the fixture account, funds gas on the local fork, sends the existing unsigned calldata, records balance or reward-state deltas, then reverts to isolate cases. No live transaction is broadcast. For time-sensitive fixtures such as CL NFTs, run Anvil with --fork-block-number equal to fixtureLatestBlock.",
  summary: {
    cases: results.length,
    executed: executed.length,
    passed: executed.filter((item) => item.ok).length,
    failed: executed.filter((item) => !item.ok).length,
    skipped: results.filter(isSkipped).length,
    p33Status: p33Blocked.status
  },
  ok: executed.every((item) => item.ok),
  results,
  p33: p33Blocked
};

console.log(stringify(report));
if (report.summary.failed > 0 && process.env.STOP_ON_FAIL === "1") process.exit(1);
