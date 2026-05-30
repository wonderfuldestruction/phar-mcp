import { parseAbi } from "viem";

export const pharTokenAbi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function burn(uint256 value)",
  "function burnFrom(address account, uint256 value)",
  "function decimals() view returns (uint8)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function mint(address to, uint256 amount)",
  "function minter() view returns (address)",
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function setMinter(address _minter)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)"
]);
