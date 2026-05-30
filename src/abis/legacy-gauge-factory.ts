import type { Abi } from "viem";

export const legacyGaugeFactoryAbi = [
  {
    inputs: [{ internalType: "address", name: "_pool", type: "address" }],
    name: "createGauge",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "lastGauge",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
] as const satisfies Abi;
