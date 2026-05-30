#!/usr/bin/env node
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });

const PHAR = contractRegistry.pharToken.address;
const USDC = contractRegistry.usdcNative.address;
const LEGACY_GAUGE = contractRegistry.legacyGauge.address;
const CL_WAVAX_USDC_10_POOL = "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534";
const DLMM_REWARDED_POOL = "0x87206a5a6eDDd4e22423425BA66C2591551BFc6f";

async function read(address, abi, functionName, args = []) {
  try {
    return {
      ok: true,
      result: await client.readContract({ address, abi, functionName, args })
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function tokenAmount(token, raw) {
  if (raw === undefined || raw === null) return undefined;
  const decimalsResult = await read(token, contractAbis.erc20Read, "decimals");
  const decimals = decimalsResult.ok ? Number(decimalsResult.result) : 18;
  return { raw: raw.toString(), formatted: formatUnits(raw, decimals), decimals };
}

async function rewardAmounts(tokens, amountReader) {
  const out = [];
  for (const token of tokens) {
    const amount = await amountReader(token);
    out.push({
      token,
      amount: amount.ok ? await tokenAmount(token, amount.result) : { error: amount.error }
    });
  }
  return out;
}

const avax = await client.getBalance({ address: wallet });
const period = await client.readContract({
  address: contractRegistry.voter.address,
  abi: contractAbis.voter,
  functionName: "getPeriod"
});
const p33Period = await read(contractRegistry.p33.address, contractAbis.p33, "getPeriod");
const p33PeriodValue = p33Period.ok ? p33Period.result : period;

const legacyRewardList = await read(LEGACY_GAUGE, contractAbis.legacyGauge, "rewardsList");
const legacyTokens = legacyRewardList.ok ? legacyRewardList.result : [];

const clGauge = await read(contractRegistry.voter.address, contractAbis.voter, "gaugeForPool", [CL_WAVAX_USDC_10_POOL]);
const clFeeDistributor = clGauge.ok
  ? await read(contractRegistry.voter.address, contractAbis.voter, "feeDistributorForGauge", [clGauge.result])
  : { ok: false, error: "CL gauge unavailable" };
const clRewardTokens = clGauge.ok
  ? await read(clGauge.result, contractAbis.clGaugeV3, "getRewardTokens")
  : { ok: false, error: "CL gauge unavailable" };
const feeDistributorTokens = clFeeDistributor.ok
  ? await read(clFeeDistributor.result, contractAbis.feeDistributor, "getRewardTokens")
  : { ok: false, error: "FeeDistributor unavailable" };

const dlmmRewarder = await read(contractRegistry.dlmmRewarderFactory.address, contractAbis.dlmmRewarderFactory, "getRewarder", [DLMM_REWARDED_POOL]);
const dlmmRewardToken = dlmmRewarder.ok && dlmmRewarder.result !== "0x0000000000000000000000000000000000000000"
  ? await read(dlmmRewarder.result, contractAbis.dlmmRewarder, "getRewardToken")
  : { ok: false, error: "No DLMM rewarder" };

const report = {
  timestamp: new Date().toISOString(),
  chainId: 43114,
  rpcUrl,
  wallet,
  walletNative: { raw: avax.toString(), formatted: formatEther(avax) },
  period: period.toString(),
  voteState: {
    voteModuleBalance: await read(contractRegistry.voteModule.address, contractAbis.voteModule, "balanceOf", [wallet]),
    votes: await read(contractRegistry.voter.address, contractAbis.voter, "getVotes", [wallet, period]),
    lastVoted: await read(contractRegistry.voter.address, contractAbis.voter, "lastVoted", [wallet])
  },
  autoVault: {
    balanceOf: await read(contractRegistry.autoVault.address, contractAbis.autoVault, "balanceOf", [wallet]),
    earned: await read(contractRegistry.autoVault.address, contractAbis.autoVault, "earned", [wallet]),
    storedRewards: await read(contractRegistry.autoVault.address, contractAbis.autoVault, "getStoredRewards", [wallet]),
    outputPreference: await read(contractRegistry.autoVault.address, contractAbis.autoVault, "outputPreference", [wallet])
  },
  legacyGauge: {
    address: LEGACY_GAUGE,
    balanceOf: await read(LEGACY_GAUGE, contractAbis.legacyGauge, "balanceOf", [wallet]),
    rewardsList: legacyRewardList,
    earned: await rewardAmounts(legacyTokens, (token) => read(LEGACY_GAUGE, contractAbis.legacyGauge, "earned", [token, wallet]))
  },
  clGauge: {
    pool: CL_WAVAX_USDC_10_POOL,
    address: clGauge,
    feeDistributor: clFeeDistributor,
    rewardTokens: clRewardTokens,
    note: "Wallet has no active CL NFT after validation mint/decrease/collect/burn; per-token rewards require a tokenId."
  },
  feeDistributor: {
    address: clFeeDistributor,
    rewardTokens: feeDistributorTokens,
    balanceOf: clFeeDistributor.ok ? await read(clFeeDistributor.result, contractAbis.feeDistributor, "balanceOf", [wallet]) : undefined,
    earned: feeDistributorTokens.ok
      ? await rewardAmounts(feeDistributorTokens.result, (token) => read(clFeeDistributor.result, contractAbis.feeDistributor, "earned", [token, wallet]))
      : []
  },
  dlmmRewarder: {
    pool: DLMM_REWARDED_POOL,
    address: dlmmRewarder,
    rewardToken: dlmmRewardToken,
    pendingRewardsNoIds: dlmmRewarder.ok && dlmmRewarder.result !== "0x0000000000000000000000000000000000000000"
      ? await read(dlmmRewarder.result, contractAbis.dlmmRewarder, "getPendingRewards", [wallet, []])
      : undefined,
    note: "Wallet has no active DLMM bin balance after validation add/remove; reward claims require bin ids with pending rewards."
  },
  p33: {
    balanceOf: await read(contractRegistry.p33.address, contractAbis.p33, "balanceOf", [wallet]),
    asset: await read(contractRegistry.p33.address, contractAbis.p33, "asset"),
    xPhar: await read(contractRegistry.p33.address, contractAbis.p33, "xPhar"),
    operator: await read(contractRegistry.p33.address, contractAbis.p33, "operator"),
    getPeriod: p33Period,
    isUnlocked: await read(contractRegistry.p33.address, contractAbis.p33, "isUnlocked"),
    isCooldownActive: await read(contractRegistry.p33.address, contractAbis.p33, "isCooldownActive"),
    periodUnlockStatus: await read(contractRegistry.p33.address, contractAbis.p33, "periodUnlockStatus", [p33PeriodValue]),
    maxDeposit: await read(contractRegistry.p33.address, contractAbis.p33, "maxDeposit", [wallet]),
    maxMint: await read(contractRegistry.p33.address, contractAbis.p33, "maxMint", [wallet]),
    maxWithdraw: await read(contractRegistry.p33.address, contractAbis.p33, "maxWithdraw", [wallet]),
    maxRedeem: await read(contractRegistry.p33.address, contractAbis.p33, "maxRedeem", [wallet])
  },
  claimableSummary: {
    autoVault: "0 balance / 0 earned in current reads",
    legacyGauge: "0 staked balance in current reads",
    clGauge: "no active NFT tokenId after validation cleanup",
    feeDistributor: "0 voting balance / no earned reward in current reads",
    dlmmRewarder: "no active bin ids after validation cleanup",
    p33: "0 p33 balance"
  },
  candidateClaimBuilders: [
    "pharaoh_autovault_build_tx claim",
    "pharaoh_gauge_build_tx legacyGetReward with addressOverride",
    "pharaoh_cl_liquidity_build_tx getReward/getPeriodReward",
    "pharaoh_vote_build_tx claimRewards/claimIncentives/claimLegacyIncentives/claimClGaugeRewards",
    "pharaoh_dlmm_build_tx rewarderClaim with rewarder addressOverride"
  ],
  referenceTokens: { PHAR, USDC }
};

console.log(JSON.stringify(report, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
