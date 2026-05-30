#!/usr/bin/env node
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";
import { rewardClaimabilityRead } from "../dist/queryTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const periodsBack = Number(process.env.OPERATOR_INCENTIVE_PERIODS_BACK ?? 16);

export async function safeRead(client, address, abi, functionName, args = []) {
  try {
    return { ok: true, result: await client.readContract({ address, abi, functionName, args }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  return 0n;
}

export function positiveEarnedRows(feeDistributors = []) {
  const rows = [];
  for (const feeDistributor of feeDistributors) {
    for (const earned of feeDistributor.earned ?? []) {
      const amount = toBigInt(earned.amount?.result);
      if (amount > 0n) {
        rows.push({
          feeDistributor: feeDistributor.address,
          period: feeDistributor.period,
          token: earned.token,
          amount
        });
      }
    }
  }
  return rows;
}

export async function collectOperatorIncentiveWatch({
  client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) }),
  rpcUrl: inputRpcUrl = rpcUrl,
  wallet: inputWallet = wallet,
  periodsBack: inputPeriodsBack = periodsBack
} = {}) {
  const [p33Operator, autoVaultOperator, voterPeriod] = await Promise.all([
    safeRead(client, contractRegistry.p33.address, contractAbis.p33, "operator"),
    safeRead(client, contractRegistry.autoVault.address, contractAbis.autoVault, "OPERATOR"),
    safeRead(client, contractRegistry.voter.address, contractAbis.voter, "getPeriod")
  ]);

  const p33Caller = p33Operator.ok ? p33Operator.result : undefined;
  const autoVaultCaller = autoVaultOperator.ok ? autoVaultOperator.result : undefined;

  const [p33Plan, autoVaultPlan] = await Promise.all([
    rewardClaimabilityRead(client, {
      account: inputWallet,
      caller: p33Caller,
      domains: ["p33"],
      p33VotePeriodsBack: inputPeriodsBack,
      includeZero: true
    }),
    rewardClaimabilityRead(client, {
      account: inputWallet,
      caller: autoVaultCaller,
      domains: ["autoVault"],
      autoVaultVotePeriodsBack: inputPeriodsBack,
      includeZero: true
    })
  ]);

  const p33 = p33Plan.domains.p33;
  const autoVault = autoVaultPlan.domains.autoVault?.incentives;
  const p33PositiveRows = positiveEarnedRows(p33?.feeDistributors);
  const autoVaultPositiveRows = positiveEarnedRows(autoVault?.feeDistributors);

  return {
    timestamp: new Date().toISOString(),
    chainId: 43114,
    rpcUrl: inputRpcUrl,
    wallet: inputWallet,
    currentPeriod: voterPeriod.ok ? voterPeriod.result : voterPeriod,
    periodsBack: inputPeriodsBack,
    summary: {
      p33: {
        operator: p33?.operator ?? p33Operator,
        caller: p33Plan.caller ?? null,
        callerIsOperator: p33?.callerIsOperator ?? null,
        votedPools: p33?.votedPools?.length ?? 0,
        feeDistributors: p33?.feeDistributors?.length ?? 0,
        positiveEarnedRows: p33PositiveRows.length,
        operatorClaimable: Boolean(p33?.operatorClaimable),
        claimable: Boolean(p33?.claimable),
        status: p33PositiveRows.length > 0 ? "positive_current_earned_found" : "blocked_no_current_positive_earned"
      },
      autoVault: {
        operator: autoVault?.operator ?? autoVaultOperator,
        caller: autoVaultPlan.caller ?? null,
        callerIsOperator: autoVault?.callerIsOperator ?? null,
        votedPools: autoVault?.votedPools?.length ?? 0,
        feeDistributors: autoVault?.feeDistributors?.length ?? 0,
        positiveEarnedRows: autoVaultPositiveRows.length,
        operatorClaimable: Boolean(autoVault?.operatorClaimable),
        claimable: Boolean(autoVault?.claimable),
        status: autoVaultPositiveRows.length > 0 ? "positive_current_earned_found" : "blocked_no_current_positive_earned"
      }
    },
    positiveRows: {
      p33: p33PositiveRows,
      autoVault: autoVaultPositiveRows
    },
    plans: {
      p33: p33Plan,
      autoVault: autoVaultPlan
    },
    warning: "Readonly operator-incentive watch only. Positive rows should be fork-simulated before any live operator claim. Normal MCP tools remain unsigned calldata builders."
  };
}

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(stringify(await collectOperatorIncentiveWatch()));
}
