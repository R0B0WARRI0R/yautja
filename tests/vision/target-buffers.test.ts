import { describe, expect, it } from 'vitest';
import { AudioSensor } from '../../src/vision/audio.js';
import { ThermalSensor } from '../../src/vision/thermal.js';

function transport() {
  let tabId = 1;
  let generation = 'g1';
  const handlers = new Map<string, Function[]>();
  return {
    on: () => () => {}, send: async () => ({}),
    getCurrentTabId: () => tabId, getGeneration: () => generation,
    onAnyTab(method: string, handler: Function) {
      handlers.set(method, [...handlers.get(method) ?? [], handler]);
      return () => {};
    },
    select(id: number) { tabId = id; }, reconnect() { generation = 'g2'; },
    emit(id: number, method: string, params: any) {
      for (const handler of handlers.get(method) ?? []) handler(params, { tabId: id, generation, documentEpoch: 0 });
    },
  };
}
describe('buffers retain their source tab', () => {
  it('separates console events, deduplication and clear without selecting the tab', () => {
    const t = transport(); const sensor = new AudioSensor(t); sensor.subscribe();
    const event = { type: 'error', args: [{ type: 'string', value: 'same message' }] };
    t.emit(1, 'Runtime.consoleAPICalled', event);
    t.emit(2, 'Runtime.consoleAPICalled', event);
    t.emit(2, 'Runtime.consoleAPICalled', event);
    expect(sensor.readEntries({ tabId: 1 })[0].count).toBe(1);
    expect(sensor.readEntries({ tabId: 2 })[0].count).toBe(2);
    sensor.clear(2);
    expect(sensor.readEntries({ tabId: 1 })).toHaveLength(1);
    expect(sensor.readEntries({ tabId: 2 })).toHaveLength(0);
  });
  it('isolates identical request IDs and excludes the previous connection generation', () => {
    const t = transport(); const sensor = new ThermalSensor(t); sensor.subscribe();
    for (const id of [1, 2]) t.emit(id, 'Network.requestWillBeSent', { requestId: '1', request: { url: `https://fixture/${id}`, method: 'GET' }, timestamp: 1 });
    t.emit(2, 'Network.responseReceived', { requestId: '1', response: { status: 200 } });
    expect(sensor.readTransactions({ tabId: 1 })[0].response).toBeUndefined();
    expect(sensor.readTransactions({ tabId: 2 })[0].response?.status).toBe(200);
    t.select(2);
    expect(sensor.getTransactions()[0].request.url).toBe('https://fixture/2');
    t.reconnect();
    expect(sensor.getTransactions()).toEqual([]);
  });
});
