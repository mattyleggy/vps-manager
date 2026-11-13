'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Returns the raw { ok, data | error, ... } envelope. Errors thrown across the context
  // bridge lose their custom properties, so the renderer turns failures into exceptions itself.
  invoke: (channel, payload) => ipcRenderer.invoke('rpc', channel, payload),
  on(event, cb) {
    if (!['job', 'conn', 'review', 'chat', 'progress', 'activity', 'nginx-gen', 'term'].includes(event)) return;
    ipcRenderer.on(event, (_e, data) => cb(data));
  },
  /** Answer a review request: true runs the reviewed commands, anything else cancels. */
  reviewReply: (id, approved) => ipcRenderer.send('review:reply', id, approved === true),
  /** Keystrokes for the terminal panel (fire-and-forget: one IPC message per key press). */
  termWrite: (id, data) => ipcRenderer.send('term:write', id, String(data)),
});
