#!/usr/bin/env node
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import { protocolGatesRead } from "../dist/queryTools.js";

const rpcUrl = process.env.AVALANCHE_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc";
const wallet = process.env.PHAR_MCP_WALLET ?? "0x0000000000000000000000000000000000000000";

export async function collectProtocolGates({
  client = createPublicClient({ chain: avalanche, transport: http(rpcUrl) }),
  rpcUrl: inputRpcUrl = rpcUrl,
  wallet: inputWallet = wallet,
  p33ProbeAssets = process.env.P33_PROBE_ASSETS ?? "30000000000000000"
} = {}) {
  const report = await protocolGatesRead(client, {
    account: inputWallet,
    p33ProbeAssets
  });

  return {
    timestamp: new Date().toISOString(),
    rpcUrl: inputRpcUrl,
    ...report
  };
}

function stringify(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(stringify(await collectProtocolGates()));
}
