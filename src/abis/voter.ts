import type { Abi } from "viem";

export const voterAbi = [
  {
    inputs: [],
    name: "BASIS",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
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
    inputs: [{ internalType: "address", name: "_claimer", type: "address" }],
    name: "addAuthorizedClaimer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_manager", type: "address" }],
    name: "addAuthorizedDLMMManager",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "finish", type: "uint256" }
    ],
    name: "batchDistributeByIndex",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "clFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "clGaugeFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address[]", name: "gauges", type: "address[]" },
      { internalType: "address[][]", name: "tokens", type: "address[][]" },
      { internalType: "uint256[][]", name: "nfpTokenIds", type: "uint256[][]" },
      { internalType: "address[]", name: "nfpManagers", type: "address[]" }
    ],
    name: "claimClGaugeRewards",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address[]", name: "gauges", type: "address[]" },
      { internalType: "address[][]", name: "tokens", type: "address[][]" },
      { internalType: "uint256[][]", name: "nfpTokenIds", type: "uint256[][]" }
    ],
    name: "claimClGaugeRewards",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "address[]", name: "feeDistributors", type: "address[]" },
      { internalType: "address[][]", name: "tokens", type: "address[][]" }
    ],
    name: "claimIncentives",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "address[]", name: "feeDistributors", type: "address[]" },
      { internalType: "address[][]", name: "tokens", type: "address[][]" }
    ],
    name: "claimLegacyIncentives",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address[]", name: "gauges", type: "address[]" },
      { internalType: "address[][]", name: "tokens", type: "address[][]" }
    ],
    name: "claimRewards",
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
    name: "createCLGauge",
    outputs: [{ internalType: "address", name: "gauge", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "pair", type: "address" }],
    name: "createDLMMRewarder",
    outputs: [{ internalType: "address", name: "rewarder", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "recipient", type: "address" }],
    name: "createFeeDistributorWithRecipient",
    outputs: [{ internalType: "address", name: "feeDistributor", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "pool", type: "address" }],
    name: "createGauge",
    outputs: [{ internalType: "address", name: "gauge", type: "address" }],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "dlmmFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "dlmmRewarderFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "distribute",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "distributeAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "gauge", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "distributeForPeriod",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "feeDistributorFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "feeDistributorForGauge",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "feeRecipientFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "gaugeFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "int24", name: "tickSpacing", type: "int24" }
    ],
    name: "gaugeForClPool",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "pool", type: "address" }],
    name: "gaugeForPool",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "gauge", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "gaugePeriodDistributed",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "gaugeRedirect",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "gauge", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "gaugeRewardsPerPeriod",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getAllAuthorizedClaimers",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getAllFeeDistributors",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getAllGauges",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getAllPools",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "user", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "getAllUserVotedPoolsPerPeriod",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "period", type: "uint256" }],
    name: "getAllVotersPerPeriod",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "uint256", name: "period", type: "uint256" },
      { internalType: "uint256", name: "index", type: "uint256" }
    ],
    name: "getAllVotersPerPeriodAt",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "period", type: "uint256" }],
    name: "getAllVotersPerPeriodLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "index", type: "uint256" }],
    name: "getGauge",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getGaugesLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getPeriod",
    outputs: [{ internalType: "uint256", name: "period", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "index", type: "uint256" }],
    name: "getPool",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "getPoolsLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "getVotes",
    outputs: [
      { internalType: "address[]", name: "votes", type: "address[]" },
      { internalType: "uint256[]", name: "weights", type: "uint256[]" }
    ],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "governor",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{
      components: [
        { internalType: "address", name: "ram", type: "address" },
        { internalType: "address", name: "legacyFactory", type: "address" },
        { internalType: "address", name: "gauges", type: "address" },
        { internalType: "address", name: "feeDistributorFactory", type: "address" },
        { internalType: "address", name: "minter", type: "address" },
        { internalType: "address", name: "msig", type: "address" },
        { internalType: "address", name: "xRam", type: "address" },
        { internalType: "address", name: "clFactory", type: "address" },
        { internalType: "address", name: "clGaugeFactory", type: "address" },
        { internalType: "address", name: "nfpManager", type: "address" },
        { internalType: "address", name: "feeRecipientFactory", type: "address" },
        { internalType: "address", name: "voteModule", type: "address" }
      ],
      internalType: "struct IVoter.InitializationParams",
      name: "inputs",
      type: "tuple"
    }],
    name: "initialize",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_accessHub", type: "address" }],
    name: "initializeAccessHub",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "isAntiSybilEnabled",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "manager", type: "address" }],
    name: "isAuthorizedDLMMManager",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "isAlive",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "isClGauge",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "rewarder", type: "address" }],
    name: "isDLMMRewarder",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "feeDistributor", type: "address" }],
    name: "isFeeDistributor",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "isGauge",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "isLegacyGauge",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "isWhitelisted",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "killGauge",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "lastDistro",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "lastVoted",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "legacyFactory",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "minter",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "nfpManager",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "notifyRewardAmount",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "poke",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "feeDistributor", type: "address" }],
    name: "poolForFeeDistributor",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "poolForGauge",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "pool", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "poolTotalVotesPerPeriod",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "ram",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "oldGauge", type: "address" },
      { internalType: "address", name: "newGauge", type: "address" },
      { internalType: "address", name: "recipient", type: "address" }
    ],
    name: "redirectEmissions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_claimer", type: "address" }],
    name: "removeAuthorizedClaimer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_manager", type: "address" }],
    name: "removeAuthorizedDLMMManager",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "feeDistributor", type: "address" },
      { internalType: "address", name: "token", type: "address" }
    ],
    name: "removeFeeDistributorReward",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "reset",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "rewardValidator",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "gauge", type: "address" }],
    name: "reviveGauge",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "revokeWhitelist",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_dlmmFactory", type: "address" }],
    name: "setDLMMFactory",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "rewarder", type: "address" },
      { internalType: "int24", name: "deltaBinA", type: "int24" },
      { internalType: "int24", name: "deltaBinB", type: "int24" }
    ],
    name: "setDLMMRewarderDeltaBins",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_dlmmRewarderFactory", type: "address" }],
    name: "setDLMMRewarderFactory",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "ratio", type: "uint256" }],
    name: "setGlobalRatio",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_governor", type: "address" }],
    name: "setGovernor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_nfpManager", type: "address" }],
    name: "setNfpManager",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "_rewardValidator", type: "address" }],
    name: "setRewardValidator",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "_timeThresholdForRewarder", type: "uint256" }],
    name: "setTimeThresholdForRewarder",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" }
    ],
    name: "stuckEmissionsRecovery",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "syncVoterOwnsFactory",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" }
    ],
    name: "tickSpacingsForPair",
    outputs: [{ internalType: "int24[]", name: "", type: "int24[]" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "timeThresholdForRewarder",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "toggleAntiSybil",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "period", type: "uint256" }],
    name: "totalRewardPerPeriod",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "uint256", name: "period", type: "uint256" }],
    name: "totalVotesPerPeriod",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "gauge", type: "address" },
      { internalType: "address", name: "feeDistributor", type: "address" }
    ],
    name: "updateFeeDistributorForGauge",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "gauge", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "updateLastDistro",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" },
      { internalType: "uint256", name: "index", type: "uint256" }
    ],
    name: "userVotedPoolsPerPeriod",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "userVotedPoolsPerPeriodLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" },
      { internalType: "address", name: "pool", type: "address" }
    ],
    name: "userVotesForPoolPerPeriod",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "uint256", name: "period", type: "uint256" }
    ],
    name: "userVotingPowerPerPeriod",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "voteModule",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "address[]", name: "pools", type: "address[]" },
      { internalType: "uint256[]", name: "weights", type: "uint256[]" }
    ],
    name: "vote",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "whitelist",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [],
    name: "xRam",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function"
  },
  {
    inputs: [],
    name: "xRatio",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function"
  }
] as const satisfies Abi;
