'use strict';

/*
 * Folderlink: keep a folder the same on two computers, browser to browser.
 *
 * Connection: PeerJS introduces the two browsers. After that, everything runs
 * on one ordered, reliable WebRTC data channel. Text frames are JSON control
 * messages. Binary frames are a 4-byte request id followed by file bytes.
 *
 * Access: the broker only sees a hash of the share code. Each side then proves
 * it knows the code with an HMAC, so nothing is served until both sides pass.
 *
 * Sync: the joining computer runs the merge and the sharing computer answers
 * requests. The joiner remembers what both folders looked like after the last
 * sync (the baseline). Comparing each side with its own baseline shows what
 * changed there, so the two computers' clocks never need to agree, and a file
 * deleted on one side can be told apart from a file created on the other.
 */

const CFG = window.FOLDERLINK_CONFIG || {};
const ICE_SERVERS = CFG.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];

const FRAME = 60 * 1024;           // Bytes of file data per message
const READ_SIZE = 4 * 1024 * 1024; // Bytes read from disk at a time
const BUFFER_HIGH = 8 * 1024 * 1024;
const BUFFER_LOW = 2 * 1024 * 1024;
const WINDOW = 32 * 1024 * 1024;   // Max bytes sent ahead of what the receiver has stored
const ACK_EVERY = 4 * 1024 * 1024;
const LIST_BATCH = 200;
const PREVIEW_MAX = 1024 * 1024 * 1024;
const TEXT_PREVIEW_MAX = 1024 * 1024;
const SYNC_INTERVAL = 15000;
const BASELINE_SAVE_EVERY = 5000;
const CONNECT_TIMEOUT = 20000;
const BULK_DELETE_MIN = 10;        // Pause for confirmation above this many deletions...
const BULK_DELETE_SHARE = 0.3;     // ...if they're also this share of all synced files
const TRASH = '.folderlink-trash';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

/* ---------- Small helpers ---------- */

function show(view) {
  for (const id of ['home', 'host', 'choose', 'client', 'lost']) $(id).hidden = id !== view;
}

function setStatus(text, kind) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'pill' + (kind ? ' ' + kind : '');
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function formatSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
}

function formatDate(ms) {
  return ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function extension(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ---------- Folder access ---------- */

/* Paths always come from the other computer, so check every part of them. */
function splitPath(path) {
  if (typeof path !== 'string') throw new Error('Invalid path');
  const parts = path.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '.' || p === '..' || p.includes('\\') || p.includes('\0')) throw new Error('Invalid path');
  }
  return parts;
}

/* System files, and files that only exist while another program is writing. */
function isIgnored(name) {
  return name === TRASH || name === 'desktop.ini' || name === 'Thumbs.db' || name === '.DS_Store'
    || name.startsWith('~$') || name.endsWith('.crswap') || name.endsWith('.crdownload');
}

function syncablePath(path) {
  const parts = splitPath(path);
  if (!parts.length || parts.some(isIgnored)) throw new Error('Invalid path');
  return parts;
}

async function dirAt(root, parts, create) {
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: !!create });
  return dir;
}

async function fileAt(root, path, create) {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) throw new Error('Invalid path');
  const dir = await dirAt(root, parts, create);
  return dir.getFileHandle(name, { create: !!create });
}

async function removeEntry(root, path) {
  const parts = splitPath(path);
  const name = parts.pop();
  await (await dirAt(root, parts)).removeEntry(name);
}

async function removeQuietly(root, path) {
  try { await removeEntry(root, path); } catch { /* Nothing to clean up */ }
}

/* Removes a folder only if it's empty. Files are always handled one at a time. */
async function removeEmptyDir(root, path) {
  try {
    await removeEntry(root, path);
  } catch (err) {
    if (err.name !== 'NotFoundError' && err.name !== 'InvalidModificationError') throw err;
  }
}

async function copyInto(handle, file) {
  const writable = await handle.createWritable();
  try {
    await writable.write(file);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

/* Browsers can't reach the Recycle Bin, so deleted files move to a folder inside the share. */
async function trashFile(root, path) {
  const parts = splitPath(path);
  const file = await (await fileAt(root, path)).getFile();
  const dest = await fileAt(root, [TRASH, timestamp(), ...parts].join('/'), true);
  await copyInto(dest, file);
  await removeEntry(root, path);
}

/* Confirms a file is still as expected, so a late edit never gets overwritten. */
async function matches(root, path, expect) {
  let file = null;
  try {
    file = await (await fileAt(root, path)).getFile();
  } catch (err) {
    if (err.name !== 'NotFoundError') throw err;
  }
  if (!expect) return !file;
  return !!file && file.size === expect.size && file.lastModified === expect.mtime;
}

/* Hashes in blocks so that large files never have to fit in memory. */
async function hashFile(file) {
  const digests = [];
  for (let at = 0; at < file.size; at += READ_SIZE) {
    const block = await file.slice(at, at + READ_SIZE).arrayBuffer();
    digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', block)));
  }
  const all = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => all.set(d, i * 32));
  return toHex(await crypto.subtle.digest('SHA-256', all));
}

/*
 * Lists a whole folder. A file or folder that can't be read is reported as
 * locked or unreadable instead of being left out. Leaving it out would look
 * like a deletion and the sync would remove it from the other computer.
 */
async function* walkFolder(dir, prefix) {
  for await (const [name, handle] of dir.entries()) {
    if (isIgnored(name)) continue;
    const path = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'directory') {
      yield { path, dir: true };
      try {
        yield* walkFolder(handle, path);
      } catch {
        yield { path, dir: true, unreadable: true };
      }
    } else {
      try {
        const f = await handle.getFile();
        yield { path, size: f.size, mtime: f.lastModified };
      } catch {
        yield { path, locked: true };
      }
    }
  }
}

/* ---------- Share codes and proof of knowledge ---------- */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 20 x 5 bits = 100 bits
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  return chars.match(/.{4}/g).join('-');
}

function normalizeCode(text) {
  return text.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
}

function isValidCode(normalized) {
  return normalized.length === 20 && [...normalized].every((c) => ALPHABET.includes(c));
}

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function peerIdFor(code) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode('folderlink-id:' + normalizeCode(code)));
  return 'fl-' + toHex(digest).slice(0, 40);
}

async function proof(code, role, hostNonce, clientNonce) {
  const key = await crypto.subtle.importKey('raw', enc.encode(normalizeCode(code)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${role}:${hostNonce}:${clientNonce}`)));
}

const newNonce = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

function sameText(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------- Connection helpers ---------- */

function createPeer(id) {
  const options = { ...(CFG.peer || {}), config: { iceServers: ICE_SERVERS }, debug: 1 };
  return id ? new Peer(id, options) : new Peer(options);
}

function sendJson(dc, msg) {
  if (dc.readyState !== 'open') throw new Error('Connection closed');
  dc.send(JSON.stringify(msg));
}

async function drain(dc) {
  while (dc.bufferedAmount >= BUFFER_HIGH) {
    if (dc.readyState !== 'open') throw new Error('Connection closed');
    await new Promise((resolve) => {
      const done = () => {
        dc.removeEventListener('bufferedamountlow', done);
        dc.removeEventListener('close', done);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', done);
      dc.addEventListener('close', done);
    });
  }
}

/* Sends a file as binary frames, staying within what the receiver has acknowledged. */
async function pumpFile(dc, id, file, ctl, onProgress) {
  let sent = 0;
  while (sent < file.size) {
    const block = new Uint8Array(await file.slice(sent, sent + READ_SIZE).arrayBuffer());
    if (!block.length) throw new DOMException('File changed', 'NotReadableError');
    for (let i = 0; i < block.length; i += FRAME) {
      while (sent - ctl.acked >= WINDOW && !ctl.cancelled) {
        await new Promise((resolve) => { ctl.wake = resolve; });
        ctl.wake = null;
      }
      if (ctl.cancelled) return false;
      await drain(dc);
      const part = block.subarray(i, i + FRAME);
      const frame = new Uint8Array(4 + part.length);
      new DataView(frame.buffer).setUint32(0, id);
      frame.set(part, 4);
      dc.send(frame);
      sent += part.length;
      onProgress?.(sent);
    }
  }
  return !ctl.cancelled;
}

function splitFrame(data) {
  const bytes = new Uint8Array(data);
  return { id: new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0), chunk: bytes.subarray(4) };
}

/* Reports whether traffic is going directly over the network or via a relay. */
async function routeOf(conn) {
  try {
    const stats = await conn.peerConnection.getStats();
    let pair;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return 'unknown';
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (!local || !remote) return 'unknown';
    if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay';
    return local.candidateType === 'host' && remote.candidateType === 'host' ? 'local' : 'internet';
  } catch {
    return 'unknown';
  }
}

const ROUTE_TEXT = {
  local: 'Connected directly on your network',
  internet: 'Connected directly over the internet',
  relay: 'Connected through a relay server',
  unknown: 'Connected',
};

/* ---------- Saved state ---------- */

function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('folderlink', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeOp(mode, run) {
  try {
    const db = await openStore();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = run(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined;
  }
}

const load = (key) => storeOp('readonly', (s) => s.get(key));
const save = (key, value) => storeOp('readwrite', (s) => s.put(value, key));
const forget = (key) => storeOp('readwrite', (s) => s.delete(key));

/* ---------- Sharing side ---------- */

const host = { root: null, code: '', peer: null, clients: new Set(), wakeLock: null, retries: 0 };

async function startHost(root, code) {
  host.root = root;
  host.code = code;
  host.retries = 0;
  $('host-folder').textContent = root.name;
  $('host-code').textContent = code;
  renderClients();
  show('host');
  setStatus('Connecting…');
  await save('share', { handle: root, code });
  await openHostPeer();
  try { host.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Optional */ }
}

async function openHostPeer() {
  const peer = createPeer(await peerIdFor(host.code));
  host.peer = peer;
  peer.on('open', () => { host.retries = 0; setStatus('Ready for connections', 'ok'); });
  peer.on('connection', acceptClient);
  peer.on('disconnected', () => {
    if (host.peer !== peer || peer.destroyed) return;
    setStatus('Reconnecting…', 'bad');
    setTimeout(() => { if (host.peer === peer && !peer.destroyed) peer.reconnect(); }, 3000);
  });
  peer.on('error', (err) => {
    if (host.peer !== peer) return;
    // After a reload, the broker can hold the old session for a short while.
    if (err.type === 'unavailable-id' && host.retries < 12) {
      host.retries++;
      setStatus('Waiting for the previous session to end…', 'bad');
      peer.destroy();
      setTimeout(() => { if (host.peer === peer) openHostPeer(); }, 5000);
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      setStatus('Can’t reach the connection service. Retrying…', 'bad');
    } else if (err.type === 'unavailable-id') {
      setStatus('This share code is already in use in another tab.', 'bad');
    }
  });
}

async function stopHost() {
  const peer = host.peer;
  host.peer = null;
  peer?.destroy();
  host.clients.clear();
  host.root = null;
  host.wakeLock?.release?.();
  host.wakeLock = null;
  await forget('share');
  setStatus('');
  location.href = './';
}

function renderClients() {
  const list = $('host-clients');
  list.textContent = '';
  for (const c of host.clients) {
    const li = document.createElement('li');
    li.textContent = `Computer ${c.number}: ${ROUTE_TEXT[c.route].toLowerCase()}`;
    list.append(li);
  }
  $('host-none').hidden = host.clients.size > 0;
}

function logActivity(text) {
  const list = $('host-activity');
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString([], { timeStyle: 'short' })}  ${text}`;
  list.prepend(li);
  while (list.children.length > 30) list.lastChild.remove();
  $('host-idle').hidden = true;
}

let clientCounter = 0;

function acceptClient(conn) {
  const c = {
    conn, dc: null, authed: false, hostNonce: newNonce(), reads: new Map(), puts: new Map(),
    number: ++clientCounter, route: 'unknown',
  };
  const dropTimer = setTimeout(() => { if (!c.authed) conn.close(); }, CONNECT_TIMEOUT);

  conn.on('open', () => {
    c.dc = conn.dataChannel;
    c.dc.bufferedAmountLowThreshold = BUFFER_LOW;
    sendJson(c.dc, { t: 'hello', nonce: c.hostNonce });
  });
  conn.on('data', (data) => {
    if (typeof data !== 'string') {
      if (c.authed) receivePutFrame(c, data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    onClientMessage(c, msg).catch((err) => {
      if (c.authed && c.dc.readyState === 'open') sendJson(c.dc, { t: 'error', id: msg.id, message: describeError(err), code: err.code });
    });
  });
  const gone = () => {
    clearTimeout(dropTimer);
    for (const read of c.reads.values()) { read.cancelled = true; read.wake?.(); }
    for (const id of [...c.puts.keys()]) abandonPut(c, id);
    if (host.clients.delete(c)) renderClients();
  };
  conn.on('close', gone);
  conn.on('error', gone);
}

function changedError() {
  const err = new Error('This file changed while syncing.');
  err.code = 'changed';
  return err;
}

async function onClientMessage(c, msg) {
  if (!c.authed) {
    if (msg.t !== 'auth' || typeof msg.nonce !== 'string') return;
    const expected = await proof(host.code, 'client', c.hostNonce, msg.nonce);
    if (!sameText(msg.mac, expected)) {
      sendJson(c.dc, { t: 'denied' });
      setTimeout(() => c.conn.close(), 500);
      return;
    }
    c.authed = true;
    host.clients.add(c);
    sendJson(c.dc, { t: 'welcome', mac: await proof(host.code, 'host', c.hostNonce, msg.nonce), name: host.root.name });
    renderClients();
    c.route = await routeOf(c.conn);
    renderClients();
    return;
  }

  const id = msg.id >>> 0;
  const result = (data) => sendJson(c.dc, { t: 'result', id, ...data });

  switch (msg.t) {
    case 'walk': return replyEntries(c, id);
    case 'read': return serveFile(c, id, msg);
    case 'hash': {
      const file = await (await fileAt(host.root, msg.path)).getFile();
      return result({ hash: await hashFile(file) });
    }
    case 'mkdir':
      await dirAt(host.root, syncablePath(msg.path), true);
      return result({});
    case 'rmdir':
      await removeEmptyDir(host.root, syncablePath(msg.path).join('/'));
      return result({});
    case 'trash':
      syncablePath(msg.path);
      if (!await matches(host.root, msg.path, msg.expect)) throw changedError();
      await trashFile(host.root, msg.path);
      logActivity(`Computer ${c.number} deleted ${msg.path}`);
      return result({});
    case 'put': return beginPut(c, id, msg);
    case 'end': return finishPut(c, id);
    case 'ack': {
      const read = c.reads.get(id);
      if (read) { read.acked = Math.max(read.acked, Number(msg.bytes) || 0); read.wake?.(); }
      return;
    }
    case 'cancel': {
      const read = c.reads.get(id);
      if (read) { read.cancelled = true; read.wake?.(); }
      return abandonPut(c, id);
    }
  }
}

async function replyEntries(c, id) {
  let batch = [];
  for await (const entry of walkFolder(host.root, '')) {
    batch.push(entry);
    if (batch.length >= LIST_BATCH) {
      await drain(c.dc);
      sendJson(c.dc, { t: 'entries', id, entries: batch });
      batch = [];
    }
  }
  sendJson(c.dc, { t: 'entries', id, entries: batch, done: true });
}

function describeError(err) {
  if (err?.name === 'NotFoundError') return 'This item no longer exists.';
  if (err?.name === 'NotReadableError') return 'This file changed or is locked by another program.';
  if (err?.name === 'NoModificationAllowedError') return 'This file is open in another program.';
  if (err?.name === 'NotAllowedError') return 'The browser no longer has permission for this folder.';
  if (err?.name === 'QuotaExceededError') return 'The disk is full.';
  return err?.message || 'Something went wrong on the sharing computer.';
}

async function serveFile(c, id, msg) {
  const read = { acked: 0, cancelled: false, wake: null };
  c.reads.set(id, read);
  try {
    const file = await (await fileAt(host.root, msg.path)).getFile();
    sendJson(c.dc, { t: 'meta', id, size: file.size, mtime: file.lastModified });
    if (await pumpFile(c.dc, id, file, read)) sendJson(c.dc, { t: 'end', id });
  } finally {
    c.reads.delete(id);
  }
}

async function beginPut(c, id, msg) {
  syncablePath(msg.path);
  if (!await matches(host.root, msg.path, msg.expect || null)) throw changedError();
  const handle = await fileAt(host.root, msg.path, true);
  const writable = await handle.createWritable();
  c.puts.set(id, { writable, path: msg.path, isNew: !msg.expect, queue: Promise.resolve(), stored: 0, acked: 0, failed: null });
  sendJson(c.dc, { t: 'ready', id });
}

function receivePutFrame(c, data) {
  const { id, chunk } = splitFrame(data);
  const put = c.puts.get(id);
  if (!put) return;
  put.queue = put.queue.then(async () => {
    if (put.failed) return;
    await put.writable.write(chunk);
    put.stored += chunk.length;
    if (put.stored - put.acked >= ACK_EVERY) {
      put.acked = put.stored;
      sendJson(c.dc, { t: 'ack', id, bytes: put.stored });
    }
  }).catch((err) => { put.failed = err; });
}

async function finishPut(c, id) {
  const put = c.puts.get(id);
  if (!put) return;
  await put.queue;
  if (put.failed) {
    const err = put.failed;
    await abandonPut(c, id);
    throw err;
  }
  c.puts.delete(id);
  await put.writable.close();
  const file = await (await fileAt(host.root, put.path)).getFile();
  sendJson(c.dc, { t: 'result', id, size: file.size, mtime: file.lastModified });
  logActivity(`Computer ${c.number} sent ${put.path}`);
}

async function abandonPut(c, id) {
  const put = c.puts.get(id);
  if (!put) return;
  c.puts.delete(id);
  await put.writable.abort().catch(() => {});
  if (put.isNew) await removeQuietly(host.root, put.path); // Don't leave an empty placeholder behind
}

/* ---------- Joining side: connection ---------- */

const client = {
  code: '', peer: null, conn: null, dc: null, nextId: 1, requests: new Map(), name: '', ready: false,
};

function connect(code) {
  return new Promise((resolve, reject) => {
    const failed = (message) => {
      clearTimeout(timer);
      if (client.peer === peer) { client.peer = null; peer.destroy(); }
      reject(new Error(message));
    };
    const timer = setTimeout(() => failed(
      'The computers couldn’t reach each other. Check that both are on the same network and that it isn’t a guest network.'
    ), CONNECT_TIMEOUT);

    client.peer?.destroy();
    const peer = createPeer();
    client.peer = peer;
    client.code = code;

    peer.on('error', (err) => {
      if (client.peer !== peer || client.ready) return;
      if (err.type === 'peer-unavailable') failed('No share is running with that code. Check the code, and check the sharing tab is still open.');
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') failed('Can’t reach the connection service. Check your internet connection.');
      else failed('The connection failed. Try again.');
    });

    peer.on('open', async () => {
      const conn = peer.connect(await peerIdFor(code), { serialization: 'raw', reliable: true });
      client.conn = conn;
      let clientNonce;
      let hostNonce;

      conn.on('data', async (data) => {
        if (typeof data !== 'string') return onBinary(data);
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (client.ready) return onHostMessage(msg);

        if (msg.t === 'hello') {
          client.dc = conn.dataChannel;
          client.dc.bufferedAmountLowThreshold = BUFFER_LOW;
          hostNonce = msg.nonce;
          clientNonce = newNonce();
          sendJson(client.dc, { t: 'auth', nonce: clientNonce, mac: await proof(code, 'client', hostNonce, clientNonce) });
        } else if (msg.t === 'denied') {
          failed('That share code was not accepted.');
        } else if (msg.t === 'welcome') {
          if (!sameText(msg.mac, await proof(code, 'host', hostNonce, clientNonce))) {
            failed('The other computer could not prove it holds this share code.');
            return;
          }
          clearTimeout(timer);
          client.ready = true;
          client.name = String(msg.name || 'Shared folder');
          resolve();
        }
      });
      const lost = () => { if (client.conn === conn) onHostLost(); };
      conn.on('close', lost);
      conn.on('error', lost);
    });
  });
}

function onHostLost() {
  if (!client.ready) return;
  client.ready = false;
  clearTimeout(sync.timer);
  for (const req of client.requests.values()) {
    if (req.ctl) { req.ctl.cancelled = true; req.ctl.wake?.(); }
    req.reject(new Error('The connection was lost.'));
  }
  client.requests.clear();
  $('lost-text').textContent = `${client.name} is no longer reachable. The sharing tab may have closed, or a computer may have gone to sleep. Nothing is lost. Syncing picks up where it left off.`;
  setStatus('Disconnected', 'bad');
  show('lost');
}

function onHostMessage(msg) {
  const req = client.requests.get(msg.id);
  if (!req) return;
  if (msg.t === 'entries') {
    req.entries.push(...msg.entries);
    if (msg.done) settle(msg.id, () => req.resolve(req.entries));
  } else if (msg.t === 'meta') {
    req.size = msg.size;
    req.mtime = msg.mtime;
  } else if (msg.t === 'end') {
    req.queue = req.queue.then(() => settle(msg.id, () => req.resolve({ mtime: req.mtime, size: req.size })));
  } else if (msg.t === 'result') {
    settle(msg.id, () => req.resolve(msg));
  } else if (msg.t === 'ready') {
    req.onReady?.();
  } else if (msg.t === 'ack') {
    req.ctl.acked = Math.max(req.ctl.acked, msg.bytes);
    req.ctl.wake?.();
  } else if (msg.t === 'error') {
    const err = new Error(msg.message);
    err.code = msg.code;
    settle(msg.id, () => req.reject(err));
  }
}

function settle(id, finish) {
  if (client.requests.delete(id)) finish();
}

function onBinary(data) {
  const { id, chunk } = splitFrame(data);
  const req = client.requests.get(id);
  if (!req) return;
  req.queue = req.queue.then(async () => {
    if (!client.requests.has(id)) return;
    await req.sink(chunk);
    req.stored += chunk.length;
    req.onProgress?.(req.stored);
    if (req.stored - req.acked >= ACK_EVERY) {
      req.acked = req.stored;
      sendJson(client.dc, { t: 'ack', id, bytes: req.stored });
    }
  }).catch((err) => {
    try { sendJson(client.dc, { t: 'cancel', id }); } catch { /* Already closed */ }
    settle(id, () => req.reject(err));
  });
}

function ask(msg, extra) {
  return new Promise((resolve, reject) => {
    const id = client.nextId++;
    client.requests.set(id, { resolve, reject, ...extra });
    sendJson(client.dc, { ...msg, id });
  });
}

/* Streams one file from the sharing computer into sink(chunk). */
function fetchFile(path, sink, onProgress) {
  const id = client.nextId;
  const promise = ask({ t: 'read', path }, { sink, onProgress, queue: Promise.resolve(), stored: 0, acked: 0, size: 0, mtime: 0 });
  const cancel = () => {
    const req = client.requests.get(id);
    if (!req) return;
    client.requests.delete(id);
    try { sendJson(client.dc, { t: 'cancel', id }); } catch { /* Already closed */ }
    const err = new Error('Cancelled');
    err.name = 'AbortError';
    req.reject(err);
  };
  return { promise, cancel };
}

/* ---------- Joining side: working out what to do ---------- */

const statOf = (item) => ({ size: item.size, mtime: item.mtime });

function changedSince(item, size, mtime) {
  return !item || item.size !== size || item.mtime !== mtime;
}

/*
 * Compares both folders with the baseline and lists what has to happen.
 * Nothing here touches a disk. Rules:
 *  - Changed on one side only: the change wins.
 *  - Deleted on one side and untouched on the other: delete it there too.
 *  - Deleted on one side but edited on the other: the edit wins and is restored.
 *  - Changed on both sides, or different on first sync: keep both versions.
 *  - Anything locked or unreadable is left for a later pass.
 */
function planSync(local, remote, baseline) {
  const ops = [];
  const blocked = [];
  for (const side of [local, remote]) {
    for (const item of side.values()) if (item.unreadable) blocked.push(item.path);
  }
  const isBlocked = (path) => blocked.some((b) => path === b || path.startsWith(b + '/'));

  for (const path of new Set([...local.keys(), ...remote.keys(), ...baseline.keys()])) {
    const l = local.get(path);
    const r = remote.get(path);
    const b = baseline.get(path);
    if (isBlocked(path) || l?.locked || r?.locked) continue;

    if (!l && !r) {
      ops.push({ op: 'forget', path });
    } else if ((l && r && !!l.dir !== !!r.dir)) {
      ops.push({ op: 'clash', path });
    } else if (l?.dir || r?.dir) {
      if (l && r) { if (!b) ops.push({ op: 'recordDir', path }); }
      else if (l) ops.push({ op: b ? 'rmdirLocal' : 'mkdirRemote', path });
      else ops.push({ op: b ? 'rmdirRemote' : 'mkdirLocal', path });
    } else {
      const lChanged = !b || changedSince(l, b.ls, b.lm);
      const rChanged = !b || changedSince(r, b.rs, b.rm);
      if (l && r) {
        if (!lChanged && !rChanged) continue;
        if (b && !rChanged) ops.push({ op: 'push', path, l, r });
        else if (b && !lChanged) ops.push({ op: 'pull', path, l, r });
        else if (l.size === r.size) ops.push({ op: 'compare', path, l, r });
        else if (!b && l.size === 0) ops.push({ op: 'pull', path, l, r });
        else if (!b && r.size === 0) ops.push({ op: 'push', path, l, r });
        else ops.push({ op: 'conflict', path, l, r });
      } else if (l) {
        ops.push(b && !lChanged ? { op: 'trashLocal', path, l } : { op: 'push', path, l });
      } else {
        ops.push(b && !rChanged ? { op: 'trashRemote', path, r } : { op: 'pull', path, r });
      }
    }
  }
  return ops;
}

const isDelete = (op) => op.op === 'trashLocal' || op.op === 'trashRemote';
const isTransfer = (op) => op.op === 'pull' || op.op === 'push' || op.op === 'conflict';

/* ---------- Joining side: running a sync ---------- */

const sync = {
  root: null, key: '', baseline: new Map(), local: new Map(), remote: new Map(), states: new Map(),
  busy: false, paused: false, confirmed: false, allowDeletes: false, held: [], priority: null,
  timer: null, pendingOps: null, dirty: false, savedAt: 0, lastChecked: 0,
};

function syncText(title, detail) {
  $('sync-title').textContent = title;
  $('sync-detail').textContent = detail || '';
}

function syncError(text) {
  const list = $('sync-errors');
  list.hidden = false;
  const li = document.createElement('li');
  li.textContent = text;
  list.append(li);
  while (list.children.length > 50) list.firstChild.remove();
}

function clearSyncErrors() {
  $('sync-errors').hidden = true;
  $('sync-errors').textContent = '';
}

async function saveBaseline(force) {
  if (!sync.dirty || (!force && Date.now() - sync.savedAt < BASELINE_SAVE_EVERY)) return;
  sync.dirty = false;
  sync.savedAt = Date.now();
  await save('base:' + sync.key, Object.fromEntries(sync.baseline));
}

function setBaseline(path, value) {
  if (value) sync.baseline.set(path, value);
  else sync.baseline.delete(path);
  sync.dirty = true;
}

function recordFile(path, localFile, remoteStat) {
  setBaseline(path, { ls: localFile.size, lm: localFile.lastModified, rs: remoteStat.size, rm: remoteStat.mtime });
  const l = { path, size: localFile.size, mtime: localFile.lastModified };
  sync.local.set(path, l);
  sync.remote.set(path, { path, ...remoteStat });
}

async function pull(op) {
  const { path, l } = op;
  const handle = await fileAt(sync.root, path, true);
  // A new file starts as an empty placeholder, so that's what to expect at the end.
  const before = await handle.getFile();
  const expected = l ? statOf(l) : { size: before.size, mtime: before.lastModified };
  const writable = await handle.createWritable();
  try {
    const stat = await fetchFile(path, (chunk) => writable.write(chunk), op.onProgress).promise;
    if (!await matches(sync.root, path, expected)) throw changedError();
    await writable.close();
    recordFile(path, await handle.getFile(), stat);
  } catch (err) {
    await writable.abort().catch(() => {});
    if (!l) await removeQuietly(sync.root, path); // Don't leave an empty placeholder behind
    throw err;
  }
}

async function push(op) {
  const { path, l, r } = op;
  const file = await (await fileAt(sync.root, path)).getFile();
  if (file.size !== l.size || file.lastModified !== l.mtime) throw changedError();

  const ctl = { acked: 0, cancelled: false, wake: null };
  const id = client.nextId;
  let onReady;
  const ready = new Promise((resolve) => { onReady = resolve; });
  const done = ask({ t: 'put', path, size: file.size, expect: r ? statOf(r) : null }, { ctl, onReady });
  done.catch(() => { ctl.cancelled = true; ctl.wake?.(); });

  await Promise.race([ready, done]);
  if (await pumpFile(client.dc, id, file, ctl, op.onProgress)) sendJson(client.dc, { t: 'end', id });
  const stat = await done;
  recordFile(path, file, { size: stat.size, mtime: stat.mtime });
}

async function compare(op) {
  const local = await (await fileAt(sync.root, op.path)).getFile();
  const [mine, theirs] = await Promise.all([hashFile(local), ask({ t: 'hash', path: op.path })]);
  if (mine === theirs.hash) recordFile(op.path, local, statOf(op.r));
  else await keepBoth(op);
}

function conflictName(path) {
  const parts = splitPath(path);
  const name = parts.pop();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return [...parts, `${stem} (conflict ${timestamp()})${ext}`].join('/');
}

/* The local version is saved under a new name, which then syncs like any new file. */
async function keepBoth(op) {
  const file = await (await fileAt(sync.root, op.path)).getFile();
  await copyInto(await fileAt(sync.root, conflictName(op.path), true), file);
  const fresh = await (await fileAt(sync.root, op.path)).getFile();
  await pull({ ...op, l: { size: fresh.size, mtime: fresh.lastModified } });
  sync.conflicts++;
}

async function runOp(op) {
  sync.states.set(op.path, 'active');
  switch (op.op) {
    case 'forget': setBaseline(op.path, null); break;
    case 'clash': throw new Error('This is a file on one computer and a folder on the other. Rename one of them.');
    case 'recordDir': setBaseline(op.path, { dir: true }); break;
    case 'mkdirLocal':
      await dirAt(sync.root, splitPath(op.path), true);
      setBaseline(op.path, { dir: true });
      sync.local.set(op.path, { path: op.path, dir: true });
      break;
    case 'mkdirRemote':
      await ask({ t: 'mkdir', path: op.path });
      setBaseline(op.path, { dir: true });
      sync.remote.set(op.path, { path: op.path, dir: true });
      break;
    case 'rmdirLocal':
      await removeEmptyDir(sync.root, op.path);
      setBaseline(op.path, null);
      sync.local.delete(op.path);
      break;
    case 'rmdirRemote':
      await ask({ t: 'rmdir', path: op.path });
      setBaseline(op.path, null);
      sync.remote.delete(op.path);
      break;
    case 'trashLocal':
      if (!await matches(sync.root, op.path, statOf(op.l))) throw changedError();
      await trashFile(sync.root, op.path);
      setBaseline(op.path, null);
      sync.local.delete(op.path);
      break;
    case 'trashRemote':
      await ask({ t: 'trash', path: op.path, expect: statOf(op.r) });
      setBaseline(op.path, null);
      sync.remote.delete(op.path);
      break;
    case 'pull': await pull(op); break;
    case 'push': await push(op); break;
    case 'compare': await compare(op); break;
    case 'conflict': await keepBoth(op); break;
  }
}

async function scanFolders() {
  const local = new Map();
  for await (const item of walkFolder(sync.root, '')) local.set(item.path, item);
  const remote = new Map();
  for (const item of await ask({ t: 'walk' }, { entries: [] })) {
    try { syncablePath(item.path); } catch { continue; } // Never trust a path from the other side
    remote.set(item.path, item);
  }
  sync.local = local;
  sync.remote = remote;
}

function describePlan(ops) {
  const count = (name) => ops.filter((o) => o.op === name).length;
  const down = count('pull');
  const up = count('push');
  const both = count('conflict');
  const check = count('compare');
  const parts = [];
  if (down) parts.push(`${plural(down, 'file')} to download`);
  if (up) parts.push(`${plural(up, 'file')} to upload`);
  if (check) parts.push(`${plural(check, 'file')} to compare`);
  if (both) parts.push(`${both} with different versions (both will be kept)`);
  return parts.join(', ');
}

function scheduleSync() {
  clearTimeout(sync.timer);
  if (!sync.paused && client.ready && sync.root) sync.timer = setTimeout(syncRound, SYNC_INTERVAL);
}

async function syncRound() {
  if (sync.busy || sync.paused || !client.ready || !sync.root) return;
  clearTimeout(sync.timer);
  sync.busy = true;
  sync.conflicts = 0;
  try {
    await scanFolders();
    if (!sync.root) return;
    let ops = planSync(sync.local, sync.remote, sync.baseline);
    renderRows();

    // A first sync adds files to both folders, so show what will happen before starting.
    const work = ops.filter((o) => isTransfer(o) || o.op === 'compare');
    if (!sync.confirmed) {
      if (work.length) {
        sync.pendingOps = ops;
        syncText(`Ready to sync with ${client.name}`, `${describePlan(ops)}. Nothing will be deleted.`);
        $('sync-start').hidden = false;
        for (const op of work) sync.states.set(op.path, 'waiting');
        renderRows();
        return;
      }
      sync.confirmed = true;
      await save('confirmed:' + sync.key, true);
    }

    // A large deletion usually means a folder went missing, so ask first.
    const deletions = ops.filter(isDelete);
    const synced = [...sync.baseline.values()].filter((b) => !b.dir).length;
    const isBulk = deletions.length > BULK_DELETE_MIN && deletions.length > synced * BULK_DELETE_SHARE;
    sync.held = [];
    if (isBulk && !sync.allowDeletes) {
      sync.held = deletions;
      ops = ops.filter((o) => !isDelete(o) && o.op !== 'rmdirLocal' && o.op !== 'rmdirRemote');
    }
    sync.allowDeletes = false;
    showHeld();

    await runOps(ops);
  } catch (err) {
    if (client.ready && sync.root) syncError('Sync check failed: ' + describeError(err));
  } finally {
    sync.busy = false;
    await saveBaseline(true);
    if (client.ready && sync.root) renderRows();
    scheduleSync();
  }
}

function showHeld() {
  const n = sync.held.length;
  $('held').hidden = !n;
  if (!n) return;
  const here = sync.held.filter((o) => o.op === 'trashLocal').length;
  $('held-text').textContent = `${plural(n, 'file')} disappeared from ${here >= n / 2 ? 'the other computer' : 'this computer'}. If the folder was moved or a drive was disconnected, restore them instead.`;
}

async function runOps(ops) {
  const order = (a, b) => a.path.localeCompare(b.path);
  const made = ops.filter((o) => !isTransfer(o) && o.op !== 'compare' && !isDelete(o) && !o.op.startsWith('rmdir')).sort(order);
  const queue = ops.filter((o) => isTransfer(o) || o.op === 'compare');
  const removed = ops.filter(isDelete);
  const emptied = ops.filter((o) => o.op.startsWith('rmdir')).sort((a, b) => order(b, a));

  sync.states = new Map(queue.map((o) => [o.path, 'waiting']));
  const totalBytes = queue.reduce((sum, o) => sum + (o.op === 'push' ? o.l.size : (o.r?.size || 0)), 0);
  const totalFiles = queue.length;
  let doneBytes = 0;
  let doneFiles = 0;
  let failures = 0;
  let lastRender = 0;

  const progress = (extra) => {
    const bytes = doneBytes + extra;
    syncText(`Syncing ${doneFiles + 1} of ${totalFiles}`, `${formatSize(bytes)} of ${formatSize(totalBytes)}`);
    $('sync-fill').style.width = totalBytes ? Math.min(100, (bytes / totalBytes) * 100) + '%' : '100%';
  };

  const attempt = async (op) => {
    try {
      await runOp(op);
    } catch (err) {
      if (err.code === 'changed') return; // Changed mid-sync. The next pass sees the new version.
      if (err.name === 'AbortError' || !client.ready) throw err;
      failures++;
      syncError(`${op.path}: ${describeError(err)}`);
    } finally {
      sync.states.delete(op.path);
    }
  };

  for (const op of made) await attempt(op);

  $('sync-bar').hidden = !queue.length;
  while (queue.length && client.ready && sync.root && !sync.paused) {
    // Hovering over a waiting file moves it to the front.
    const index = Math.max(0, queue.findIndex((o) => o.path === sync.priority));
    const [op] = queue.splice(index, 1);
    progress(0);
    op.onProgress = progress;
    await attempt(op);
    doneBytes += op.op === 'push' ? op.l.size : (op.r?.size || 0);
    doneFiles++;
    await saveBaseline(false);
    if (Date.now() - lastRender > 500) { lastRender = Date.now(); renderRows(); }
  }
  $('sync-bar').hidden = true;

  if (sync.paused) sync.states.clear();
  else {
    for (const op of removed) await attempt(op);
    for (const op of emptied) await attempt(op);
  }

  if (!sync.root || !client.ready) return;
  sync.lastChecked = Date.now();
  if (sync.paused) syncText('Paused', 'Files won’t sync until you resume.');
  else showIdle(failures);
}

function showIdle(failures) {
  const files = [...sync.local.values()].filter((i) => !i.dir).length;
  const time = new Date(sync.lastChecked).toLocaleTimeString([], { timeStyle: 'short' });
  if (failures) syncText(`${plural(failures, 'item')} couldn’t sync`, 'Trying again shortly.');
  else if (sync.held.length) syncText('Waiting for your decision', '');
  else if (sync.conflicts) syncText(`In sync. ${plural(sync.conflicts, 'file')} had different versions`, 'Both versions were kept. Look for "(conflict" in the file name.');
  else syncText(`In sync with ${client.name}`, `${plural(files, 'file')}. Last checked ${time}.`);
}

async function useFolder(root, keepBaseline) {
  sync.root = root;
  sync.key = await peerIdFor(client.code);
  const saved = keepBaseline ? await load('base:' + sync.key) : null;
  sync.baseline = new Map(Object.entries(saved || {}));
  sync.confirmed = keepBaseline && !!(await load('confirmed:' + sync.key));
  sync.paused = false;
  sync.dirty = false;
  if (!keepBaseline) {
    await forget('base:' + sync.key);
    await forget('confirmed:' + sync.key);
  }
  await save('sync:' + sync.key, { handle: root });
  $('sync-folder').textContent = root.name;
  browse.path = [];
  $('sync-pause').textContent = 'Pause';
  clearSyncErrors();
  syncText('Comparing folders…');
  show('client');
  await syncRound();
}

async function chooseFolder() {
  let root;
  try {
    root = await window.showDirectoryPicker({ id: 'folderlink-sync', mode: 'readwrite' });
  } catch (err) {
    if (err.name !== 'AbortError') toast('Couldn’t open that folder: ' + err.message);
    return;
  }
  await useFolder(root, false);
}

async function afterConnect() {
  setStatus(ROUTE_TEXT.unknown, 'ok');
  routeOf(client.conn).then((route) => {
    setStatus(ROUTE_TEXT[route], route === 'relay' ? 'bad' : 'ok');
  });

  if (sync.root) { // Reconnected after a dropped connection
    show('client');
    await syncRound();
    return;
  }

  $('choose-name').textContent = client.name;
  const supported = !!window.showDirectoryPicker;
  $('choose-folder').disabled = !supported;
  $('choose-unsupported').hidden = supported;
  const resume = $('choose-resume');
  resume.hidden = true;
  const saved = supported ? await load('sync:' + await peerIdFor(client.code)) : null;
  if (saved?.handle) {
    resume.textContent = 'Keep syncing with ' + saved.handle.name;
    resume.hidden = false;
    resume.onclick = async () => {
      const state = await saved.handle.requestPermission({ mode: 'readwrite' });
      if (state === 'granted') await useFolder(saved.handle, true);
      else toast('The browser needs your permission to use that folder.');
    };
  }
  show('choose');
}

/* ---------- File list ---------- */

const browse = { path: [] };

function currentEntries() {
  const prefix = browse.path.length ? browse.path.join('/') + '/' : '';
  const seen = new Map();
  for (const side of [sync.remote, sync.local]) {
    for (const [path, item] of side) {
      if (!path.startsWith(prefix)) continue;
      const name = path.slice(prefix.length);
      if (name.includes('/')) continue;
      seen.set(path, { ...seen.get(path), ...item, name, path });
    }
  }
  return [...seen.values()].sort((a, b) => (!!b.dir - !!a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function entryStatus(entry) {
  if (entry.locked) return 'In use';
  const state = sync.states.get(entry.path);
  const inLocal = sync.local.has(entry.path);
  const inRemote = sync.remote.has(entry.path);
  if (state === 'active') return inLocal && !inRemote ? 'Uploading' : 'Downloading';
  if (state === 'waiting') return inLocal && !inRemote ? 'Waiting to upload' : 'Waiting to download';
  if (inLocal && inRemote) return entry.dir ? '' : 'Synced';
  return inLocal ? 'Only here' : 'Not here yet';
}

function openFolder(path) {
  browse.path = path;
  $('filter').value = '';
  closePreview();
  renderRows();
}

function renderCrumbs() {
  const nav = $('crumbs');
  nav.textContent = '';
  const parts = [sync.root?.name || client.name, ...browse.path];
  parts.forEach((part, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.textContent = '/';
      nav.append(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = part;
    if (i === parts.length - 1) btn.setAttribute('aria-current', 'page');
    else btn.addEventListener('click', () => openFolder(browse.path.slice(0, i)));
    nav.append(btn);
  });
}

function renderRows() {
  renderCrumbs();
  const needle = $('filter').value.trim().toLowerCase();
  const all = currentEntries();
  const entries = needle ? all.filter((e) => e.name.toLowerCase().includes(needle)) : all;
  const body = $('rows');
  body.textContent = '';

  for (const entry of entries) {
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    const tag = document.createElement('span');
    tag.className = entry.dir ? 'tag dir' : 'tag';
    tag.textContent = entry.dir ? 'dir' : extension(entry.name).slice(0, 4) || 'file';
    const label = document.createElement('span');
    label.textContent = entry.name;
    open.append(tag, label);
    open.addEventListener('click', () => {
      if (entry.dir) openFolder([...browse.path, entry.name]);
      else previewFile(entry);
    });
    nameCell.append(open);

    const sizeCell = document.createElement('td');
    sizeCell.className = 'num';
    sizeCell.textContent = entry.dir ? '' : formatSize(entry.size);

    const dateCell = document.createElement('td');
    dateCell.className = 'when';
    dateCell.textContent = formatDate(entry.mtime);

    const statusCell = document.createElement('td');
    statusCell.className = 'state';
    statusCell.textContent = entryStatus(entry);

    tr.append(nameCell, sizeCell, dateCell, statusCell);
    if (!entry.dir) enableDrag(tr, entry);
    body.append(tr);
  }

  const empty = $('empty');
  empty.hidden = entries.length > 0;
  empty.textContent = needle ? 'Nothing here matches that filter.' : 'This folder is empty.';
}

/* ---------- Dragging files out of the page ---------- */

/*
 * Chrome and Edge save a drag that carries a DownloadURL. It has to be set the
 * moment the drag starts, so the file is prepared when the pointer reaches the
 * row. Synced files are already on disk, so the URL points at the local copy.
 */
const dragReady = new Map();

async function prepareDrag(entry) {
  if (dragReady.has(entry.path)) return;
  if (!sync.local.has(entry.path) || sync.states.has(entry.path)) {
    sync.priority = entry.path;
    return;
  }
  try {
    const file = await (await fileAt(sync.root, entry.path)).getFile();
    const url = URL.createObjectURL(file);
    dragReady.set(entry.path, url);
    setTimeout(() => {
      URL.revokeObjectURL(url);
      dragReady.delete(entry.path);
    }, 60000);
  } catch { /* It may have just been moved. The drag will say so. */ }
}

function enableDrag(row, entry) {
  row.draggable = true;
  row.addEventListener('pointerenter', () => prepareDrag(entry));
  row.addEventListener('dragstart', (e) => {
    const url = dragReady.get(entry.path);
    if (!url) {
      e.preventDefault();
      sync.priority = entry.path;
      toast(`${entry.name} is still downloading. It's next in line, so try again in a moment.`);
      return;
    }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('DownloadURL', `application/octet-stream:${entry.name}:${url}`);
    e.dataTransfer.setData('text/plain', entry.name);
  });
}

/* ---------- Preview ---------- */

/* Only these types are shown. Anything else, HTML included, is never rendered. */
const PREVIEW_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf',
};
const TEXT_TYPES = new Set(('txt md markdown json csv tsv log ini cfg conf toml yaml yml xml html htm css js mjs ts tsx jsx py rb go rs java c h cpp hpp cs php sh bat ps1 sql env gitignore').split(' '));

let previewUrl = null;
let previewToken = 0;
let previewJob = null;

function closePreview() {
  previewToken++;
  previewJob?.cancel();
  previewJob = null;
  $('preview').hidden = true;
  $('preview-body').textContent = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function previewMessage(text) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  $('preview-body').replaceChildren(p);
}

/* Uses the copy on this computer, or asks for it if it hasn't arrived yet. */
async function previewData(entry, type) {
  if (sync.local.has(entry.path) && !sync.states.has(entry.path)) {
    const file = await (await fileAt(sync.root, entry.path)).getFile();
    return file.slice(0, file.size, type);
  }
  const parts = [];
  previewJob = fetchFile(entry.path, (chunk) => { parts.push(chunk.slice()); });
  await previewJob.promise;
  previewJob = null;
  return new Blob(parts, { type });
}

async function previewFile(entry) {
  closePreview();
  const token = previewToken;
  const ext = extension(entry.name);
  const type = PREVIEW_TYPES[ext];
  const isText = TEXT_TYPES.has(ext);

  $('preview').hidden = false;
  $('preview-name').textContent = entry.name;

  if (!type && !isText) {
    previewMessage('This file type can’t be previewed. Drag it out of the list, or open it from your synced folder.');
    return;
  }
  if (entry.size > PREVIEW_MAX) {
    previewMessage('This file is too large to preview. Open it from your synced folder.');
    return;
  }

  previewMessage('Loading…');
  try {
    const blob = await previewData(entry, type || 'text/plain');
    if (token !== previewToken) return;
    const body = $('preview-body');

    if (isText) {
      const pre = document.createElement('pre');
      const text = await blob.slice(0, TEXT_PREVIEW_MAX).text();
      if (token !== previewToken) return;
      pre.textContent = text;
      body.replaceChildren(pre);
      if (blob.size > TEXT_PREVIEW_MAX) {
        const more = document.createElement('p');
        more.className = 'note';
        more.textContent = `Showing the first ${formatSize(TEXT_PREVIEW_MAX)}. Open the file from your synced folder to see all of it.`;
        body.prepend(more);
      }
      return;
    }

    previewUrl = URL.createObjectURL(blob);
    let el;
    if (type.startsWith('image/')) {
      el = document.createElement('img');
      el.alt = entry.name;
    } else if (type.startsWith('video/')) {
      el = document.createElement('video');
      el.controls = true;
    } else if (type.startsWith('audio/')) {
      el = document.createElement('audio');
      el.controls = true;
    } else {
      el = document.createElement('iframe');
      el.title = entry.name;
    }
    el.src = previewUrl;
    body.replaceChildren(el);
  } catch (err) {
    if (token === previewToken && err.name !== 'AbortError') previewMessage(describeError(err));
  }
}

/* ---------- Page wiring ---------- */

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Your browser blocked copying. Select the code by hand.');
  }
}

async function join(raw) {
  const code = normalizeCode(raw);
  const error = $('join-error');
  error.hidden = true;
  if (!isValidCode(code)) {
    error.textContent = 'That code doesn’t look right. It should be 20 letters and numbers.';
    error.hidden = false;
    show('home');
    return;
  }
  setStatus('Connecting…');
  try {
    await connect(code);
    await afterConnect();
  } catch (err) {
    setStatus('');
    error.textContent = err.message;
    error.hidden = false;
    show('home');
  }
}

async function init() {
  const canShare = !!window.showDirectoryPicker;
  $('pick-host').disabled = !canShare;
  $('host-unsupported').hidden = canShare;

  $('pick-host').addEventListener('click', async () => {
    try {
      const root = await window.showDirectoryPicker({ id: 'folderlink-share', mode: 'readwrite' });
      await startHost(root, newCode());
    } catch (err) {
      if (err.name !== 'AbortError') toast('Couldn’t open that folder: ' + err.message);
    }
  });

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    join($('join-code').value);
  });

  $('copy-code').addEventListener('click', () => copyText(host.code, 'Code copied'));
  $('copy-link').addEventListener('click', () => {
    copyText(`${location.origin}${location.pathname}#join=${host.code}`, 'Link copied');
  });
  $('stop-host').addEventListener('click', stopHost);

  $('choose-folder').addEventListener('click', chooseFolder);
  $('filter').addEventListener('input', renderRows);
  $('sync-now').addEventListener('click', syncRound);
  $('preview-close').addEventListener('click', closePreview);

  $('sync-start').addEventListener('click', async () => {
    $('sync-start').hidden = true;
    sync.confirmed = true;
    await save('confirmed:' + sync.key, true);
    await syncRound();
  });
  $('sync-pause').addEventListener('click', () => {
    sync.paused = !sync.paused;
    $('sync-pause').textContent = sync.paused ? 'Resume' : 'Pause';
    if (sync.paused) {
      clearTimeout(sync.timer);
      if (!sync.busy) syncText('Paused', 'Files won’t sync until you resume.');
    } else {
      syncRound();
    }
  });
  $('held-apply').addEventListener('click', () => {
    sync.allowDeletes = true;
    sync.held = [];
    showHeld();
    syncRound();
  });
  $('held-restore').addEventListener('click', () => {
    for (const op of sync.held) setBaseline(op.path, null); // No baseline means "new", so it gets copied back
    sync.held = [];
    showHeld();
    syncRound();
  });

  $('lost-retry').addEventListener('click', () => join(client.code));

  window.addEventListener('beforeunload', (e) => {
    if (host.clients.size || sync.busy) e.preventDefault();
  });

  const saved = await load('share');
  if (saved?.handle && canShare) {
    const btn = $('resume-host');
    btn.textContent = 'Resume sharing ' + saved.handle.name;
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      const state = await saved.handle.requestPermission({ mode: 'readwrite' });
      if (state === 'granted') await startHost(saved.handle, saved.code);
      else toast('The browser needs your permission to use that folder.');
    });
  }

  const joinFromLink = () => {
    const match = location.hash.match(/^#join=([0-9A-Za-z-]+)$/);
    if (!match) return;
    history.replaceState(null, '', location.pathname); // Keep the code out of the address bar
    if (client.ready || host.root) return;
    $('join-code').value = match[1];
    join(match[1]);
  };
  window.addEventListener('hashchange', joinFromLink);
  joinFromLink();
}

if (window.Peer && window.RTCPeerConnection && window.crypto?.subtle) {
  init();
} else {
  $('pick-host').disabled = true;
  const err = $('join-error');
  err.textContent = window.Peer
    ? 'This browser can’t make direct connections. Use a current version of Chrome or Edge on an https:// address.'
    : 'A required script didn’t load. Check your internet connection and reload.';
  err.hidden = false;
}

/* Lets automated tests use a folder without the browser's folder picker. */
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.folderlinkTest = { startHost, newCode, join, useFolder, syncRound, planSync, host, client, sync, renderRows };
}
