import { parseAbi } from "viem";

export const erc721ReadAbi = parseAbi([
  "error ERC721NonexistentToken(uint256 tokenId)",
  "function balanceOf(address owner) view returns (uint256)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)"
]);
