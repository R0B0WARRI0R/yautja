# Yautja

**Bio-helmet for browser-hunting LLMs** — a sensory cortex between Chrome DevTools Protocol (CDP) and AI agents, delivered as an MCP server plus a Chrome extension.

Yautja gives a language model full, structured awareness and control of a real browser: network traffic, DOM, console, performance, security posture and page interactions — exposed as **70+ MCP tools**.

## Architecture

```
LLM agent ◄─MCP (stdio)─► Yautja helmet (TypeScript/Node)
                              │ WebSocket
                              ▼
                    Chrome extension (instrumentation layer)
                              │ CDP
                              ▼
                          Chrome
```

- **`src/`** — MCP server: connection, doctrine (action classification), intel (evidence store), macros, targeting (observation), vision (DOM/console/network/performance/security sensors), proxy (MITM), arsenal (typed actions).
- **`extension/`** — Chrome extension: request interception, WebSocket capture, HUD, site profiles.
- **`tests/`** — unit + integration suites (Vitest).
- **`docs/`** — phased specs (P1–P18), changelog, protocol notes.

## Highlights

- **70+ MCP tools** for observe/act flows: smart typing, declarative waits, network capture, response diffing, session snapshots, macros, tab/session groups.
- **Doctrine envelope**: every action is classified and validated before touching the page, with recovery strategies on failure.
- **MITM proxy + extension** hybrid interception for full traffic visibility.
- **Strict TypeScript**, phased architecture, documented protocol.

## Tech

TypeScript · Node.js · Chrome DevTools Protocol · WebSocket (`ws`) · Playwright · LevelDB (`classic-level`) · Zod · Vitest

## Build & test

```bash
npm install
npm run build        # tsc
npm test             # vitest
npm run helmet       # build + start MCP server
```

## Status

Personal R&D project (v0.2.0). Developed solo as an exploration of agent–browser interfaces.

## Security notes

- The local broker (multi-instance coordination) listens on **localhost only** and accepts any local client without authentication. It is designed for single-user machines where local processes are trusted. Do not expose the port beyond loopback.
- Sensitive fields (passwords, OTPs, card numbers) are redacted before leaving the tool boundary; session recordings and evidence stores apply the same redaction policy.
