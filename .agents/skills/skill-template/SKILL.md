---
name: skill-template
description: Template for new project skills. Replace placeholders with your skill details.
---
# Skill Template

> Replace all placeholders with your skill details. Copy this file, rename, and customize.

## Domain

What this skill covers and when to use it. Be specific.

## Source Files

| Path | Description |
|------|-------------|
| `crates/your-crate/src/` | Rust source |
| `scripts/your-skill/` | Helper scripts |
| `bot/configs/your-config.toml` | Configuration |

## Client

```bash
# How to invoke this skill
python3 scripts/your-skill/call.py <action> '<json_args>'
```

| Field | Value |
|-------|-------|
| Script | `scripts/your-skill/call.py` |
| Usage | `python3 <script> <action> '<json_args>'` |

## Hard Rules

1. Rule 1 — what to do or avoid (non-negotiable)
2. Rule 2 — constraint or workflow requirement
3. Rule 3 — data format requirement (e.g. bigints as strings)

## Commands

```bash
# Build
cargo build -p your-crate

# Run
docker compose up -d your-service

# View config
cat bot/configs/your-config.toml
```

## Workflow

| Flow | Steps |
|------|-------|
| **Example flow** | `step_one` → `step_two` → `step_three` |

## Safety

- System guarantees (e.g. "server never signs or broadcasts")
- Failure modes + limits (e.g. timeouts, retries, memory usage)
- Pre-action checks required (e.g. "verify gates before mutating")

## References

- `path/to/doc` — description
