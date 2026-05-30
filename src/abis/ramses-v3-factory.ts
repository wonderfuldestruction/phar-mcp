import type { Abi } from "viem";

export const ramsesV3FactoryAbi = [
  {
    inputs: [],
    name: "DEFAULT_FEE_FLAG",
    outputs: [{ internalType: "uint24", name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "accessHub",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "int24", name: "tickSpacing", type: "int24" },
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" }
    ],
    name: "createPool",
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "int24", name: "tickSpacing", type: "int24" },
      { internalType: "uint24", name: "initialFee", type: "uint24" }
    ],
    name: "enableTickSpacing",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "feeCollector",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "feeProtocol",
    outputs: [{ internalType: "uint24", name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "pool", type: "address" }],
    name: "gaugeFeeSplitEnable",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "int24", name: "tickSpacing", type: "int24" }
    ],
    name: "getPool",
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_ramsesV3PoolDeployer", type: "address" }],
    name: "initialize",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "pool", type: "address" }],
    name: "isPairV3",
    outputs: [{ internalType: "bool", name: "isV3", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "parameters",
    outputs: [
      { internalType: "address", name: "factory", type: "address" },
      { internalType: "address", name: "token0", type: "address" },
      { internalType: "address", name: "token1", type: "address" },
      { internalType: "uint24", name: "fee", type: "uint24" },
      { internalType: "int24", name: "tickSpacing", type: "int24" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "pool", type: "address" }],
    name: "poolFeeProtocol",
    outputs: [{ internalType: "uint24", name: "__poolFeeProtocol", type: "uint24" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "ramsesV3PoolDeployer",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "_pool", type: "address" },
      { internalType: "uint24", name: "_fee", type: "uint24" }
    ],
    name: "setFee",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_feeCollector", type: "address" }],
    name: "setFeeCollector",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint24", name: "_feeProtocol", type: "uint24" }],
    name: "setFeeProtocol",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "pool", type: "address" },
      { internalType: "uint24", name: "_feeProtocol", type: "uint24" }
    ],
    name: "setPoolFeeProtocol",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_voter", type: "address" }],
    name: "setVoter",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "int24", name: "tickSpacing", type: "int24" }],
    name: "tickSpacingInitialFee",
    outputs: [{ internalType: "uint24", name: "initialFee", type: "uint24" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "voter",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  }
] as const satisfies Abi;
