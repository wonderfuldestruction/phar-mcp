#!/usr/bin/env node
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { p33Read, rewardClaimabilityRead } from "../dist/queryTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const operatorPeriodsBack = Number(process.env.OPERATOR_INCENTIVE_PERIODS_BACK ?? 16);

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  return 0n;
}

function positiveEarnedRows(feeDistributors = []) {
  const rows = [];
  for (const feeDistributor of feeDistributors ?? []) {
    for (const earned of feeDistributor?.earned ?? []) {
      const amount = toBigInt(earned?.amount?.result);
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

function readResultAddress(read) {
  return read?.ok === true && typeof read.result === "string" ? read.result : undefined;
}

function operatorSummary({ p33Plan, autoVaultPlan }) {
  const p33 = p33Plan?.domains?.p33;
  const autoVault = autoVaultPlan?.domains?.autoVault?.incentives;
  const p33PositiveRows = positiveEarnedRows(p33?.feeDistributors);
  const autoVaultPositiveRows = positiveEarnedRows(autoVault?.feeDistributors);

  return {
    currentPeriod: p33Plan?.currentPeriod ?? autoVaultPlan?.currentPeriod ?? null,
    summary: {
      p33: {
        operator: p33?.operator ?? null,
        caller: p33Plan?.caller ?? null,
        callerIsOperator: p33?.callerIsOperator ?? null,
        votedPools: p33?.votedPools?.length ?? 0,
        feeDistributors: p33?.feeDistributors?.length ?? 0,
        positiveEarnedRows: p33PositiveRows.length,
        operatorClaimable: Boolean(p33?.operatorClaimable),
        claimable: Boolean(p33?.claimable),
        status: p33PositiveRows.length > 0 ? "positive_current_earned_found" : "blocked_no_current_positive_earned"
      },
      autoVault: {
        operator: autoVault?.operator ?? null,
        caller: autoVaultPlan?.caller ?? null,
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
    positiveRowsFlat: [
      ...p33PositiveRows.map((row) => ({ domain: "p33", ...row })),
      ...autoVaultPositiveRows.map((row) => ({ domain: "autoVault", ...row }))
    ]
  };
}

export async function collectClaimabilityState({
  client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) }),
  rpcUrl: inputRpcUrl = rpcUrl,
  wallet: inputWallet = wallet,
  p33QuoteAssets = process.env.P33_QUOTE_ASSETS ?? "30000000000000000",
  periodsBack: inputPeriodsBack = operatorPeriodsBack
} = {}) {
  const rewardClaimability = await rewardClaimabilityRead(client, {
    account: inputWallet,
    domains: ["autoVault", "legacyGauge", "clGauge", "feeDistributor", "dlmmRewarder", "p33"],
    includeZero: true
  });
  const p33Operator = readResultAddress(rewardClaimability.domains?.p33?.operator);
  const autoVaultOperator = readResultAddress(rewardClaimability.domains?.autoVault?.incentives?.operator);
  const [p33OperatorPlan, autoVaultOperatorPlan] = await Promise.all([
    rewardClaimabilityRead(client, {
      account: inputWallet,
      caller: p33Operator,
      domains: ["p33"],
      p33VotePeriodsBack: inputPeriodsBack,
      includeZero: true
    }),
    rewardClaimabilityRead(client, {
      account: inputWallet,
      caller: autoVaultOperator,
      domains: ["autoVault"],
      autoVaultVotePeriodsBack: inputPeriodsBack,
      includeZero: true
    })
  ]);
  const operator = operatorSummary({ p33Plan: p33OperatorPlan, autoVaultPlan: autoVaultOperatorPlan });
  const operatorReady = operator.positiveRowsFlat.length > 0;
  const operatorBlockers = operatorReady ? [] : [
    "No current positive p33 or AutoVault operator incentive earned rows were found."
  ];

  return {
    timestamp: new Date().toISOString(),
    chainId: 43114,
    rpcUrl: inputRpcUrl,
    safety: {
      readOnly: true,
      privateKeyRead: false,
      liveBroadcastAllowed: false
    },
    inputs: {
      wallet: inputWallet,
      p33QuoteAssets,
      operatorIncentivePeriodsBack: inputPeriodsBack
    },
    wallet: inputWallet,
    periodsBack: inputPeriodsBack,
    p33: {
      summary: await p33Read(client, { action: "summary", account: inputWallet }),
      depositQuote: await p33Read(client, {
        action: "depositQuote",
        account: inputWallet,
        assets: p33QuoteAssets,
        simulate: true
      })
    },
    rewardClaimability,
    operatorIncentiveClaimability: {
      periodsBack: inputPeriodsBack,
      ready: operatorReady,
      status: operatorReady ? "positive_current_earned_found" : "blocked_no_current_positive_earned",
      blockers: operatorBlockers,
      ...operator,
      plans: {
        p33: p33OperatorPlan,
        autoVault: autoVaultOperatorPlan
      },
      warning: "Readonly caller-aware operator claimability evidence. It uses the configured p33 operator and AutoVault OPERATOR as static callers, emits unsigned builder hints only for positive earned rows, and does not broadcast."
    }
  };
}

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(stringify(await collectClaimabilityState()));
}
