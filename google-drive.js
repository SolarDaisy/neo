'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const DEFAULT_FOLDER = 'Neo Library';
const CLIENT_ID = process.env.NEO_GOOGLE_DRIVE_CLIENT_ID || '862925797610-7cvf69rciietluq8urhfrilmehr07m5f.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.NEO_GOOGLE_DRIVE_CLIENT_SECRET || '';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const stampOf = (stat) => `${stat.mtimeMs}:${stat.size}`;
const safeName = (name) => String(name).replace(/[\\/:*?"<>|]/g, '_');
function mergeLibraryFiles(localData, remoteData) {
  try {
    const local = JSON.parse(localData.toString('utf8'));
    const remote = JSON.parse(remoteData.toString('utf8'));
    if (!Array.isArray(local.shelves) || !Array.isArray(remote.shelves)) return null;
    const merged = { ...remote, ...local };
    if (!local.authorName && remote.authorName) merged.authorName = remote.authorName;
    if (remote.firstRunDone) merged.firstRunDone = true;
    for (const key of ['penNames', 'customWords']) {
      if (Array.isArray(local[key]) && Array.isArray(remote[key])) {
        merged[key] = [...new Set([...local[key], ...remote[key]])];
      }
    }
    const shelves = [];
    const byId = new Map();
    const bookIds = new Set();
    for (const shelf of [...local.shelves, ...remote.shelves]) {
      if (!shelf || typeof shelf.id !== 'string' || !shelf.id || !Array.isArray(shelf.bookIds)) return null;
      let target = byId.get(shelf.id);
      if (!target) {
        target = { ...shelf, bookIds: [] };
        byId.set(shelf.id, target);
        shelves.push(target);
      }
      for (const id of shelf.bookIds) {
        if (typeof id === 'string' && !bookIds.has(id)) {
          target.bookIds.push(id);
          bookIds.add(id);
        }
      }
    }
    merged.shelves = shelves;
    return Buffer.from(JSON.stringify(merged, null, 2));
  } catch {
    return null;
  }
}
const safeRelative = (rel) => typeof rel === 'string' && rel.split('/').every((part) =>
  part && part !== '.' && part !== '..' && !/[\\/\0]/.test(part));
const timedFetch = (url, options, timeoutMs = 30000) => fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

async function writeDurable(file, data) {
  const tmp = file + '.neo-drive-tmp';
  const handle = await fsp.open(tmp, 'w');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  try {
    for (let wait = 5; ; wait *= 2) {
      try { await fsp.rename(tmp, file); break; } catch (err) {
        if (process.platform !== 'win32' || wait > 320 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    if (process.platform !== 'win32') {
      try {
        const dir = await fsp.open(path.dirname(file), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      } catch { /* not every filesystem can sync directories */ }
    }
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

class GoogleDriveSync {
  constructor({ shell, safeStorage, libraryDir, readSettings, writeSettings, logError, trashFile, isCloudOnly }) {
    this.shell = shell;
    this.safeStorage = safeStorage;
    this.libraryDir = libraryDir;
    this.readSettings = readSettings;
    this.writeSettings = writeSettings;
    this.logError = logError;
    this.trashFile = trashFile;
    this.isCloudOnly = isCloudOnly || (() => false);
    this.accessToken = null;
    this.expiresAt = 0;
    this.rootId = null;
    this.rootPromise = null;
    this.running = null;
    this.fullRequested = false;
    this.pendingPaths = new Set();
    this.pollTimer = null;
    this.debounceTimer = null;
  }

  configured() {
    return !!CLIENT_ID && !CLIENT_ID.startsWith('ADD_');
  }

  tokens() {
    const stored = this.readSettings().googleDriveToken;
    if (!stored) return null;
    if (!stored.enc || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Google Drive credentials cannot be read securely on this computer.');
    }
    return JSON.parse(this.safeStorage.decryptString(Buffer.from(stored.value, 'base64')));
  }

  saveTokens(tokens) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Google Drive sign-in needs secure credential storage, which is not available on this computer.');
    }
    const settings = this.readSettings();
    settings.googleDriveToken = {
      enc: true,
      value: this.safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
    };
    this.writeSettings(settings);
  }

  connected() {
    return !!this.readSettings().googleDriveToken;
  }

  folderName() {
    const sync = this.readSettings().googleDriveSync || {};
    return typeof sync.folderName === 'string' && sync.folderName ? sync.folderName : DEFAULT_FOLDER;
  }

  normalizeFolderName(name) {
    if (typeof name !== 'string') throw new Error('Enter a name for the Google Drive folder.');
    const value = name.trim();
    if (!value || value.length > 255 || /[\\/:*?"<>|\0]/.test(value)) {
      throw new Error('The Google Drive folder name must be 1–255 characters and cannot contain slashes or reserved characters.');
    }
    return value;
  }

  async setFolderName(name) {
    const folderName = this.normalizeFolderName(name);
    if (folderName === this.folderName()) return false;
    while (this.running) await this.running;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.pendingPaths.clear();
    this.fullRequested = false;
    this.rootId = null;
    this.rootPromise = null;
    const settings = this.readSettings();
    const sync = settings.googleDriveSync || {};
    settings.googleDriveSync = { ...sync, folderName, rootId: null, files: {}, folders: {} };
    this.writeSettings(settings);
    return true;
  }

  async authorize() {
    if (!this.configured()) throw new Error('Google Drive is not configured in this build. The publisher must add its Google OAuth client ID.');
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Google Drive sign-in needs secure credential storage, which is not available on this computer.');
    }
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('hex');

    const result = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let callback;
        try { callback = new URL(req.url, 'http://127.0.0.1'); } catch {
          res.writeHead(400).end('Invalid callback.');
          return;
        }
        if (callback.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        if (callback.searchParams.get('state') !== state) {
          res.writeHead(400).end('Sign-in state did not match.');
          return;
        }
        const code = callback.searchParams.get('code');
        const error = callback.searchParams.get('error');
        res.writeHead(error || !code ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error || !code ? 'Google Drive sign-in was not completed. You can close this window.' : 'Google Drive is connected. You can close this window and return to NEO.');
        clearTimeout(timeout);
        server.close();
        if (error || !code) reject(new Error('Google Drive sign-in was not completed: ' + (error || 'no authorization code')));
        else resolve({ code, redirectUri });
      });
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Google Drive sign-in timed out.'));
      }, 5 * 60 * 1000);
      timeout.unref?.();
      server.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      server.listen(0, '127.0.0.1', async () => {
        server.unref();
        const address = server.address();
        const redirectUri = `http://127.0.0.1:${address.port}`;
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString();
        try { await this.shell.openExternal(auth.href); } catch (err) {
          clearTimeout(timeout);
          server.close();
          reject(err);
        }
      });
    });

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      code: result.code,
      code_verifier: verifier,
      redirect_uri: result.redirectUri,
      grant_type: 'authorization_code'
    });
    if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
    const response = await timedFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const token = await response.json();
    if (!response.ok || !token.refresh_token) throw new Error('Google Drive token exchange failed: ' + (token.error_description || token.error || response.status));
    this.saveTokens({ refreshToken: token.refresh_token });
    this.accessToken = token.access_token;
    this.expiresAt = Date.now() + (token.expires_in || 3600) * 1000;
    return true;
  }

  async disconnect() {
    let tokens = null;
    try { tokens = this.tokens(); } catch { /* settings are cleared even if credentials cannot be opened */ }
    const settings = this.readSettings();
    const folderName = settings.googleDriveSync && settings.googleDriveSync.folderName;
    delete settings.googleDriveToken;
    delete settings.googleDriveSync;
    if (folderName) settings.googleDriveSync = { folderName };
    this.writeSettings(settings);
    this.accessToken = null;
    this.expiresAt = 0;
    this.rootId = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    if (tokens && tokens.refreshToken) {
      try {
        const response = await timedFetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokens.refreshToken })
        });
        if (!response.ok && response.status !== 400) throw new Error(`Google Drive token revocation failed (${response.status}): ${await response.text()}`);
      } catch (err) {
        this.logError('Google Drive revoke', err);
      }
    }
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    const tokens = this.tokens();
    if (!tokens || !tokens.refreshToken) throw new Error('Connect Google Drive from File → Google Drive… first.');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token'
    });
    if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
    const response = await timedFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error('Google Drive token refresh failed: ' + (data.error_description || data.error || response.status));
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async request(url, options = {}) {
    const token = await this.token();
    const response = await timedFetch(url, {
      ...options,
      headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) }
    });
    if (response.status === 401) {
      this.accessToken = null;
      const renewed = await this.token();
      const retry = await timedFetch(url, { ...options, headers: { Authorization: 'Bearer ' + renewed, ...(options.headers || {}) } });
      if (!retry.ok) throw Object.assign(new Error(`Google Drive request failed (${retry.status}): ${await retry.text()}`), { status: retry.status });
      return retry.status === 204 ? null : retry.json();
    }
    if (!response.ok) throw Object.assign(new Error(`Google Drive request failed (${response.status}): ${await response.text()}`), { status: response.status });
    return response.status === 204 ? null : response.json();
  }

  async uploadMedia(url, metadata, data, contentType, method = 'POST') {
    const initiate = async () => timedFetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + await this.token(),
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(data.length)
      },
      body: JSON.stringify(metadata)
    });
    let response = await initiate();
    if (response.status === 401) {
      this.accessToken = null;
      response = await initiate();
    }
    if (!response.ok) throw new Error(`Google Drive upload could not start (${response.status}): ${await response.text()}`);
    const location = response.headers.get('Location');
    if (!location || new URL(location).origin !== 'https://www.googleapis.com') {
      throw new Error('Google Drive returned an invalid upload URL.');
    }
    const put = async () => timedFetch(location, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + await this.token(), 'Content-Type': contentType },
      body: data
    }, Math.max(30000, Math.ceil(data.length / 65536) * 1000));
    response = await put();
    if (response.status === 401) {
      this.accessToken = null;
      response = await put();
    }
    if (!response.ok) throw new Error(`Google Drive upload failed (${response.status}): ${await response.text()}`);
    return response.json();
  }

  async listChildren(parent) {
    const out = [];
    let pageToken;
    do {
      const query = new URLSearchParams({
        q: `'${parent}' in parents and trashed=false`,
        spaces: 'drive',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,appProperties,parents)'
      });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await this.request(`${DRIVE_API}/files?${query}`);
      out.push(...(data.files || []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFolder(name, parent, appProperties) {
    return this.request(`${DRIVE_API}/files?fields=id,name,mimeType`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent], appProperties })
    });
  }

  async ensureRoot() {
    if (this.rootId) return this.rootId;
    if (this.rootPromise) return this.rootPromise;
    this.rootPromise = this.findOrCreateRoot().finally(() => { this.rootPromise = null; });
    return this.rootPromise;
  }

  async findOrCreateRoot() {
    const settings = this.readSettings();
    if (settings.googleDriveSync && settings.googleDriveSync.rootId) {
      this.rootId = settings.googleDriveSync.rootId;
      if (!settings.googleDriveSync.folderName && this.folderName() === DEFAULT_FOLDER) {
        const existing = await this.request(`${DRIVE_API}/files/${encodeURIComponent(this.rootId)}?fields=id,name`);
        if (existing.name === 'NEO Library') {
          await this.request(`${DRIVE_API}/files/${encodeURIComponent(this.rootId)}?fields=id,name`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: DEFAULT_FOLDER })
          });
        }
        settings.googleDriveSync = { ...settings.googleDriveSync, folderName: DEFAULT_FOLDER };
        this.writeSettings(settings);
      }
      return this.rootId;
    }
    const folderName = this.folderName();
    const findFolder = async (name) => {
      const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const query = new URLSearchParams({
        q: `mimeType='${FOLDER}' and name='${escapedName}' and 'root' in parents and appProperties has { key='neoRoot' and value='1' } and trashed=false`,
        spaces: 'drive',
        pageSize: '10',
        fields: 'files(id,name)'
      });
      return this.request(`${DRIVE_API}/files?${query}`);
    };
    const found = await findFolder(folderName);
    let root = (found.files || [])[0];
    if (!root && folderName === DEFAULT_FOLDER) {
      const legacy = await findFolder('NEO Library');
      root = (legacy.files || [])[0];
      if (root) {
        await this.request(`${DRIVE_API}/files/${encodeURIComponent(root.id)}?fields=id,name`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: folderName })
        });
      }
    }
    if (!root) root = await this.createFolder(folderName, 'root', { neoRoot: '1' });
    this.rootId = root.id;
    settings.googleDriveSync = { ...(settings.googleDriveSync || {}), folderName, rootId: root.id };
    this.writeSettings(settings);
    return this.rootId;
  }

  async deletePropagation(rootId) {
    const data = await this.request(`${DRIVE_API}/files/${encodeURIComponent(rootId)}?fields=appProperties`);
    const enabled = !!(data.appProperties && data.appProperties.neoDeletePropagation === '1');
    const settings = this.readSettings();
    settings.googleDriveSync = { ...(settings.googleDriveSync || {}), deletePropagation: enabled };
    this.writeSettings(settings);
    return enabled;
  }

  async setDeletePropagation(enabled) {
    const rootId = await this.ensureRoot();
    const data = await this.request(`${DRIVE_API}/files/${encodeURIComponent(rootId)}?fields=appProperties`);
    const appProperties = { ...(data.appProperties || {}), neoRoot: '1', neoDeletePropagation: enabled ? '1' : '0' };
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(rootId)}?fields=id,appProperties`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appProperties })
    });
    const settings = this.readSettings();
    settings.googleDriveSync = { ...(settings.googleDriveSync || {}), deletePropagation: !!enabled };
    this.writeSettings(settings);
    return !!enabled;
  }

  async localFiles() {
    const files = new Map();
    const walk = async (dir, rel) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        if (!rel && ['Backups', 'Exports'].includes(entry.name)) continue;
        if (entry.name.endsWith('.tmp') || entry.name.endsWith('.icloud') || entry.name.endsWith('.neo-drive-tmp')) continue;
        const childRel = rel ? path.join(rel, entry.name) : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, childRel);
        else if (entry.isFile()) {
          const stat = await fsp.stat(full);
          if (this.isCloudOnly(full)) throw Object.assign(new Error('A library file is still stored in iCloud and cannot be synced yet: ' + childRel), { code: 'ECLOUD' });
          files.set(childRel.split(path.sep).join('/'), { full, stat, stamp: stampOf(stat) });
        }
      }
    };
    await walk(this.libraryDir, '');
    return files;
  }

  async remoteFiles(rootId) {
    const files = new Map();
    const folders = new Map([['', rootId]]);
    const walk = async (parent, rel) => {
      for (const item of await this.listChildren(parent)) {
        if (item.mimeType === FOLDER) {
          if (!safeRelative(item.name)) {
            this.logError('Google Drive sync', new Error('Ignored an unsafe Drive folder name.'));
            continue;
          }
          if (!rel && ['Backups', 'Google Drive Conflicts'].includes(item.name)) continue;
          const next = rel ? rel + '/' + item.name : item.name;
          folders.set(next, item.id);
          await walk(item.id, next);
        } else {
          const full = rel ? rel + '/' + item.name : item.name;
          if (!safeRelative(full)) {
            this.logError('Google Drive sync', new Error('Ignored an unsafe Drive file path.'));
            continue;
          }
          files.set(full, { ...item, parentId: parent, hash: item.appProperties && item.appProperties.neoSha256 || null });
        }
      }
    };
    await walk(rootId, '');
    return { files, folders };
  }

  async bytes(file) {
    const token = await this.token();
    const response = await timedFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, {
      headers: { Authorization: 'Bearer ' + token }
    }, Math.max(30000, Math.ceil(Number(file.size || 0) / 65536) * 1000));
    if (!response.ok) throw new Error(`Google Drive download failed (${response.status}): ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async ensureParent(rel, folders, rootId) {
    const parts = rel.split('/');
    parts.pop();
    let parent = rootId;
    let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      if (!folders.has(current)) {
        const folder = await this.createFolder(part, parent);
        folders.set(current, folder.id);
      }
      parent = folders.get(current);
    }
    return parent;
  }

  async localDirectory(parts) {
    let dir = this.libraryDir;
    for (const part of parts) {
      dir = path.join(dir, part);
      try {
        const stat = await fsp.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to write through a non-directory in the library.');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        await fsp.mkdir(dir);
      }
    }
    return dir;
  }

  async upload(rel, local, existing, folders, rootId) {
    const data = await fsp.readFile(local.full);
    const digest = hash(data);
    const parent = await this.ensureParent(rel, folders, rootId);
    const name = rel.split('/').pop();
    const meta = {
      name,
      appProperties: { neoSha256: digest }
    };
    if (!existing) meta.parents = [parent];
    const contentType = 'application/octet-stream';
    const url = `${DRIVE_UPLOAD}/files${existing ? '/' + encodeURIComponent(existing.id) : ''}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,md5Checksum,appProperties,parents`;
    const result = await this.uploadMedia(url, meta, data, contentType, existing ? 'PATCH' : 'POST');
    return { ...result, parentId: parent, hash: digest };
  }

  async download(rel, remote) {
    if (!safeRelative(rel)) throw new Error('Google Drive returned an unsafe file path.');
    const data = await this.bytes(remote);
    const parts = rel.split('/');
    const dir = await this.localDirectory(parts.slice(0, -1));
    const target = path.join(dir, parts[parts.length - 1]);
    if (this.isCloudOnly(target)) throw Object.assign(new Error('A library file is still stored in iCloud and cannot be replaced yet: ' + rel), { code: 'ECLOUD' });
    await writeDurable(target, data);
    const stat = await fsp.stat(target);
    return { hash: hash(data), stamp: stampOf(stat) };
  }

  async trashRemote(remote) {
    await this.request(`${DRIVE_API}/files/${encodeURIComponent(remote.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  }

  async archiveConflict(rel, remote) {
    return this.archiveVersion(rel, await this.bytes(remote));
  }

  async archiveVersion(rel, data) {
    if (!safeRelative(rel)) throw new Error('Cannot archive an unsafe Google Drive path.');
    const at = new Date().toISOString().replace(/[:.]/g, '-');
    const parts = ['Backups', 'Google Drive Conflicts', at, ...rel.split('/')];
    const localDir = await this.localDirectory(parts.slice(0, -1));
    const localPath = path.join(localDir, parts[parts.length - 1]);
    await writeDurable(localPath, data);
    const rootId = await this.ensureRoot();
    let folderId = (await this.listChildren(rootId)).find((item) => item.name === 'Google Drive Conflicts' && item.mimeType === FOLDER)?.id;
    if (!folderId) folderId = (await this.createFolder('Google Drive Conflicts', rootId)).id;
    const name = safeName(`${at} - ${rel.replace(/\//g, ' - ')}`);
    await this.uploadMedia(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, { name, parents: [folderId] }, data, 'application/octet-stream');
  }

  async sync() {
    if (this.running) {
      this.fullRequested = true;
      return this.running;
    }
    this.running = this.syncOnce().finally(() => {
      this.running = null;
      if (this.fullRequested) { this.fullRequested = false; this.sync().catch((err) => this.logError('Google Drive sync', err)); }
      else if (this.pendingPaths.size) this.queue();
    });
    return this.running;
  }

  async syncChanged() {
    if (this.running) return this.running;
    this.running = this.syncChangedOnce().finally(() => {
      this.running = null;
      if (this.fullRequested) { this.fullRequested = false; this.sync().catch((err) => this.logError('Google Drive sync', err)); }
      else if (this.pendingPaths.size) this.queue();
    });
    return this.running;
  }

  async importFromDrive() {
    if (this.running) return this.running.then(() => this.importFromDrive());
    this.running = this.importOnce().finally(() => {
      this.running = null;
      if (this.fullRequested) { this.fullRequested = false; this.sync().catch((err) => this.logError('Google Drive sync', err)); }
      else if (this.pendingPaths.size) this.queue();
    });
    return this.running;
  }

  async importOnce() {
    const rootId = await this.ensureRoot();
    const remoteState = await this.remoteFiles(rootId);
    const local = await this.localFiles();
    const settings = this.readSettings();
    const syncState = settings.googleDriveSync || {};
    const baseline = syncState.files || {};
    const next = { ...baseline };

    for (const [rel, remote] of remoteState.files) {
      if (!remote.hash) remote.hash = hash(await this.bytes(remote));
      const here = local.get(rel);
      if (!here) {
        const saved = await this.download(rel, remote);
        next[rel] = { ...saved, remoteId: remote.id };
        local.set(rel, { full: path.join(this.libraryDir, ...rel.split('/')), stamp: saved.stamp });
        continue;
      }

      const localData = await fsp.readFile(here.full);
      const localHash = hash(localData);
      if (localHash === remote.hash) {
        next[rel] = { hash: localHash, stamp: here.stamp, remoteId: remote.id };
        continue;
      }

      if (rel === 'library.json') {
        const merged = mergeLibraryFiles(localData, await this.bytes(remote));
        if (merged) {
          await writeDurable(here.full, merged);
          const uploaded = await this.upload(rel, { full: here.full }, remote, remoteState.folders, rootId);
          next[rel] = { hash: uploaded.hash, stamp: stampOf(await fsp.stat(here.full)), remoteId: uploaded.id };
          continue;
        }
      }

      await this.archiveConflict(rel, remote);
      const uploaded = await this.upload(rel, here, remote, remoteState.folders, rootId);
      next[rel] = { hash: uploaded.hash, stamp: here.stamp, remoteId: uploaded.id };
    }

    for (const [rel, here] of local) {
      if (remoteState.files.has(rel)) continue;
      const uploaded = await this.upload(rel, here, null, remoteState.folders, rootId);
      next[rel] = { hash: uploaded.hash, stamp: here.stamp, remoteId: uploaded.id };
    }

    const updatedSettings = this.readSettings();
    updatedSettings.googleDriveSync = {
      ...(updatedSettings.googleDriveSync || syncState),
      rootId,
      files: next,
      folders: Object.fromEntries(remoteState.folders),
      lastSynced: new Date().toISOString()
    };
    this.writeSettings(updatedSettings);
    return updatedSettings.googleDriveSync.lastSynced;
  }

  async syncChangedOnce() {
    const changed = [...this.pendingPaths];
    this.pendingPaths.clear();
    const settings = this.readSettings();
    const syncState = settings.googleDriveSync || {};
    const baseline = syncState.files || {};
    if (!syncState.rootId || changed.some((rel) => !baseline[rel] || !baseline[rel].remoteId)) {
      return this.syncOnce();
    }
    const folders = new Map(Object.entries(syncState.folders || {}));
    for (const rel of changed) {
      if (!safeRelative(rel)) continue;
      const previous = baseline[rel];
      const localFile = path.join(this.libraryDir, ...rel.split('/'));
      let stat;
      try { stat = await fsp.stat(localFile); } catch (err) {
        if (err.code === 'ENOENT') return this.syncOnce();
        throw err;
      }
      if (!stat.isFile()) return this.syncOnce();
      if (this.isCloudOnly(localFile)) throw Object.assign(new Error('A library file is still stored in iCloud and cannot be synced yet: ' + rel), { code: 'ECLOUD' });
      const localHash = hash(await fsp.readFile(localFile));
      let remote;
      try {
        remote = await this.request(`${DRIVE_API}/files/${encodeURIComponent(previous.remoteId)}?fields=id,name,mimeType,modifiedTime,md5Checksum,appProperties,parents,trashed`);
      } catch (err) {
        if (err.status === 404) return this.syncOnce();
        throw err;
      }
      if (!remote || remote.trashed) return this.syncOnce();
      remote.hash = remote.appProperties && remote.appProperties.neoSha256 || hash(await this.bytes(remote));
      if (localHash === remote.hash) {
        baseline[rel] = { hash: localHash, stamp: stampOf(stat), remoteId: remote.id };
      } else {
        const localChanged = localHash !== previous.hash;
        const remoteChanged = remote.hash !== previous.hash;
        if (localChanged && remoteChanged) await this.archiveConflict(rel, remote);
        if (localChanged || !remoteChanged) {
          const uploaded = await this.upload(rel, { full: localFile }, remote, folders, syncState.rootId);
          baseline[rel] = { hash: uploaded.hash, stamp: stampOf(await fsp.stat(localFile)), remoteId: uploaded.id };
        } else {
          await this.archiveVersion(rel, await fsp.readFile(localFile));
          const saved = await this.download(rel, remote);
          baseline[rel] = { ...saved, remoteId: remote.id };
        }
      }
    }
    const updatedSettings = this.readSettings();
    updatedSettings.googleDriveSync = { ...syncState, files: baseline, folders: Object.fromEntries(folders), lastSynced: new Date().toISOString() };
    this.writeSettings(updatedSettings);
    return updatedSettings.googleDriveSync.lastSynced;
  }

  async syncOnce() {
    this.pendingPaths.clear();
    const rootId = await this.ensureRoot();
    const deletePropagation = await this.deletePropagation(rootId);
    const settings = this.readSettings();
    const syncState = settings.googleDriveSync || {};
    const baseline = syncState.files || {};
    const local = await this.localFiles();
    const remoteState = await this.remoteFiles(rootId);
    const remote = remoteState.files;
    const next = {};

    for (const rel of new Set([...local.keys(), ...remote.keys()])) {
      const here = local.get(rel);
      const there = remote.get(rel);
      const previous = baseline[rel];
      let localHash = null;
      if (here) {
        if (previous && previous.stamp === here.stamp) localHash = previous.hash;
        else localHash = hash(await fsp.readFile(here.full));
      }
      if (here && there && !there.hash) there.hash = hash(await this.bytes(there));

      if (!previous) {
        if (!here && there) {
          const saved = await this.download(rel, there);
          next[rel] = { hash: saved.hash, stamp: saved.stamp, remoteId: there.id };
        } else if (here && there && localHash !== there.hash) {
          const hasBooks = [...local.keys()].some((name) => name.startsWith('book-'));
          if (!hasBooks) {
            const saved = await this.download(rel, there);
            next[rel] = { hash: saved.hash, stamp: saved.stamp, remoteId: there.id };
          } else {
            await this.archiveConflict(rel, there);
            const updated = await this.upload(rel, here, there, remoteState.folders, rootId);
            next[rel] = { hash: updated.hash, stamp: here.stamp, remoteId: updated.id };
          }
        } else if (here && (!there || localHash !== there.hash)) {
          const updated = await this.upload(rel, here, there, remoteState.folders, rootId);
          next[rel] = { hash: updated.hash, stamp: here.stamp, remoteId: updated.id };
        } else if (here && there) next[rel] = { hash: localHash, stamp: here.stamp, remoteId: there.id };
        continue;
      }

      if (!here && there) {
        if (deletePropagation) await this.trashRemote(there);
        else next[rel] = previous;
        continue;
      }
      if (here && !there) {
        if (localHash === previous.hash && deletePropagation) {
          await this.trashFile(here.full);
          continue;
        }
        const updated = await this.upload(rel, here, null, remoteState.folders, rootId);
        next[rel] = { hash: updated.hash, stamp: here.stamp, remoteId: updated.id };
        continue;
      }
      if (!here || !there) continue;

      const localChanged = localHash !== previous.hash;
      const remoteChanged = there.hash !== previous.hash;
      if (localHash === there.hash) {
        next[rel] = { hash: localHash, stamp: here.stamp, remoteId: there.id };
      } else if (localChanged && remoteChanged) {
        await this.archiveConflict(rel, there);
        const updated = await this.upload(rel, here, there, remoteState.folders, rootId);
        next[rel] = { hash: updated.hash, stamp: here.stamp, remoteId: updated.id };
      } else if (localChanged) {
        const updated = await this.upload(rel, here, there, remoteState.folders, rootId);
        next[rel] = { hash: updated.hash, stamp: here.stamp, remoteId: updated.id };
      } else if (remoteChanged) {
        await this.archiveVersion(rel, await fsp.readFile(here.full));
        const saved = await this.download(rel, there);
        next[rel] = { ...saved, remoteId: there.id };
      } else {
        next[rel] = previous;
      }
    }

    const updatedSettings = this.readSettings();
    updatedSettings.googleDriveSync = {
      ...(updatedSettings.googleDriveSync || {}),
      rootId,
      files: next,
      folders: Object.fromEntries(remoteState.folders),
      lastSynced: new Date().toISOString()
    };
    this.writeSettings(updatedSettings);
    return updatedSettings.googleDriveSync.lastSynced;
  }

  async uploadBackup(file) {
    if (!this.connected()) return;
    const rootId = await this.ensureRoot();
    const rootChildren = await this.listChildren(rootId);
    let backupFolder = rootChildren.find((item) => item.name === 'Backups' && item.mimeType === FOLDER);
    if (!backupFolder) backupFolder = await this.createFolder('Backups', rootId);
    const data = await fsp.readFile(file);
    const name = path.basename(file);
    const children = await this.listChildren(backupFolder.id);
    if (!children.some((item) => item.name === name)) {
      await this.uploadMedia(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name,modifiedTime`, { name, parents: [backupFolder.id] }, data, 'application/zip');
    }
    const backups = (await this.listChildren(backupFolder.id))
      .filter((item) => /^neo-backup-\d{4}-\d{2}-\d{2}(?:-\d{9})?\.zip$/.test(item.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const old of backups.slice(3)) await this.trashRemote(old);
  }

  schedule(file) {
    if (!this.connected()) return;
    if (file !== undefined) {
      const rel = path.relative(this.libraryDir, file).split(path.sep).join('/');
      if (!safeRelative(rel)) return;
      if (['Backups', 'Exports'].includes(rel.split('/')[0]) ||
          rel.endsWith('.tmp') || rel.endsWith('.icloud') || rel.endsWith('.neo-drive-tmp')) return;
      this.pendingPaths.add(rel);
    } else {
      this.fullRequested = true;
    }
    this.queue();
  }

  queue() {
    if (!this.connected()) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const task = this.fullRequested ? this.sync() : this.syncChanged();
      task.catch((err) => this.logError('Google Drive sync', err));
    }, 1200);
    this.debounceTimer.unref?.();
  }

  startMonitoring() {
    if (!this.connected() || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.sync().catch((err) => this.logError('Google Drive sync', err));
    }, 30000);
    this.pollTimer.unref?.();
    this.schedule();
  }
}

module.exports = { GoogleDriveSync, hash, stampOf };
