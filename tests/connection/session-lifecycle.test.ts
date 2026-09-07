import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ExtensionServer, type SessionOverview } from '../../src/connection/extension-server.js';

/**
 * Tests para las 3 soluciones anti-zombi:
 * 1. Heartbeat + TTL en sessionGroups (sweepDeadGroups)
 * 2. sessionList + sessionDestroy (getSessionOverview + forceForgetSession)
 * 3. MCP silence watchdog (markMcpActivity + checkMcpSilence)
 *
 * Estos tests usan ExtensionServer directamente con TTLs cortos para que
 * la expiración ocurra en milisegundos, no minutos.
 */
describe('Session lifecycle — zombie detection', () => {
  let server: ExtensionServer;
  let port: number;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // TTLs cortos para tests.
    server = new ExtensionServer(0, 500, {
      groupTtlMs: 100,        // 100ms TTL
      sweepIntervalMs: 50,    // barrido cada 50ms
      mcpSilenceTtlMs: 100,   // 100ms silencio
    });
    await server.start();
    port = (server as any).wss.address().port;
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    await server.stop();
  });

  // ─── Solución 1: Heartbeat + TTL ────────────────────────────────────

  describe('Solución 1 — Heartbeat + TTL sweep', () => {
    it('un grupo sin heartbeat expira tras el TTL', () => {
      const sessionId = 'sess_test_zombie';
      const groupId = 9999;

      // Registrar grupo con heartbeat VIEJO (anterior al TTL).
      (server as any).sessionGroups.set(groupId, {
        sessionId,
        groupId,
        lastHeartbeat: Date.now() - 500, // hace 500ms >> TTL de 100ms
      });
      (server as any).tabToGroup.set(1234, groupId);

      expect(server.getSessionOverview().some(s => s.sessionId === sessionId)).toBe(true);

      // sweepDeadGroups elimina grupos cuyo heartbeat expiró.
      const cleaned = server.sweepDeadGroups();
      expect(cleaned).toBe(1);

      // El grupo y sus tabs desaparecen.
      expect((server as any).sessionGroups.has(groupId)).toBe(false);
      expect((server as any).tabToGroup.has(1234)).toBe(false);
    });

    it('un grupo con heartbeat fresco NO expira', () => {
      const sessionId = 'sess_test_alive';
      const groupId = 8888;

      (server as any).sessionGroups.set(groupId, {
        sessionId,
        groupId,
        lastHeartbeat: Date.now(),
      });

      server.recordHeartbeat(sessionId);
      const cleaned = server.sweepDeadGroups();
      expect(cleaned).toBe(0);
      expect((server as any).sessionGroups.has(groupId)).toBe(true);
    });

    it('refreshSessionHeartbeat actualiza el timestamp de grupos de la sesión', () => {
      const sessionId = 'sess_test_refresh';
      const groupId = 7777;
      const oldTime = Date.now() - 500; // hace 500ms

      (server as any).sessionGroups.set(groupId, {
        sessionId,
        groupId,
        lastHeartbeat: oldTime,
      });

      server.refreshSessionHeartbeat(sessionId);

      const entry = (server as any).sessionGroups.get(groupId);
      expect(entry.lastHeartbeat).toBeGreaterThan(oldTime);
    });
  });

  // ─── Solución 2: sessionList + sessionDestroy ───────────────────────

  describe('Solución 2 — sessionList + sessionDestroy', () => {
    it('getSessionOverview lista la broker-session aunque esté vacía', () => {
      const sessions = server.getSessionOverview();
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      const broker = sessions.find(s => s.isBroker);
      expect(broker).toBeDefined();
      expect(broker!.isBroker).toBe(true);
    });

    it('forceForheartbeat elimina grupos y tabs de una sesión', () => {
      const sessionId = 'sess_test_destroy';
      const groupId = 6666;

      (server as any).sessionGroups.set(groupId, {
        sessionId,
        groupId,
        lastHeartbeat: Date.now(),
      });
      (server as any).tabToGroup.set(5555, groupId);
      (server as any).tabToGroup.set(5556, groupId);

      const result = server.forceForgetSession(sessionId);
      expect(result).toBe(true);
      expect((server as any).sessionGroups.has(groupId)).toBe(false);
      expect((server as any).tabToGroup.has(5555)).toBe(false);
      expect((server as any).tabToGroup.has(5556)).toBe(false);
    });

    it('forceForgetSession devuelve false para sesión inexistente', () => {
      const result = server.forceForgetSession('sess_nonexistent');
      expect(result).toBe(false);
    });

    it('getSessionOverview muestra sesiones muertas como isAlive=false', () => {
      const sessionId = 'sess_dead';

      (server as any).sessionGroups.set(4444, {
        sessionId,
        groupId: 4444,
        lastHeartbeat: Date.now() - 9999,
      });

      const sessions = server.getSessionOverview();
      const dead = sessions.find(s => s.sessionId === sessionId);
      expect(dead).toBeDefined();
      expect(dead!.isAlive).toBe(false);
      expect(dead!.isBroker).toBe(false);
    });
  });

  // ─── Solución 3: MCP silence watchdog ───────────────────────────────

  describe('Solución 3 — MCP silence watchdog', () => {
    it('markMcpActivity refresca el timestamp de actividad', () => {
      const before = (server as any).mcpLastActivity;
      // Forzar paso del tiempo.
      (server as any).mcpLastActivity = Date.now() - 9999;
      server.markMcpActivity();
      const after = (server as any).mcpLastActivity;
      expect(after).toBeGreaterThan(before);
      expect((server as any).mcpWatchdogFired).toBe(false);
    });

    it('retains broker groups during prolonged reasoning without tool calls', () => {
      const brokerSessionId = (server as any).brokerSessionId;
      const groupId = 3333;

      (server as any).sessionGroups.set(groupId, {
        sessionId: brokerSessionId,
        groupId,
        lastHeartbeat: Date.now(),
      });

      // Simular silencio prolongado.
      (server as any).mcpLastActivity = Date.now() - 500;
      (server as any).mcpSilenceTtlMs = 100;

      // Invocar checkMcpSilence (método privado).
      (server as any).checkMcpSilence();

      expect((server as any).mcpWatchdogFired).toBe(true);
      expect((server as any).sessionGroups.has(groupId)).toBe(true);
    });

    it('checkMcpSilence NO se repite tras dispararse una vez', () => {
      (server as any).mcpLastActivity = Date.now() - 500;
      (server as any).mcpSilenceTtlMs = 100;
      (server as any).mcpWatchdogFired = true;

      // Si ya fired=true, no debe hacer nada aunque el silencio continúe.
      const before = (server as any).sessionGroups.size;
      (server as any).checkMcpSilence();
      expect((server as any).sessionGroups.size).toBe(before);
    });
  });

  // ─── Integración: cleanup al desconectar ────────────────────────────

  describe('Integración — cleanup en desconexión', () => {
    it('forgetSessionGroups limpia grupos de la broker-session', () => {
      const brokerSessionId = (server as any).brokerSessionId;

      (server as any).sessionGroups.set(2222, {
        sessionId: brokerSessionId,
        groupId: 2222,
        lastHeartbeat: Date.now(),
      });
      (server as any).sessionGroups.set(1111, {
        sessionId: 'sess_other',
        groupId: 1111,
        lastHeartbeat: Date.now(),
      });

      server.forceForgetSession(brokerSessionId);

      expect((server as any).sessionGroups.has(2222)).toBe(false);
      // La otra sesión se preserva.
      expect((server as any).sessionGroups.has(1111)).toBe(true);
    });
  });
});
