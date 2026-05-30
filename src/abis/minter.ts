import { parseAbi } from "viem";

export const minterAbi = parseAbi([
  "function BASIS() view returns (uint256)",
  "function EARLY_EPOCH_MAX_DEVIATION() view returns (uint256)",
  "function INITIAL_SUPPLY() view returns (uint256)",
  "function MAX_DEVIATION() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function accessHub() view returns (address)",
  "function activePeriod() view returns (uint256)",
  "function adjustEmissions(int256 _basisPointsChange)",
  "function calculateWeeklyEmissions() view returns (uint256)",
  "function emissionsMultiplier() view returns (uint256)",
  "function firstPeriod() view returns (uint256)",
  "function getEpoch() view returns (uint256 _epoch)",
  "function getPeriod() view returns (uint256 period)",
  "function initEpoch0()",
  "function kickoff(address _rex, address _voter, uint256 _initialWeeklyEmissions, uint256 _initialMultiplier, address _xPhar)",
  "function lastMultiplierUpdate() view returns (uint256)",
  "function operator() view returns (address)",
  "function phar() view returns (address)",
  "function rebase()",
  "function updatePeriod() returns (uint256 period)",
  "function updatePeriodAndRebase()",
  "function voter() view returns (address)",
  "function weeklyEmissions() view returns (uint256)",
  "function xPhar() view returns (address)"
]);
