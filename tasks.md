# Tasks — Yautja open issues

Tareas pendientes derivadas del troubleshooting. Append-only.

---

## [open] fix-yb-multi-port-race-condition

- **ID**: `fix-yb-multi-port-race-condition`
- **Origen**: `docs/issues/2026-08-07-yb-multi-port-race-condition.md`
- **Sesión**: 2026-08-07 19:11 UTC
- **Severidad**: Alta — afecta cualquier despliegue multi-instancia
- **Componentes**: `extension-chrome/background.js`, `extension/background.js`

### Descripción

El SW de Yautja Bridge se queda enganchado al primer puerto que responda (race condition entre `fetch config.json` y primer intento de conexión). Una vez conectado, no respeta cambios en `chrome.storage.local.yjPort`. Esto impide que instancias dedicadas de Yautja (puerto distinto al default 9876) funcionen en producción.

### Pasos para implementar (corto plazo)

1. En `background.js`, añadir flag `firstAttempt = true` al `connectWS()`
2. Si el primer candidato es el `yjPort` configurado y falla N veces (N=3), lanzar error y NO rotar a DEFAULT_PORTS
3. Marcar el puerto viejo como "abandonado" cuando `storage.onChanged` dispara cambio de `yjPort`
4. Forzar `connectWS()` después de `ws.close()` incluso si `readyState !== OPEN`

### Pasos para implementar (mediano plazo)

- Implementar "sticky port": el SW recuerda el puerto exitoso en este proceso de vida y solo rota si ese puerto falla N veces consecutivas
- Health check en background del `yjPort` configurado

### Pasos para verificar

1. Levantar 2 helmets (9876 y 9999)
2. Cargar Yautja Bridge unpacked en Chrome Profile 1 con `config.json` apuntando a 9999
3. Verificar que el SW se conecta al 9999 (no al 9876)
4. Cambiar `chrome.storage.local.yjPort` a otro valor y verificar que reconecta
5. Recargar extension y verificar que se reconecta al puerto configurado

### Estado

- [x] Pendiente de implementar
- [x] Implementado — pendiente de verificar por architect
- [ ] Cerrado

### Notas

- El bug NO afecta deployments single-instance (donde solo corre el helmet en 9876)
- El workaround operacional (cerrar Chrome) funciona pero es disruptivo
- La fix de corto plazo es ~20 líneas de código en `background.js`

### Fix aplicado (2026-08-07 22:53 UTC)

**Cambios** (`D:\Yautja\extension-chrome\background.js` y gemelo `D:\Yautja\extension\background.js`):

1. `resolveCandidatePorts()`: cuando hay `yjPort` válido, devuelve SOLO `[yjPort]` (sin fallback a `DEFAULT_PORTS`). Razón: en multi-instancia, el fallback al 9876 era el vector de "robo" del helmet default.
2. `chrome.storage.onChanged` listener: SIEMPRE llama `connectWS()` tras intentar `ws.close()`. Antes solo lo llamaba si `ws` era null, dejando el SW enganchado al puerto viejo cuando el socket ya estaba CLOSING/CLOSED.

**Specs**: `D:\Yautja\docs\specs\fix-yb-multi-port-race-condition.feature` (10 escenarios Given/When/Then).

**Pendiente de verificar por architect**:
- Cargar el extension-chrome modificado en Chrome Profile 1
- Verificar que el SW se conecta al 9999 (no al 9876)
- Probar cambio de yjPort en storage → reconexión
- Confirmar que el bug NO se reproduce
