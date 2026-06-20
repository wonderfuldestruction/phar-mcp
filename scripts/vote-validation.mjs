#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalanche } from "viem/chains";
import { contractAbis } from "../dist/abis.js";
import { contractRegistry } from "../dist/contracts.js";

const liveBroadcast = process.env.LIVE_BROADCAST === "1";
const rpcUrl = process.env.FORK_RPC_URL
  ?? (liveBroadcast ? "https://api.avax.network/ext/bc/C/rpc" : "http://127.0.0.1:8545");
if (!liveBroadcast && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl)) {
  throw new Error("vote-validation refuses non-local RPC URLs unless LIVE_BROADCAST=1.");
}

const keyFile = process.env.PHAR_MCP_KEY_FILE ?? ".secrets/phar-mcp-expendable-wallet.txt";
const keyMatch = readFileSync(keyFile, "utf8").match(/Private key:\s*(0x[0-9a-fA-F]{64})/);
if (!keyMatch) throw new Error(`Could not read private key from ${keyFile}`);

const account = privateKeyToAccount(keyMatch[1]);
const expectedWallet = (process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000").toLowerCase();
if (account.address.toLowerCase() !== expectedWallet) {
  throw new Error(`Loaded key address ${account.address} does not match expected wallet.`);
}
if (liveBroadcast && process.env.PHAR_MCP_LIVE_CONFIRM?.toLowerCase() !== expectedWallet) {
  throw new Error("Live broadcast requires PHAR_MCP_LIVE_CONFIRM to equal the expendable wallet address.");
}

const publicClient = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: avalanche, transport: http(rpcUrl) });

const XPHAR = contractRegistry.xPharToken.address;
const VOTE_MODULE = contractRegistry.voteModule.address;
const VOTER = contractRegistry.voter.address;
const CL_WAVAX_USDC_10_POOL = "0xf01449C0bA930B6e2CaCA3DEF3CCBd7a3E589534";
const voteAmount = parseUnits(process.env.VOTE_AMOUNT_XPHAR ?? "0.01", 18);

function stringify(value) {
  return JSON.stringify(value, (_key, inner) => typeof inner === "bigint" ? inner.toString() : inner, 2);
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

async function snapshot(label) {
  const avax = await publicClient.getBalance({ address: account.address });
  const block = await publicClient.getBlock();
  const period = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "getPeriod" });
  const nextPeriod = BigInt(period) + 1n;
  const currentVotes = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "getVotes", args: [account.address, period] });
  const nextVotes = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "getVotes", args: [account.address, nextPeriod] });
  return {
    label,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    AVAX: { raw: avax, formatted: formatEther(avax) },
    xPHAR: await readBalance(XPHAR, 18),
    voteModuleBalance: await publicClient.readContract({ address: VOTE_MODULE, abi: contractAbis.voteModule, functionName: "balanceOf", args: [account.address] }),
    delegate: await publicClient.readContract({ address: VOTE_MODULE, abi: contractAbis.voteModule, functionName: "delegates", args: [account.address] }),
    cooldown: await publicClient.readContract({ address: VOTE_MODULE, abi: contractAbis.voteModule, functionName: "cooldown" }),
    unlockTime: await publicClient.readContract({ address: VOTE_MODULE, abi: contractAbis.voteModule, functionName: "unlockTime" }),
    period,
    nextPeriod,
    lastVoted: await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "lastVoted", args: [account.address] }),
    currentVotes,
    nextVotes,
    xPharAllowanceToVoteModule: await publicClient.readContract({ address: XPHAR, abi: contractAbis.erc20Read, functionName: "allowance", args: [account.address, VOTE_MODULE] })
  };
}

async function wait(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

async function write(label, address, abi, functionName, args) {
  const hash = await walletClient.writeContract({ address, abi, functionName, args });
  const receipt = await wait(hash);
  return { ok: true, label, hash, gasUsed: receipt.gasUsed };
}

async function step(steps, label, fn) {
  try {
    const result = await fn();
    steps.push(result);
    return result;
  } catch (error) {
    steps.push({ ok: false, label, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function isSelfDelegate(delegate) {
  return String(delegate).toLowerCase() === account.address.toLowerCase();
}

function assertEmptyVotes(votes, label) {
  const pools = votes[0] ?? votes.votes ?? [];
  const weights = votes[1] ?? votes.weights ?? [];
  if (pools.length !== 0 || weights.length !== 0) {
    throw new Error(`${label} expected empty votes, got ${JSON.stringify(votes)}`);
  }
}

function assertOneVote(votes, pool, label) {
  const pools = votes[0] ?? votes.votes ?? [];
  const weights = votes[1] ?? votes.weights ?? [];
  if (pools.length !== 1 || pools[0].toLowerCase() !== pool.toLowerCase() || BigInt(weights[0]) === 0n) {
    throw new Error(`${label} expected one vote for ${pool}, got ${JSON.stringify(votes)}`);
  }
}

const report = {
  timestamp: new Date().toISOString(),
  mode: liveBroadcast ? "live" : "fork",
  rpcUrl,
  wallet: account.address,
  liveConfirmationAddress: liveBroadcast ? process.env.PHAR_MCP_LIVE_CONFIRM : null,
  amount: voteAmount,
  pool: CL_WAVAX_USDC_10_POOL,
  before: await snapshot("before"),
  preflight: {},
  steps: [],
  ok: false
};

try {
  const beforePeriod = BigInt(report.before.period);
  const nextPeriodStart = (beforePeriod + 1n) * 604800n;
  if (BigInt(report.before.blockTimestamp) < BigInt(report.before.unlockTime)) {
    throw new Error("VoteModule global unlockTime is still in the future; live voting would lock xPHAR.");
  }
  if (nextPeriodStart - BigInt(report.before.blockTimestamp) < 3600n) {
    throw new Error("Too close to next epoch for a low-risk voting validation.");
  }
  if (BigInt(report.before.lastVoted) >= beforePeriod) {
    report.steps.push({
      ok: true,
      label: "voting skipped",
      result: `Wallet already has lastVoted=${report.before.lastVoted} for current period ${report.before.period}; repeat voting waits until the next period.`
    });
    assertEmptyVotes(report.before.nextVotes, "pre-existing next-period votes");
    report.after = await snapshot("after-skip");
    report.ok = true;
    console.log(stringify(report));
    process.exit(0);
  }

  const gauge = await publicClient.readContract({
    address: VOTER,
    abi: contractAbis.voter,
    functionName: "gaugeForPool",
    args: [CL_WAVAX_USDC_10_POOL]
  });
  report.preflight.gauge = gauge;
  report.preflight.isGauge = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "isGauge", args: [gauge] });
  report.preflight.isAlive = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "isAlive", args: [gauge] });
  report.preflight.feeDistributor = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "feeDistributorForGauge", args: [gauge] });

  if (gauge === "0x0000000000000000000000000000000000000000" || !report.preflight.isGauge || !report.preflight.isAlive) {
    throw new Error(`Pool ${CL_WAVAX_USDC_10_POOL} does not have a live gauge.`);
  }

  await step(report.steps, "approve xPHAR -> VoteModule", () => write(
    "approve xPHAR -> VoteModule",
    XPHAR,
    contractAbis.erc20Approval,
    "approve",
    [VOTE_MODULE, voteAmount]
  ));
  await step(report.steps, "VoteModule deposit", () => write(
    "VoteModule deposit",
    VOTE_MODULE,
    contractAbis.voteModule,
    "deposit",
    [voteAmount]
  ));
  if (!isSelfDelegate(report.before.delegate)) {
    await step(report.steps, "VoteModule delegate self", () => write(
      "VoteModule delegate self",
      VOTE_MODULE,
      contractAbis.voteModule,
      "delegate",
      [account.address]
    ));
  } else {
    report.steps.push({ ok: true, label: "VoteModule delegate self skipped", result: "Delegate already points to wallet." });
  }
  await step(report.steps, "Voter vote CL WAVAX/USDC", () => write(
    "Voter vote CL WAVAX/USDC",
    VOTER,
    contractAbis.voter,
    "vote",
    [account.address, [CL_WAVAX_USDC_10_POOL], [10_000n]]
  ));
  await step(report.steps, "assert next-period vote exists", async () => {
    const votes = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "getVotes", args: [account.address, report.before.nextPeriod] });
    assertOneVote(votes, CL_WAVAX_USDC_10_POOL, "next-period vote");
    return { ok: true, label: "assert next-period vote exists", result: votes };
  });
  await step(report.steps, "Voter reset", () => write(
    "Voter reset",
    VOTER,
    contractAbis.voter,
    "reset",
    [account.address]
  ));
  await step(report.steps, "assert next-period vote cleared", async () => {
    const votes = await publicClient.readContract({ address: VOTER, abi: contractAbis.voter, functionName: "getVotes", args: [account.address, report.before.nextPeriod] });
    assertEmptyVotes(votes, "next-period vote after reset");
    return { ok: true, label: "assert next-period vote cleared", result: votes };
  });
  await step(report.steps, "VoteModule withdraw", () => write(
    "VoteModule withdraw",
    VOTE_MODULE,
    contractAbis.voteModule,
    "withdraw",
    [voteAmount]
  ));
  await step(report.steps, "assert vote cleanup", async () => {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: VOTE_MODULE, abi: contractAbis.voteModule, functionName: "balanceOf", args: [account.address] }),
      publicClient.readContract({ address: XPHAR, abi: contractAbis.erc20Read, functionName: "allowance", args: [account.address, VOTE_MODULE] })
    ]);
    if (BigInt(balance) !== 0n || BigInt(allowance) !== 0n) {
      throw new Error(`Expected zero vote balance and allowance, got balance=${balance} allowance=${allowance}`);
    }
    return { ok: true, label: "assert vote cleanup", result: { balance, allowance } };
  });

  report.after = await snapshot("after");
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.after = await snapshot("after-error");
}

console.log(stringify(report));
if (!report.ok && process.env.STOP_ON_FAIL === "1") process.exit(1);
