import type { Address } from "viem";
import type { ContractAbiKey } from "./abis.js";

export const CHAIN_ID = 43114;
export const DEFAULT_AVALANCHE_RPC_URL = "https://api.avax.network/ext/bc/C/rpc";

export const sourceUrls = {
  officialContractAddresses: "https://docs.phar.gg/pages/contract-addresses",
  pharaohDocs: "https://docs.phar.gg/",
  avalancheRpcDefault: DEFAULT_AVALANCHE_RPC_URL
} as const;

export type ContractStatus =
  | "verified_abi_first_pass"
  | "source_backed_abi_candidate"
  | "proxy_implementation_verified"
  | "needs_verified_abi"
  | "official_address_only";

export type FunctionListStatus =
  | "abi_functions_available"
  | "generic_erc20_read"
  | "address_only_no_user_abi";

export type ContractRegistryEntry = {
  key: string;
  name: string;
  category: string;
  address: Address;
  status: ContractStatus;
  sourceUrl: string;
  explorerUrl: string;
  abiKey?: ContractAbiKey;
  functionListStatus: FunctionListStatus;
  provenanceNote: string;
};

const docsSource = sourceUrls.officialContractAddresses;

function entry(
  key: string,
  name: string,
  category: string,
  address: Address,
  status: ContractStatus,
  abiKey?: ContractAbiKey,
  metadata: {
    functionListStatus?: FunctionListStatus;
    provenanceNote?: string;
  } = {}
): ContractRegistryEntry {
  return {
    key,
    name,
    category,
    address,
    status,
    sourceUrl: docsSource,
    explorerUrl: `https://snowscan.xyz/address/${address}`,
    abiKey,
    functionListStatus: metadata.functionListStatus ?? (abiKey ? "abi_functions_available" : "address_only_no_user_abi"),
    provenanceNote: metadata.provenanceNote ?? (abiKey
      ? "Local ABI surface is exposed through pharaoh_functions_list and transaction/read tools according to this entry's provenance status."
      : "Official Pharaoh address retained for provenance and cross-links; no local user-facing ABI surface is exposed for this address.")
  };
}

export const contractRegistry = {
  pharToken: entry("pharToken", "PHAR Token", "Token", "0x13A466998Ce03Db73aBc2d4DF3bBD845Ed1f28E7", "verified_abi_first_pass", "pharToken"),
  xPharToken: entry("xPharToken", "xPHAR Token", "Token", "0xE8164Ea89665DAb7a553e667F81F30CfDA736B9A", "verified_abi_first_pass", "xPharToken"),
  p33: entry("p33", "p33", "Token", "0x26e9dbe75aed331e41272bece932ff1b48926ca9", "verified_abi_first_pass", "p33"),
  autoVault: entry("autoVault", "AutoVault", "Autovault", "0xFe99E92df71F53a26005d1bFbe54C941A3131Aa0", "source_backed_abi_candidate", "autoVault"),
  accessHub: entry("accessHub", "AccessHub", "Access Control", "0x3176f6E4Be2448C53EDD59C27651EDFaA74bf483", "source_backed_abi_candidate", "accessHub"),
  timelockController: entry("timelockController", "Pharaoh Timelock", "Access Control", "0x12d54ad6daf65d55b029df1b34b260c68fc0ddcf", "official_address_only", undefined, {
    provenanceNote: "Official Pharaoh governance timelock address. It is retained for provenance and admin-flow inspection; no normal user-facing DEX ABI is exposed."
  }),
  pharaohTeamMultisig: entry("pharaohTeamMultisig", "Pharaoh Team Multisig", "Access Control", "0xd1b27ccAF2A4dDcA0Ac32181374C70282492d843", "official_address_only", undefined, {
    provenanceNote: "Official Pharaoh team multisig address. It is retained as an authority/provenance endpoint, not as a user-interaction contract."
  }),
  proxyAdmin: entry("proxyAdmin", "ProxyAdmin", "Access Control", "0x3B91972c1Ff63296cb824a30997C7e4a982B7ee6", "official_address_only", undefined, {
    provenanceNote: "Official proxy-admin address for upgrade administration. It is intentionally excluded from normal user-facing ABI tools."
  }),
  treasuryHelper: entry("treasuryHelper", "TreasuryHelper", "Treasury", "0x660862D49E92f80f29E56C2770027E8d83e97882", "source_backed_abi_candidate", "treasuryHelper"),
  voter: entry("voter", "Voter", "Voter", "0x922b9Ca8e2207bfB850B6FF647c054d4b58a2Aa7", "source_backed_abi_candidate", "voter"),
  minter: entry("minter", "Minter", "Minter", "0xd23F124bBbC958bCdDC0cE624042B48154222FDE", "verified_abi_first_pass", "minter"),
  voteModule: entry("voteModule", "VoteModule", "Vote Module", "0x34F233F868CdB42446a18562710eE705d66f846b", "verified_abi_first_pass", "voteModule"),
  ramsesV3PoolDeployer: entry("ramsesV3PoolDeployer", "RamsesV3PoolDeployer", "Concentrated Liquidity", "0x6a4113ed0915bCf5E48e758e8f4cEBFFC07C66f9", "official_address_only", undefined, {
    provenanceNote: "Official RamsesV3 pool deployer/helper address. Pool creation is exposed through factory and position-manager tools instead."
  }),
  ramsesV3Factory: entry("ramsesV3Factory", "RamsesV3Factory", "Concentrated Liquidity", "0xAE6E5c62328ade73ceefD42228528b70c8157D0d", "verified_abi_first_pass", "ramsesV3Factory"),
  ramsesV3FactoryInitializedDeployer: entry("ramsesV3FactoryInitializedDeployer", "RamsesV3Factory InitializedDeployer", "Concentrated Liquidity", "0xCBeB24e8fc568001e83430Ec4929ce56B29bA9a2", "official_address_only", undefined, {
    provenanceNote: "Official initialized-deployer/operator address referenced by CL deployment. It is not a normal user-facing DEX contract."
  }),
  ramsesV3PositionManager: entry("ramsesV3PositionManager", "RamsesV3PositionManager", "Concentrated Liquidity", "0x0B4478e810D48B5882D4019D435A2f864Bab4F39", "verified_abi_first_pass", "ramsesV3PositionManager"),
  nonfungibleTokenPositionDescriptor: entry("nonfungibleTokenPositionDescriptor", "NonfungibleTokenPositionDescriptor", "Concentrated Liquidity", "0x6F17dB548544a19162E82b20c67aBee99960a89a", "official_address_only", undefined, {
    provenanceNote: "Official NFT metadata descriptor address. User CL position actions are exposed through RamsesV3PositionManager."
  }),
  swapRouter: entry("swapRouter", "SwapRouter", "Concentrated Liquidity", "0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c", "verified_abi_first_pass", "swapRouter"),
  quoter: entry("quoter", "Quoter", "Concentrated Liquidity", "0xAdAe75447D112cfC401C952744de3E6d32456465", "verified_abi_first_pass", "quoter"),
  quoterV2: entry("quoterV2", "QuoterV2", "Concentrated Liquidity", "0xB7297301b7CC659BB96D51754643A0Df6eEA2138", "verified_abi_first_pass", "quoterV2"),
  tickLens: entry("tickLens", "TickLens", "Concentrated Liquidity", "0x3a7Aeb3c33922073F4F23207D0ff247e9694A100", "verified_abi_first_pass", "tickLens"),
  universalRouter: entry("universalRouter", "UniversalRouter", "Concentrated Liquidity", "0x5AcC35397D2ce81Ac54A4B1c6D9e1FB29F8EC6C6", "verified_abi_first_pass", "universalRouter"),
  uniswapInterfaceMulticall: entry("uniswapInterfaceMulticall", "UniswapInterfaceMulticall", "Concentrated Liquidity", "0xf296bb0EAeAB6703d876b1BFe9d5693eF302B855", "verified_abi_first_pass", "uniswapInterfaceMulticall"),
  mixedRouteQuoterV1: entry("mixedRouteQuoterV1", "MixedRouteQuoterV1", "Concentrated Liquidity", "0x3265d621c7d993151C8EB2aCd4902CdA0499A8a0", "verified_abi_first_pass", "mixedRouteQuoterV1"),
  ramsesV3Pool: entry("ramsesV3Pool", "RamsesV3Pool Instance ABI", "Concentrated Liquidity", "0x1Abbf74e863e19940ED364C6EE1Ffb782e204d20", "verified_abi_first_pass", "ramsesV3Pool"),
  clGaugeFactory: entry("clGaugeFactory", "CL GaugeFactory", "Concentrated Liquidity", "0xE565310BAa582C768a77a3BB7F86a892eF07D04e", "verified_abi_first_pass", "clGaugeFactory"),
  clGaugeV3: entry("clGaugeV3", "GaugeV3 Implementation ABI", "Concentrated Liquidity", "0x031A975187111aFe6b9dc473cd317B00Ed8Cd262", "verified_abi_first_pass", "clGaugeV3"),
  feeCollector: entry("feeCollector", "FeeCollector", "Concentrated Liquidity", "0x1e1e2a861205767D69A51edf03cf5e3a278437bc", "verified_abi_first_pass", "feeCollector"),
  legacyPair: entry("legacyPair", "Legacy Pair Instance ABI", "Legacy", "0x1cca95F17Eb953cd8c3D91fe81C7e8e815ac8ADd", "verified_abi_first_pass", "legacyPair"),
  legacyGauge: entry("legacyGauge", "Legacy Gauge Instance ABI", "Legacy", "0x44cf080397ceF7D9344A1f0f84052AC474a5B43e", "source_backed_abi_candidate", "legacyGauge"),
  feeDistributor: entry("feeDistributor", "FeeDistributor Instance ABI", "Legacy", "0xc59B736e548D06e7b80C12703b2b8e8EcF73E45c", "source_backed_abi_candidate", "feeDistributor"),
  feeRecipient: entry("feeRecipient", "FeeRecipient Instance ABI", "Legacy", "0x4b9c8302d2C77C348F64260eC4364cC0171d7164", "source_backed_abi_candidate", "feeRecipient"),
  pairFactory: entry("pairFactory", "PairFactory", "Legacy", "0x85448bF2F589ab1F56225DF5167c63f57758f8c1", "source_backed_abi_candidate", "pairFactory"),
  router: entry("router", "Router", "Legacy", "0x9CEE04bDcE127DA7E448A333f006DEFb3d5e38cC", "verified_abi_first_pass", "router"),
  legacyGaugeFactory: entry("legacyGaugeFactory", "Legacy GaugeFactory", "Legacy", "0xd9A63c24F69F015ebe3FF61817645DC7CC5906B1", "verified_abi_first_pass", "legacyGaugeFactory"),
  feeDistributorFactory: entry("feeDistributorFactory", "FeeDistributorFactory", "Legacy", "0x5Af7Fad6E813fb4637e5cFacC7DdE6c5445125ac", "verified_abi_first_pass", "feeDistributorFactory"),
  feeRecipientFactory: entry("feeRecipientFactory", "FeeRecipientFactory", "Legacy", "0x227fABb4dB11CC082EF8cd083CfF5d034D4de16F", "verified_abi_first_pass", "feeRecipientFactory"),
  dlmmRouter: entry("dlmmRouter", "DLMMRouter", "DLMM", "0xff2BEFC4ff86CB0f3e8D3d9D6200B7A05BF5D93d", "source_backed_abi_candidate", "dlmmRouter"),
  dlmmFactory: entry("dlmmFactory", "DLMMFactory", "DLMM", "0xEb480050b016f6c6d45203D2346B68bDDDa23D4D", "source_backed_abi_candidate", "dlmmFactory"),
  dlmmPoolImplementation: entry("dlmmPoolImplementation", "DLMMPool Implementation ABI", "DLMM", "0xF41253C1258a7a3C291e695158267B173C26d710", "source_backed_abi_candidate", "dlmmPool"),
  dlmmRewarderFactory: entry("dlmmRewarderFactory", "DLMMRewarderFactory", "DLMM", "0xd28467eDe84cEde6B05070779E39Eaff4988548C", "verified_abi_first_pass", "dlmmRewarderFactory"),
  dlmmRewarderImplementation: entry("dlmmRewarderImplementation", "DLMMRewarder Implementation ABI", "DLMM", "0xC997575204290FF7106aB8b2BCFa7e7dEA43D783", "source_backed_abi_candidate", "dlmmRewarder"),
  dlmmWavaxUsdc5Pool: entry("dlmmWavaxUsdc5Pool", "DLMM WAVAX/USDC BinStep 5 Pool", "DLMM", "0x8aC5707f8D4BDe1d771d34c7AfD81c3922b73379", "source_backed_abi_candidate", "dlmmPool"),
  wavax: entry("wavax", "WAVAX", "Token", "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "verified_abi_first_pass", "wavaxToken", {
    provenanceNote: "Official routing token address. Public Snowtrace/Routescan ABI exact-matches the local WAVAX ERC20 wrapping surface; normal MCP write tools still return unsigned calldata only."
  }),
  usdcNative: entry("usdcNative", "Avalanche USDC", "Token", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "official_address_only", "erc20Read", {
    functionListStatus: "generic_erc20_read",
    provenanceNote: "Official token address retained for Pharaoh routing and examples. Public explorer ABI at this proxy address is admin-only, so only generic ERC20 read functions are exposed; approvals use pharaoh_encode_approval."
  })
} as const satisfies Record<string, ContractRegistryEntry>;

export type ContractKey = keyof typeof contractRegistry;

/** @summary Return all contract registry entries as an array for iteration */
export function registryEntries(): ContractRegistryEntry[] {
  return Object.values(contractRegistry);
}
