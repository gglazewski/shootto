// Notice.js — tiny structured message channel (info/warn/error).
//
// A lightweight global pub/sub so engine errors surface to the UI without
// modules calling into the DOM directly. Messages with no subscriber are
// dropped; the App subscribes at construction.

const listeners = new Set();

/**
 * Subscribe to notices. @returns {() => void} unsubscribe
 */
export function onNotice(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function publish(level, message, detail) {
  const notice = { level, message, detail };
  if (listeners.size === 0) return notice;
  for (const cb of [...listeners]) cb(notice);
  return notice;
}

export const Notice = {
  info: (message, detail) => publish('info', message, detail),
  warn: (message, detail) => publish('warn', message, detail),
  error: (message, detail) => publish('error', message, detail),
};
