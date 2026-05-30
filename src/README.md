# src/

TypeScript MCP server for Pharaoh DEX on Avalanche C-Chain. Readonly by default — never signs or broadcasts.

## File Map

| File | Purpose |
|---|---|
| `index.ts` | MCP entrypoint, tool registration, Zod input schemas |
| `queryTools.ts` | Readonly chain reads, quotes, route discovery, reward claimability (view/pure calls only) |
| `workflowTools.ts` | Action-to-contract mapping, unsigned calldata builders (returns `{ to, data, value }`) |
| `contracts.ts` | Contract address registry with provenance status |
| `abis.ts` | ABI definitions (re-exported from `abis/` directory) |
| `lookup.ts` | Contract/function lookup, ABI formatting, normalization helpers |
| `docs.ts` | Live docs.phar.gg fetch, sanitize, search with in-memory cache |
| `json.ts` | BigInt-safe JSON serialization |

## Tool Flow

```
User intent → pharaoh_*_plan (reads + quotes + approvals)
           → pharaoh_*_build_tx (unsigned calldata)
           → pharaoh_simulate_tx (verify on fork)
           → Wallet signs + broadcasts (outside MCP)
```

## Tool Naming Convention

- `pharaoh_*_read` — readonly state queries (view/pure calls)
- `pharaoh_*_build_tx` — encode unsigned calldata, never sign
- `pharaoh_*_plan` — compose reads + quotes + approval checks + builder hints
- `pharaoh_docs_*` — fetch and search live docs.phar.gg

## Key Invariants

- **Never** signs or broadcasts transactions — returns unsigned calldata only
- All `BigInt` values returned as decimal strings in MCP responses
- All chain reads use viem `view`/`pure` calls
- No private keys in server code

## For LLMs

- The `abis/` directory contains individual ABI files; `abis.ts` re-exports them.
- `queryTools.ts` uses section dividers (`// === DOMAIN ===`) for quick navigation.
