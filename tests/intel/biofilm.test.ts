import { describe, it, expect, beforeEach } from 'vitest';
import {
  BiofilmManager,
  type Transport,
  type BiofilmCell,
} from '../../src/intel/biofilm.js';

class MockTransport implements Transport {
  calls: { method: string; params?: Record<string, any> }[] = [];
  failMethods: Set<string> = new Set();
  noTarget = false;
  noSession = false;
  private nextTarget = 100;
  private nextSession = 1;

  async send(method: string, params?: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    if (this.failMethods.has(method)) throw new Error(`${method} failed`);
    if (method === 'Target.createTarget') {
      if (this.noTarget) return { result: {} };
      return { result: { targetId: String(this.nextTarget++) } };
    }
    if (method === 'Target.attachToTarget') {
      if (this.noSession) return { result: {} };
      return { result: { sessionId: `sess-${this.nextSession++}` } };
    }
    return {};
  }

  callsFor(method: string): { method: string; params?: Record<string, any> }[] {
    return this.calls.filter((c) => c.method === method);
  }
}

describe('BiofilmManager', () => {
  let transport: MockTransport;
  let manager: BiofilmManager;

  beforeEach(() => {
    transport = new MockTransport();
    manager = new BiofilmManager(transport);
  });

  describe('initialize', () => {
    it('creates the three default cells (primary, backup, interceptor)', async () => {
      const cells = await manager.initialize();
      expect(cells).toHaveLength(3);
      expect(cells.map((c) => c.role)).toEqual(['primary', 'backup', 'interceptor']);
      expect(manager.listCells()).toHaveLength(3);
    });

    it('initializes cells with sane defaults', async () => {
      const cells = await manager.initialize(['primary']);
      const cell = cells[0]!;
      expect(cell.status).toBe('active');
      expect(cell.hashCaptures).toBe(0);
      expect(cell.errorCount).toBe(0);
      expect(cell.id).toContain('primary');
      expect(typeof cell.createdAt).toBe('number');
      expect(typeof cell.lastSeenAt).toBe('number');
    });

    it('opens interceptor cells on about:blank and the rest on twitch', async () => {
      await manager.initialize();
      const created = transport.callsFor('Target.createTarget');
      expect(created).toHaveLength(3);
      expect(created[0]!.params!.url).toBe('https://www.twitch.tv');
      expect(created[1]!.params!.url).toBe('https://www.twitch.tv');
      expect(created[2]!.params!.url).toBe('about:blank');
    });

    it('attaches to each created target with flatten: true', async () => {
      await manager.initialize(['primary']);
      const attached = transport.callsFor('Target.attachToTarget');
      expect(attached).toHaveLength(1);
      // MockTransport assigns targetIds starting at 100
      expect(attached[0]!.params).toMatchObject({
        targetId: '100',
        flatten: true,
      });
    });

    it('supports a custom role list', async () => {
      const cells = await manager.initialize(['observer', 'validator']);
      expect(cells).toHaveLength(2);
      expect(cells.map((c) => c.role)).toEqual(['observer', 'validator']);
    });

    it('returns an empty list for an empty role list', async () => {
      const cells = await manager.initialize([]);
      expect(cells).toEqual([]);
      expect(transport.calls).toHaveLength(0);
    });

    it('skips a role when createTarget returns no targetId', async () => {
      transport.noTarget = true;
      const cells = await manager.initialize();
      expect(cells).toEqual([]);
      expect(manager.listCells()).toHaveLength(0);
    });

    it('skips a role when attachToTarget returns no sessionId', async () => {
      transport.noSession = true;
      const cells = await manager.initialize();
      expect(cells).toEqual([]);
      expect(manager.listCells()).toHaveLength(0);
    });

    it('swallows transport errors and continues with remaining roles', async () => {
      let callCount = 0;
      const flaky: Transport = {
        async send(method: string, params?: Record<string, any>): Promise<any> {
          if (method === 'Target.createTarget') {
            callCount++;
            if (callCount === 1) throw new Error('boom');
            return { result: { targetId: String(200 + callCount) } };
          }
          if (method === 'Target.attachToTarget') {
            return { result: { sessionId: 'sess-x' } };
          }
          return {};
        },
      };
      const m = new BiofilmManager(flaky);
      const cells = await m.initialize();
      expect(cells).toHaveLength(2);
      expect(cells.map((c) => c.role)).toEqual(['backup', 'interceptor']);
    });

    it('accumulates cells across multiple initialize calls', async () => {
      await manager.initialize(['primary']);
      await manager.initialize(['observer']);
      expect(manager.listCells()).toHaveLength(2);
    });
  });

  describe('getState', () => {
    it('reports quorum threshold 2 and zero rotations by default', async () => {
      await manager.initialize(['primary']);
      const state = manager.getState();
      expect(state.quorumThreshold).toBe(2);
      expect(state.rotationsDetected).toBe(0);
      expect(state.cells).toHaveLength(1);
      expect(typeof state.lastSyncAt).toBe('number');
    });

    it('setQuorumThreshold is reflected in getState', () => {
      manager.setQuorumThreshold(3);
      expect(manager.getState().quorumThreshold).toBe(3);
    });
  });

  describe('quorum', () => {
    it('is not confirmed below the threshold', () => {
      manager.recordObservation('hash:Op', 'cell-1');
      expect(manager.isQuorumConfirmed('hash:Op')).toBe(false);
    });

    it('is confirmed once enough distinct cells observe the same data point', () => {
      manager.recordObservation('hash:Op', 'cell-1');
      manager.recordObservation('hash:Op', 'cell-2');
      expect(manager.isQuorumConfirmed('hash:Op')).toBe(true);
    });

    it('does not count the same cell twice', () => {
      manager.recordObservation('hash:Op', 'cell-1');
      manager.recordObservation('hash:Op', 'cell-1');
      expect(manager.isQuorumConfirmed('hash:Op')).toBe(false);
    });

    it('tracks data points independently', () => {
      manager.recordObservation('hash:OpA', 'cell-1');
      manager.recordObservation('hash:OpB', 'cell-2');
      expect(manager.isQuorumConfirmed('hash:OpA')).toBe(false);
      expect(manager.isQuorumConfirmed('hash:OpB')).toBe(false);
      manager.recordObservation('hash:OpA', 'cell-2');
      expect(manager.isQuorumConfirmed('hash:OpA')).toBe(true);
    });

    it('respects a custom quorum threshold', () => {
      manager.setQuorumThreshold(1);
      manager.recordObservation('hash:Op', 'cell-1');
      expect(manager.isQuorumConfirmed('hash:Op')).toBe(true);
    });

    it('is not confirmed for an unknown data point', () => {
      expect(manager.isQuorumConfirmed('nope')).toBe(false);
    });

    it('clearObservations resets quorum state', () => {
      manager.recordObservation('hash:Op', 'cell-1');
      manager.recordObservation('hash:Op', 'cell-2');
      expect(manager.isQuorumConfirmed('hash:Op')).toBe(true);
      manager.clearObservations();
      expect(manager.isQuorumConfirmed('hash:Op')).toBe(false);
    });
  });

  describe('terminate', () => {
    it('closes every cell target and clears the cell list', async () => {
      const cells = await manager.initialize();
      await manager.terminate();
      const closed = transport.callsFor('Target.closeTarget');
      expect(closed).toHaveLength(3);
      const closedIds = closed.map((c) => c.params!.targetId).sort();
      const expected = cells.map((c: BiofilmCell) => String(c.tabId)).sort();
      expect(closedIds).toEqual(expected);
      expect(manager.listCells()).toHaveLength(0);
    });

    it('works when there are no cells', async () => {
      await manager.terminate();
      expect(transport.callsFor('Target.closeTarget')).toHaveLength(0);
      expect(manager.listCells()).toHaveLength(0);
    });

    it('swallows closeTarget errors and still clears the cells', async () => {
      await manager.initialize(['primary', 'backup']);
      transport.failMethods.add('Target.closeTarget');
      await manager.terminate();
      expect(manager.listCells()).toHaveLength(0);
    });
  });
});
