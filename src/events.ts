import { EventEmitter } from 'node:events';

// Global event bus: 'state' (topology/status changed), 'log' ({key, line}), 'audit' (entry)
export const bus = new EventEmitter();
bus.setMaxListeners(100);
