'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { GoogleDriveSync, hash, stampOf } = require('../google-drive.js');

function serviceFor(dir, settings, remote, deletePropagation = false) {
  const service = new GoogleDriveSync({
    libraryDir: dir,
    readSettings: () => settings,
    writeSettings: (next) => { settings = next; },
    logError: () => {},
    trashFile: (file) => fs.unlink(file)
  });
  service.deletePropagation = async () => deletePropagation;
  service.ensureRoot = async () => 'root';
  service.remoteFiles = async () => ({ files: new Map(remote), folders: new Map([['', 'root']]) });
  service.upload = async (rel, local, existing) => {
    const data = await fs.readFile(local.full);
    const item = { id: existing ? existing.id : rel, hash: hash(data) };
    remote.set(rel, item);
    return item;
  };
  service.download = async (rel, item) => {
    const data = Buffer.from(item.data);
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
    const stat = await fs.stat(file);
    return { hash: hash(data), stamp: stampOf(stat) };
  };
  service.archiveConflict = async (rel, item) => {
    service.conflicts = service.conflicts || [];
    service.conflicts.push({ rel, data: Buffer.from(item.data).toString() });
  };
  service.archiveVersion = async (rel, data) => {
    service.versions = service.versions || [];
    service.versions.push({ rel, data: Buffer.from(data).toString() });
  };
  service.trashRemote = async (item) => {
    for (const [rel, value] of remote) if (value === item) remote.delete(rel);
  };
  return { service, getSettings: () => settings };
}

test('Google Drive uses stable file hashes and local change stamps', async () => {
  const data = Buffer.from('A chapter in plain files.');
  assert.equal(hash(data), '41daac51fc9d1ebec9fcc9ec81ac93845b7cb3e6043eb04c7849106fae9d8eda');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const file = path.join(dir, 'chapter.html');
    await fs.writeFile(file, data);
    const stat = await fs.stat(file);
    assert.equal(stampOf(stat), `${stat.mtimeMs}:${stat.size}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a remote-only change replaces an unchanged local file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const rel = 'book-one/chapters/one.html';
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'baseline');
    const stat = await fs.stat(file);
    const baseHash = hash(Buffer.from('baseline'));
    const remoteData = Buffer.from('from another PC');
    const remote = new Map([[rel, { id: 'remote-one', hash: hash(remoteData), data: remoteData }]]);
    const { service, getSettings } = serviceFor(dir, {
      googleDriveSync: { rootId: 'root', files: { [rel]: { hash: baseHash, stamp: stampOf(stat) } } }
    }, remote);

    await service.syncOnce();

    assert.equal(await fs.readFile(file, 'utf8'), 'from another PC');
    assert.deepEqual(service.versions, [{ rel, data: 'baseline' }]);
    assert.equal(getSettings().googleDriveSync.files[rel].hash, hash(remoteData));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent edits are archived before the local version becomes current', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const rel = 'book-one/chapters/one.html';
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'local words');
    const remoteData = Buffer.from('remote words');
    const remote = new Map([[rel, { id: 'remote-one', hash: hash(remoteData), data: remoteData }]]);
    const { service, getSettings } = serviceFor(dir, {
      googleDriveSync: { rootId: 'root', files: { [rel]: { hash: hash(Buffer.from('baseline')), stamp: 'old-stamp' } } }
    }, remote);

    await service.syncOnce();

    assert.equal(await fs.readFile(file, 'utf8'), 'local words');
    assert.deepEqual(service.conflicts, [{ rel, data: 'remote words' }]);
    assert.equal(remote.get(rel).hash, hash(Buffer.from('local words')));
    assert.equal(getSettings().googleDriveSync.files[rel].hash, hash(Buffer.from('local words')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a saved file uploads by its known Drive ID without rescanning the library', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const rel = 'book-one/chapters/one.html';
    const file = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'just saved');
    const remoteData = Buffer.from('before save');
    const remote = new Map([[rel, { id: 'remote-one', hash: hash(remoteData), data: remoteData }]]);
    const { service, getSettings } = serviceFor(dir, {
      googleDriveSync: {
        rootId: 'root',
        folders: { 'book-one': 'remote-book' },
        files: { [rel]: { hash: hash(remoteData), stamp: 'old-stamp', remoteId: 'remote-one' } }
      }
    }, remote);
    service.request = async () => ({ id: 'remote-one', appProperties: { neoSha256: remote.get(rel).hash } });
    service.syncOnce = async () => { throw new Error('save sync should not scan the whole library'); };
    service.pendingPaths.add(rel);

    await service.syncChangedOnce();

    assert.equal(remote.get(rel).hash, hash(Buffer.from('just saved')));
    assert.equal(getSettings().googleDriveSync.files[rel].hash, hash(Buffer.from('just saved')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deletion sync is off by default and preserves Drive files deleted locally', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const rel = 'book-one/chapters/one.html';
    const remote = new Map([[rel, { id: 'remote-one', hash: hash(Buffer.from('chapter')) }]]);
    const settings = { googleDriveSync: { rootId: 'root', files: { [rel]: { hash: remote.get(rel).hash, stamp: 'old', remoteId: 'remote-one' } } } };
    const { service, getSettings } = serviceFor(dir, settings, remote);

    await service.syncOnce();

    assert.equal(remote.has(rel), true);
    assert.deepEqual(getSettings().googleDriveSync.files[rel], settings.googleDriveSync.files[rel]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deletion sync trashes the Drive counterpart when enabled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const rel = 'book-one/chapters/one.html';
    const remote = new Map([[rel, { id: 'remote-one', hash: hash(Buffer.from('chapter')) }]]);
    const settings = { googleDriveSync: { rootId: 'root', files: { [rel]: { hash: remote.get(rel).hash, stamp: 'old', remoteId: 'remote-one' } } } };
    const { service, getSettings } = serviceFor(dir, settings, remote, true);

    await service.syncOnce();

    assert.equal(remote.has(rel), false);
    assert.equal(getSettings().googleDriveSync.files[rel], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deletion sync preference is stored on the shared Drive root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    let appProperties = { neoRoot: '1' };
    let settings = { googleDriveSync: { rootId: 'root' } };
    const service = new GoogleDriveSync({
      libraryDir: dir,
      readSettings: () => settings,
      writeSettings: (next) => { settings = next; },
      logError: () => {}
    });
    service.ensureRoot = async () => 'root';
    service.request = async (_url, options = {}) => {
      if (!options.method) return { appProperties };
      appProperties = JSON.parse(options.body).appProperties;
      return { appProperties };
    };

    assert.equal(await service.deletePropagation('root'), false);
    await service.setDeletePropagation(true);

    assert.equal(appProperties.neoDeletePropagation, '1');
    assert.equal(settings.googleDriveSync.deletePropagation, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Google Drive uses one top-level Neo Library folder by default', async () => {
  let settings = {};
  const queries = [];
  let creates = 0;
  const service = new GoogleDriveSync({
    readSettings: () => settings,
    writeSettings: (next) => { settings = next; },
    logError: () => {}
  });
  service.request = async (url, options = {}) => {
    if (!options.method) {
      queries.push(new URL(url).searchParams.get('q'));
      return { files: [] };
    }
    creates++;
    const body = JSON.parse(options.body);
    assert.equal(body.name, 'Neo Library');
    assert.deepEqual(body.parents, ['root']);
    return { id: 'neo-library', name: body.name };
  };

  const roots = await Promise.all([service.ensureRoot(), service.ensureRoot()]);

  assert.deepEqual(roots, ['neo-library', 'neo-library']);
  assert.equal(creates, 1);
  assert.equal(settings.googleDriveSync.folderName, 'Neo Library');
  assert.ok(queries.every((query) => query.includes("'root' in parents")));
});

test('existing NEO Library folders are renamed instead of creating a second default folder', async () => {
  let settings = { googleDriveSync: { rootId: 'legacy-root' } };
  let renamed = false;
  const service = new GoogleDriveSync({
    readSettings: () => settings,
    writeSettings: (next) => { settings = next; },
    logError: () => {}
  });
  service.request = async (_url, options = {}) => {
    if (!options.method) return { id: 'legacy-root', name: 'NEO Library' };
    renamed = JSON.parse(options.body).name === 'Neo Library';
    return { id: 'legacy-root', name: 'Neo Library' };
  };

  assert.equal(await service.ensureRoot(), 'legacy-root');
  assert.equal(renamed, true);
  assert.equal(settings.googleDriveSync.folderName, 'Neo Library');
});

test('a custom Google Drive folder resets sync state but leaves the old root untouched', async () => {
  let settings = { googleDriveSync: { rootId: 'old-root', files: { 'library.json': { hash: 'old' } }, folders: { book: 'old-book' } } };
  const service = new GoogleDriveSync({
    readSettings: () => settings,
    writeSettings: (next) => { settings = next; },
    logError: () => {}
  });
  service.rootId = 'old-root';

  assert.equal(await service.setFolderName(' My Writing '), true);

  assert.deepEqual(settings.googleDriveSync, { rootId: null, files: {}, folders: {}, folderName: 'My Writing' });
  assert.equal(service.rootId, null);
  assert.equal(await service.setFolderName('My Writing'), false);
  await assert.rejects(service.setFolderName('../outside'), /folder name/);
});

test('import adds Drive-only files, merges shelves, and preserves local conflicts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  try {
    const localLibrary = {
      authorName: 'Local Writer',
      shelves: [{ id: 'shelf-local', name: 'Local', bookIds: ['book-local'] }]
    };
    const remoteLibrary = {
      authorName: 'Drive Writer',
      shelves: [{ id: 'shelf-drive', name: 'From Drive', bookIds: ['book-drive'] }]
    };
    const localFile = path.join(dir, 'book-local', 'chapters', 'one.html');
    const localOnlyFile = path.join(dir, 'book-local', 'chapters', 'kept.html');
    await fs.mkdir(path.dirname(localFile), { recursive: true });
    await fs.writeFile(path.join(dir, 'library.json'), JSON.stringify(localLibrary));
    await fs.writeFile(localFile, 'local version');
    await fs.writeFile(localOnlyFile, 'keep this book file');
    const remoteLibraryData = Buffer.from(JSON.stringify(remoteLibrary));
    const remoteChapterData = Buffer.from('Drive conflict');
    const remoteBookData = Buffer.from('Drive-only book');
    const remote = new Map([
      ['library.json', { id: 'remote-library', hash: hash(remoteLibraryData), data: remoteLibraryData }],
      ['book-local/chapters/one.html', { id: 'remote-chapter', hash: hash(remoteChapterData), data: remoteChapterData }],
      ['book-drive/book.json', { id: 'remote-book', hash: hash(remoteBookData), data: remoteBookData }]
    ]);
    const settings = { googleDriveSync: { rootId: 'root', files: {
      'book-local/chapters/kept.html': { hash: hash(Buffer.from('keep this book file')), stamp: 'old', remoteId: 'missing-drive-file' }
    } } };
    const { service } = serviceFor(dir, settings, remote, true);
    service.bytes = async (item) => Buffer.from(item.data);

    await service.importFromDrive();

    const merged = JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8'));
    assert.deepEqual(merged.shelves.map((shelf) => shelf.bookIds), [['book-local'], ['book-drive']]);
    assert.equal(merged.authorName, 'Local Writer');
    assert.equal(await fs.readFile(path.join(dir, 'book-drive', 'book.json'), 'utf8'), 'Drive-only book');
    assert.equal(await fs.readFile(localFile, 'utf8'), 'local version');
    assert.equal(await fs.readFile(localOnlyFile, 'utf8'), 'keep this book file');
    assert.equal(remote.has('book-local/chapters/kept.html'), true);
    assert.deepEqual(service.conflicts, [{ rel: 'book-local/chapters/one.html', data: 'Drive conflict' }]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('library scan excludes backup archives, temporary writes, and iCloud stand-ins', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-drive-'));
  const service = new GoogleDriveSync({ libraryDir: dir });
  try {
    await fs.mkdir(path.join(dir, 'book-one', 'chapters'), { recursive: true });
    await fs.mkdir(path.join(dir, 'Backups'), { recursive: true });
    await fs.mkdir(path.join(dir, 'Exports'), { recursive: true });
    await fs.writeFile(path.join(dir, 'library.json'), '{}');
    await fs.writeFile(path.join(dir, 'book-one', 'chapters', 'one.html'), '<p>Words.</p>');
    await fs.writeFile(path.join(dir, 'book-one', 'chapters', 'one.html.tmp'), 'partial');
    await fs.writeFile(path.join(dir, 'book-one', '.book.json.icloud'), 'placeholder');
    await fs.writeFile(path.join(dir, 'Backups', 'neo-backup-2026-10-27.zip'), 'archive');
    await fs.writeFile(path.join(dir, 'Exports', 'draft.pdf'), 'export');

    const files = await service.localFiles();
    assert.deepEqual([...files.keys()].sort(), ['book-one/chapters/one.html', 'library.json']);
    service.connected = () => true;
    service.queue = () => {};
    for (const rel of ['Backups/old.zip', 'Exports/draft.pdf', 'book-one/chapter.html.tmp', 'book-one/chapter.html.icloud']) {
      service.schedule(path.join(dir, ...rel.split('/')));
    }
    service.schedule(path.join(dir, 'library.json'));
    assert.deepEqual([...service.pendingPaths], ['library.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
