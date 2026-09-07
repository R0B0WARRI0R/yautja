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

## Autenticación del bridge local

El bridge escucha solo en `127.0.0.1`, pero puedes exigir además un secreto
compartido para que un proceso local ajeno no pueda registrarse como extensión
ni como cliente broker. El arranque normal (`helmet-main.js`) carga el token
desde el `config.json` de la extensión cuyo `yjPort` coincide con el helmet.
El archivo es local y está ignorado por Git.

```powershell
$token = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
@{ yjPort = 9876; yjBridgeToken = $token } | ConvertTo-Json | Set-Content extension/config.json
node dist/helmet-main.js
```

Para Victoria, usa su puerto y su copia de la extensión (`9999` y
`extension-chrome/config.json`). Los helmets que comparten broker deben usar
el mismo token. Recarga la extensión desde `chrome://extensions` después de
cambiar su configuración. `YAUTJA_BRIDGE_TOKEN` sigue disponible para
despliegues que no usen el directorio local de extensiones y tiene prioridad.

## Limitaciones honestas

- **Un navegador = un casco.** Dos cascos contra el mismo Chrome compiten por las pestañas (attach es exclusivo por pestaña en la práctica). Multi-sesión real = varios navegadores (perfiles o instalaciones distintas), cada uno con su extensión y su casco.
- `closeTab`, `switchTab`, site memory y query-burn son por instancia; no hay coordinación entre cascos (biofilm es el embrión de esa idea, opt-in).
- El OPSEC (gates, perfiles, query burn) es **por sesión**: dos agentes en la misma máquina no comparten contadores de cuota. Si corres dos agentes contra Perplexity, la suma de queries la vigilas tú.
