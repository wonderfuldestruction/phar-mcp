import type { Abi } from "viem";

const multicallCallTuple = [
  { internalType: "address", name: "target", type: "address" },
  { internalType: "uint256", name: "gasLimit", type: "uint256" },
  { internalType: "bytes", name: "callData", type: "bytes" }
] as const;

export const uniswapInterfaceMulticallAbi = [
  {
    inputs: [],
    name: "getCurrentBlockTimestamp",
    outputs: [{ internalType: "uint256", name: "timestamp", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "addr", type: "address" }],
    name: "getEthBalance",
    outputs: [{ internalType: "uint256", name: "balance", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ components: multicallCallTuple, internalType: "struct UniswapInterfaceMulticall.Call[]", name: "calls", type: "tuple[]" }],
    name: "multicall",
    outputs: [
      { internalType: "uint256", name: "blockNumber", type: "uint256" },
      { internalType: "bytes[]", name: "returnData", type: "bytes[]" }
    ],
    stateMutability: "nonpayable",
    type: "function"
  }
] as const satisfies Abi;
