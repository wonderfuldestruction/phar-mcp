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

const walletAddress = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";
const liveBroadcast = process.env.LIVE_BROADCAST === "1";
const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const exitAmount = parseUnits(process.env.XPHAR_EXIT_AMOUNT ?? "0.01", 18);

const publicClient = createPublicClient({ chain: avalanche, transport: http(rpcUrl) });
const xphar = contractRegistry.xPharToken.address;
const phar = contractRegistry.pharToken.address;

let walletClient;
if (liveBroadcast) {
  const expectedWallet = walletAddress.toLowerCase();
  if (process.env.PHAR_MCP_LIVE_CONFIRM?.toLowerCase() !== expectedWallet) {
    throw new Error("Live broadcast requires PHAR_MCP_LIVE_CONFIRM to equal the expendable wallet address.");
  }
  const keyFile = process.env.PHAR_MCP_KEY_FILE ?? ".secrets/phar-mcp-expendable-wallet.txt";
  const keyMatch = readFileSync(keyFile, "utf8").match(/Private key:\s*(0x[0-9a-fA-F]{64})/);
  if (!keyMatch) throw new Error(`Could not read private key from ${keyFile}`);
  const account = privateKeyToAccount(keyMatch[1]);
  if (account.address.toLowerCase() !== expectedWallet) {
    throw new Error(`Loaded key address ${account.address} does not match expected wallet.`);
  }
  walletClient = createWalletClient({ account, chain: avalanche, transport: http(rpcUrl) });
}

function stringify(value) {
  return JSON.stringify(value, (_key, inner) => typeof inner === "bigint" ? inner.toString() : inner, 2);
}

async function tokenBalance(token, decimals) {
  const raw = await publicClient.readContract({
    address: token,
    abi: contractAbis.erc20Read,
    functionName: "balanceOf",
    args: [walletAddress]
  });
  return { raw, formatted: formatUnits(raw, decimals) };
}

async function snapshot(label) {
  const avax = await publicClient.getBalance({ address: walletAddress });
  return {
    label,
    AVAX: {
      raw: avax,
      formatted: formatEther(avax)
    },
    PHAR: await tokenBalance(phar, 18),
    xPHAR: await tokenBalance(xphar, 18)
  };
}

const [basis, slashingPenalty, paused, isExempt, isExemptTo, balanceBefore, simulated] = await Promise.all([
  publicClient.readContract({ address: xphar, abi: contractAbis.xPharToken, functionName: "BASIS" }),
  publicClient.readContract({ address: xphar, abi: contractAbis.xPharToken, functionName: "SLASHING_PENALTY" }),
  publicClient.readContract({ address: xphar, abi: contractAbis.xPharToken, functionName: "paused" }),
  publicClient.readContract({ address: xphar, abi: contractAbis.xPharToken, functionName: "isExempt", args: [walletAddress] }),
  publicClient.readContract({ address: xphar, abi: contractAbis.xPharToken, functionName: "isExemptTo", args: [walletAddress] }),
  publicClient.readContract({ address: xphar, abi: contractAbis.erc20Read, functionName: "balanceOf", args: [walletAddress] }),
  publicClient.simulateContract({
    account: walletAddress,
    address: xphar,
    abi: contractAbis.xPharToken,
    functionName: "exit",
    args: [exitAmount]
  })
]);

const expectedPenalty = exitAmount * slashingPenalty / basis;
const report = {
  timestamp: new Date().toISOString(),
  mode: liveBroadcast ? "live" : "simulation",
  rpcUrl,
  wallet: walletAddress,
  liveConfirmationAddress: liveBroadcast ? process.env.PHAR_MCP_LIVE_CONFIRM : null,
  xphar,
  phar,
  amountIn: { raw: exitAmount, formatted: formatUnits(exitAmount, 18) },
  constants: {
    basis,
    slashingPenalty,
    paused,
    isExempt,
    isExemptTo
  },
  expected: {
    pharOut: simulated.result,
    pharOutFormatted: formatUnits(simulated.result, 18),
    penalty: expectedPenalty,
    penaltyFormatted: formatUnits(expectedPenalty, 18)
  },
  before: await snapshot("before"),
  steps: [],
  ok: false
};

try {
  if (paused) throw new Error("xPHAR is paused.");
  if (balanceBefore < exitAmount) {
    throw new Error(`Insufficient xPHAR for exit: balance=${balanceBefore} amount=${exitAmount}`);
  }

  report.steps.push({
    ok: true,
    label: "simulate xPHAR exit",
    result: simulated.result,
    note: "exit(uint256) spends xPHAR from the caller directly; no ERC20 approval is required."
  });

  if (liveBroadcast) {
    const hash = await walletClient.writeContract({
      address: xphar,
      abi: contractAbis.xPharToken,
      functionName: "exit",
      args: [exitAmount]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
    report.steps.push({ ok: true, label: "xPHAR exit", hash, gasUsed: receipt.gasUsed });
  }

  report.after = await snapshot(liveBroadcast ? "after" : "after-simulation");
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.after = await snapshot("after-error");
}

console.log(stringify(report));
if (!report.ok && process.env.STOP_ON_FAIL === "1") process.exit(1);
