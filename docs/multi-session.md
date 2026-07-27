# Multi-sesión — varias instancias de Yautja a la vez

Yautja es single-browser por instancia, pero puedes correr N cascos en paralelo (p.ej. uno por agente o por perfil de trabajo) si cada uno tiene **sus propios puertos**.

## Receta por instancia

```powershell
# Instancia A (default)
node dist/helmet-main.js                  # WS 9876, proxy 9877, CDP 9222

# Instancia B
$env:YAUTJA_PORT=9976
$env:YAUTJA_PROXY_PORT=9977
$env:YAUTJA_CDP_REMOTE_PORT=9322
node dist/helmet-main.js
```

| Recurso | Default | Override | ¿Compartido? |
|---------|---------|----------|--------------|
| WS extensión (MCP bridge) | 9876 | `YAUTJA_PORT` o arg CLI | No — cada instancia necesita su puerto y su extensión/navegador |
| MITM proxy (extNetwork) | 9877 | `YAUTJA_PROXY_PORT` | No — conflicto si dos instancias lo usan a la vez |
| CDP remote (extEval) | 9222 | `YAUTJA_CDP_REMOTE_PORT` | No — uno por navegador debuggeado |
| Gates/sessions/evidence | `~/.yautja/sessions/<sessionId>` | automático | **Aislado por sessionId** (ULID por proceso) |
| Site memory | `~/.yautja-memory/` | — | Compartido (OK: es caché de selectores por dominio) |
| Network captures | `~/.yautja-network-captures/` | — | Compartido (OK: append-only) |
| Traces/HAR/snapshots | `~/.yautja/{traces,har,snapshots}` | — | Compartido (OK) |

## Limitaciones honestas

- **Un navegador = un casco.** Dos cascos contra el mismo Chrome compiten por las pestañas (attach es exclusivo por pestaña en la práctica). Multi-sesión real = varios navegadores (perfiles o instalaciones distintas), cada uno con su extensión y su casco.
- `closeTab`, `switchTab`, site memory y query-burn son por instancia; no hay coordinación entre cascos (biofilm es el embrión de esa idea, opt-in).
- El OPSEC (gates, perfiles, query burn) es **por sesión**: dos agentes en la misma máquina no comparten contadores de cuota. Si corres dos agentes contra Perplexity, la suma de queries la vigilas tú.
