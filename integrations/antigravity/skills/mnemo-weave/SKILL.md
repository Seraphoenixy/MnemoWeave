---
name: mnemo-weave
description: >-
  Use this skill when working with MnemoWeave MCP tools in Antigravity to read or
  update shared Working Rules, search or manage Workspace Documents, or recall,
  link, and store durable insights in Memory Spaces.
---

# MnemoWeave for Antigravity

MnemoWeave exposes 14 `mnemo_*` tools over the `mnemo_weave` stdio MCP server (`dist/mnemo-weave-mcp.js`). It shares the same local Working Rules (`~/.mnemon/working-rules/runtime/`), Workspace Documents, and Memory Spaces as Codex and DeepSeek Harness (DSH).

## 1. Working Rules (Standing Preferences)

- **Read**: Call `mnemo_working_rules` at the beginning of a session.
- **Write**: Call `mnemo_runtime_memory` with `action: "add" | "replace" | "remove"`.
  - Use `importance: "critical"` for explicit must/always/never rules, `"normal"` by default, `"low"` for transient facts.

## 2. Workspace Documents (Substantial Records)

- **Search**: Call `mnemo_document_search` with a focused `query` (or `""` to list recent documents). Set `includeArchived: true` only when inspecting a known cold-archived reference.
- **Manage**: Call `mnemo_document_manage` with `action: "create" | "update" | "archive"`.
  - Use for designs, investigations, runbooks, or handoffs.
  - Provide `sourcePaths` (relative to the workspace) for read-only file references.

## 3. Memory Spaces (Durable Knowledge & Graph)

- **Inspect**: Call `mnemo_memory_bodies` to list Memory Space IDs, activation, and capabilities. Call `mnemo_status` only when diagnosing a provider error or checking health.
- **Recall**: Call `mnemo_recall` with a focused `query` (omit `memoryBodyIds` to search all pinned active spaces). Use `mnemo_related` to traverse graph edges from a recalled insight ID.
- **Write**: Call `mnemo_remember` to store a self-contained durable entry, `mnemo_link` to connect two verified insight IDs in the same space, or `mnemo_forget` to soft-delete an obsolete insight.
  - Set `category` to the narrowest match (omitting it defaults to `"general"`): `"preference"` (user habits/style), `"decision"` (trade-offs/standards), `"fact"` (platform behavior/API constraints), `"insight"` (diagnosed cause-and-remedy/patterns), `"context"` (environment/project background), or `"general"`.
- **Space lifecycle**: Only call `mnemo_memory_body_create`, `mnemo_memory_body_update`, or `mnemo_memory_body_merge` on explicit user request.

## 4. Storage & Sync Configuration

- Default Working Rules live in `~/.mnemon` (override via `MNEMON_DATA_DIR`).
- Storage scope for Documents and Memory Spaces defaults to `global` (override via `--storage-scope` / `MNEMON_STORAGE_SCOPE` and `--storage-dir` / `MNEMON_STORAGE_DIR`).
- Optional server sync is enabled in `mcp_config.json` `env` by setting `MNEMOWEAVE_SYNC_URL` and `MNEMOWEAVE_SYNC_PASSWORD`.
