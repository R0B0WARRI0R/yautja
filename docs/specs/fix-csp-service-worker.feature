Feature: Fix MV3 Service Worker CSP para permitir WebSocket a localhost
  Background:
    Given Yautja Bridge MV3 extension
    And `background.js` (service worker) creates `new WebSocket("ws://localhost:9999")`
    And Chrome MV3 default CSP for service_worker is `connect-src 'none'`

  Scenario: Service Worker sin CSP declarada NO puede abrir WebSocket
    Given `manifest.json` has no `content_security_policy.service_worker` field
    When the service worker starts and tries `new WebSocket("ws://localhost:9999")`
    Then the WebSocket connection is blocked by CSP
    And the error in the SW console is "Refused to connect" or "Unsupported URL scheme"
    And the SW keeps retrying every 2s with the same failure
    And `link.connected` on the helmet 9999 stays `false`

  Scenario: Service Worker con CSP declarada puede abrir WebSocket
    Given `manifest.json` has:
    ```json
    "content_security_policy": {
        "service_worker": "script-src 'self'; connect-src ws://localhost:* http://localhost:*"
    }
    ```
    When the service worker starts and tries `new WebSocket("ws://localhost:9999")`
    Then the WebSocket connection is allowed by CSP
    And the SW connects to the helmet 9999
    And `link.connected` on the helmet 9999 is `true`
    And the helmet 9999 receives a `hello` message from the SW

  Scenario: CSP no permite conexiones externas (solo localhost)
    Given `manifest.json` has:
    ```json
    "content_security_policy": {
        "service_worker": "script-src 'self'; connect-src ws://localhost:* http://localhost:*"
    }
    ```
    When the service worker tries `new WebSocket("wss://example.com/socket")`
    Then the connection is blocked by CSP (not in connect-src whitelist)
    And no data is sent to the external host
