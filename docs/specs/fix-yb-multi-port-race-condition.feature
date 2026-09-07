Feature: Fix YB multi-port race condition
  Background:
    Given Yautja Bridge service worker running
    And at least one Yautja helmet broker listening on a TCP port
    And the extension is loaded as unpacked in Chrome

  Scenario: Single-instance arranca con yjPort no configurado (fallback a DEFAULT_PORTS)
    Given no `yjPort` in `chrome.storage.local`
    And no `yjPort` in `config.json`
    And the Yautja default helmet is listening on port 9876
    When the service worker starts
    Then `candidatePorts` is `[9876, 9877, 9878, 9879, 9880, 9881, 9882, 9883, 9884, 9885]`
    And the SW connects to port 9876
    And `link.connected` is `true` for the helmet 9876

  Scenario: Multi-instance con yjPort configurado en config.json, helmet vivo
    Given `config.json` contains `{ "yjPort": 9999 }`
    And the Victoria helmet is listening on port 9999
    And the Yautja default helmet is listening on port 9876
    When the service worker starts
    Then `applyConfigFromPackage` writes `9999` to `chrome.storage.local.yjPort`
    And `candidatePorts` is `[9999]` (only, NO fallback to DEFAULT_PORTS)
    And the SW connects to port 9999
    And `link.connected` is `true` for the helmet 9999
    And the helmet 9876 does NOT receive any `hello` message from this SW

  Scenario: Multi-instance con yjPort en storage, helmet NO vivo al arrancar
    Given `chrome.storage.local.yjPort` is `9999`
    And the Victoria helmet on port 9999 is NOT listening
    And the Yautja default helmet is listening on port 9876
    When the service worker starts
    Then `candidatePorts` is `[9999]` (only)
    And the first connection attempt to 9999 fails
    And `ws.onclose` fires with `wasConnected = false`
    And the SW does NOT rotate to port 9876
    And the SW schedules a reconnect to port 9999 (with backoff via `scheduleReconnect`)
    And the SW keeps retrying port 9999 in subsequent attempts

  Scenario: Cambio de yjPort en storage tras conexión exitosa
    Given the SW is connected to port 9999
    And `chrome.storage.local.yjPort` is `9999`
    When `chrome.storage.local.set({ yjPort: 9998 })` is called
    And the helmet on 9998 starts listening
    Then `chrome.storage.onChanged` listener fires
    And `portIndex` is reset to `0`
    And `everConnected` is reset to `false`
    And `candidatePorts` is recomputed to `[9998]`
    And the current WS is closed (or skipped if already closed)
    And `connectWS()` is called
    And the SW connects to port 9998

  Scenario: ws.close() falla porque el socket ya estaba cerrado
    Given the SW is connected to port 9999
    When `chrome.storage.local.set({ yjPort: 9998 })` triggers the listener
    And `ws.readyState` is `CLOSED` (not `OPEN` or `CONNECTING`)
    Then the `try { ws.close() }` throws an exception that is silently caught
    But the listener STILL calls `connectWS()` explicitly
    And the SW reconnects to the new port

  Scenario: yjPort inválido (no integer, fuera de rango) cae a DEFAULT_PORTS
    Given `chrome.storage.local.yjPort` is `"not-a-number"`
    When the service worker reads candidate ports
    Then the value is rejected (not a valid integer)
    And `candidatePorts` falls back to `DEFAULT_PORTS`
    And the SW attempts to connect to `DEFAULT_PORTS[0]` (9876)

  Scenario: Comportamiento de un solo candidato
    Given `candidatePorts` is `[9999]` (only one)
    When `ws.onclose` fires with `wasConnected = false`
    Then `rotatePort()` is NOT called (no other candidates)
    And `scheduleReconnect()` schedules a retry to port 9999
    And the backoff is `RECONNECT_DELAY` (2000ms)

  Scenario: Reset de estado al cambiar yjPort
    Given the SW is connected to port 9999 with `everConnected = true`
    When `chrome.storage.onChanged` fires for `yjPort`
    Then `everConnected` is reset to `false`
    And `portIndex` is reset to `0`
    And the SW does NOT carry over the "sticky" success of port 9999 to a new attempt

  Scenario: Cambio de config.json tras carga inicial NO afecta storage (config es one-shot)
    Given the SW already loaded `config.json` and set `yjPort: 9999`
    When the user changes `config.json` to `yjPort: 9998` and reloads the extension
    Then `applyConfigFromPackage` runs again on `chrome.runtime.onInstalled`
    And `chrome.storage.local.yjPort` is updated to `9998` (if different from current)
    And `chrome.storage.onChanged` listener fires as a result
    And the SW reconnects to port 9998
