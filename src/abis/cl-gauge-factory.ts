import { parseAbi } from "viem";

export const clGaugeFactoryAbi = parseAbi([
  "function createGauge(address pool) returns (address gauge)",
  "function feeCollector() view returns (address)",
  "function getGauge(address pool) view returns (address gauge)",
  "function implementation() view returns (address)",
  "function nfpManager() view returns (address)",
  "function setFeeCollector(address _feeCollector)",
  "function setImplementation(address _newImplementation)",
  "function setNfpManager(address _nfpManager)",
  "function setVoter(address _voter)",
  "function voter() view returns (address)"
]);
