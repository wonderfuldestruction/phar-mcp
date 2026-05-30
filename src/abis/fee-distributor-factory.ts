import type { Abi } from "viem";

export const feeDistributorFactoryAbi = [
  {
    inputs: [{ internalType: "address", name: "pool", type: "address" }],
    name: "createFeeDistributor",
    outputs: [{ internalType: "address", name: "feeDistributor", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "lastFeeDistributor",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
] as const satisfies Abi;
