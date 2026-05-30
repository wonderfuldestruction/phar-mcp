import { routerAbi } from "./router.js";
import { ramsesV3FactoryAbi } from "./ramses-v3-factory.js";
import { ramsesV3PositionManagerAbi } from "./ramses-v3-position-manager.js";
import { swapRouterAbi } from "./swap-router.js";
import { quoterAbi } from "./quoter.js";
import { quoterV2Abi } from "./quoter-v2.js";
import { tickLensAbi } from "./tick-lens.js";
import { universalRouterAbi } from "./universal-router.js";
import { uniswapInterfaceMulticallAbi } from "./uniswap-interface-multicall.js";
import { mixedRouteQuoterV1Abi } from "./mixed-route-quoter-v1.js";
import { voterAbi } from "./voter.js";
import { clGaugeV3Abi } from "./cl-gauge-v3.js";
import { pairFactoryAbi } from "./pair-factory.js";
import { feeDistributorFactoryAbi } from "./fee-distributor-factory.js";
import { feeRecipientFactoryAbi } from "./fee-recipient-factory.js";
import { voteModuleAbi } from "./vote-module.js";
import { legacyGaugeFactoryAbi } from "./legacy-gauge-factory.js";
import { feeCollectorAbi } from "./fee-collector.js";
import { xPharTokenAbi } from "./xphar-token.js";
import { p33Abi } from "./p33.js";
import { autoVaultAbi } from "./auto-vault.js";
import { dlmmRouterAbi } from "./dlmm-router.js";
import { dlmmFactoryAbi } from "./dlmm-factory.js";
import { dlmmPoolAbi } from "./dlmm-pool.js";
import { dlmmRewarderAbi } from "./dlmm-rewarder.js";
import { dlmmRewarderFactoryAbi } from "./dlmm-rewarder-factory.js";
import { pharTokenAbi } from "./phar-token.js";
import { minterAbi } from "./minter.js";
import { accessHubAbi } from "./access-hub.js";
import { treasuryHelperAbi } from "./treasury-helper.js";
import { clGaugeFactoryAbi } from "./cl-gauge-factory.js";
import { legacyPairAbi } from "./legacy-pair.js";
import { legacyGaugeAbi } from "./legacy-gauge.js";
import { feeDistributorAbi } from "./fee-distributor.js";
import { feeRecipientAbi } from "./fee-recipient.js";
import { ramsesV3PoolAbi } from "./ramses-v3-pool.js";
import { erc20ReadAbi } from "./erc20-read.js";
import { wavaxTokenAbi } from "./wavax-token.js";
import { erc721ReadAbi } from "./erc721-read.js";
import { erc1155ReadAbi } from "./erc1155-read.js";
import { erc20ApprovalAbi } from "./erc20-approval.js";
import { erc721ApprovalAbi } from "./erc721-approval.js";

export const contractAbis = {
  pharToken: pharTokenAbi,
  router: routerAbi,
  minter: minterAbi,
  accessHub: accessHubAbi,
  treasuryHelper: treasuryHelperAbi,
  ramsesV3Factory: ramsesV3FactoryAbi,
  ramsesV3Pool: ramsesV3PoolAbi,
  ramsesV3PositionManager: ramsesV3PositionManagerAbi,
  swapRouter: swapRouterAbi,
  quoter: quoterAbi,
  quoterV2: quoterV2Abi,
  tickLens: tickLensAbi,
  universalRouter: universalRouterAbi,
  uniswapInterfaceMulticall: uniswapInterfaceMulticallAbi,
  mixedRouteQuoterV1: mixedRouteQuoterV1Abi,
  voter: voterAbi,
  clGaugeFactory: clGaugeFactoryAbi,
  clGaugeV3: clGaugeV3Abi,
  legacyPair: legacyPairAbi,
  legacyGauge: legacyGaugeAbi,
  feeDistributor: feeDistributorAbi,
  feeRecipient: feeRecipientAbi,
  pairFactory: pairFactoryAbi,
  feeDistributorFactory: feeDistributorFactoryAbi,
  feeRecipientFactory: feeRecipientFactoryAbi,
  voteModule: voteModuleAbi,
  legacyGaugeFactory: legacyGaugeFactoryAbi,
  feeCollector: feeCollectorAbi,
  xPharToken: xPharTokenAbi,
  p33: p33Abi,
  autoVault: autoVaultAbi,
  dlmmRouter: dlmmRouterAbi,
  dlmmFactory: dlmmFactoryAbi,
  dlmmPool: dlmmPoolAbi,
  dlmmRewarder: dlmmRewarderAbi,
  dlmmRewarderFactory: dlmmRewarderFactoryAbi,
  wavaxToken: wavaxTokenAbi,
  erc20Read: erc20ReadAbi,
  erc721Read: erc721ReadAbi,
  erc1155Read: erc1155ReadAbi,
  erc20Approval: erc20ApprovalAbi,
  erc721Approval: erc721ApprovalAbi,
} as const;

export type ContractAbiKey = keyof typeof contractAbis;

// Re-export individual ABIs for direct imports
export {
  routerAbi,
  ramsesV3FactoryAbi,
  ramsesV3PositionManagerAbi,
  swapRouterAbi,
  quoterAbi,
  quoterV2Abi,
  tickLensAbi,
  universalRouterAbi,
  uniswapInterfaceMulticallAbi,
  mixedRouteQuoterV1Abi,
  voterAbi,
  clGaugeV3Abi,
  pairFactoryAbi,
  feeDistributorFactoryAbi,
  feeRecipientFactoryAbi,
  voteModuleAbi,
  legacyGaugeFactoryAbi,
  feeCollectorAbi,
  xPharTokenAbi,
  p33Abi,
  autoVaultAbi,
  dlmmRouterAbi,
  dlmmFactoryAbi,
  dlmmPoolAbi,
  dlmmRewarderAbi,
  dlmmRewarderFactoryAbi,
  pharTokenAbi,
  minterAbi,
  accessHubAbi,
  treasuryHelperAbi,
  clGaugeFactoryAbi,
  legacyPairAbi,
  legacyGaugeAbi,
  feeDistributorAbi,
  feeRecipientAbi,
  ramsesV3PoolAbi,
  erc20ReadAbi,
  wavaxTokenAbi,
  erc721ReadAbi,
  erc1155ReadAbi,
  erc20ApprovalAbi,
  erc721ApprovalAbi,
};
