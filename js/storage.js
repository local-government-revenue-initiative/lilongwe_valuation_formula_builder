/*
 * storage.js - persistence. The current project is autosaved to IndexedDB in
 * the browser; photos are stored as blobs. A project can also be saved to and
 * loaded from a .json file so staff can share or back it up.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'lilongwe-valuation';
  var DB_VERSION = 1;
  var memory = { project: null, photos: {} };
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!root.indexedDB) return resolve(null);
      var req;
      try { req = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbPromise;
  }

  function withStore(name, mode, fn) {
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, mode);
        var store = tx.objectStore(name);
        var result = fn(store);
        tx.oncomplete = function () { resolve(result && result.result !== undefined ? result.result : result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function saveProject(project) {
    memory.project = project;
    return withStore('projects', 'readwrite', function (s) { s.put(JSON.parse(JSON.stringify(project)), 'current'); return true; })
      .catch(function () { return false; });
  }

  function loadProject() {
    return withStore('projects', 'readonly', function (s) { return s.get('current'); })
      .then(function (p) { return p || memory.project; })
      .catch(function () { return memory.project; });
  }

  function clearProject() {
    memory = { project: null, photos: {} };
    return withStore('projects', 'readwrite', function (s) { s.delete('current'); return true; }).catch(function () { return false; })
      .then(function () { return withStore('photos', 'readwrite', function (s) { s.clear(); return true; }).catch(function () { return false; }); });
  }

  function savePhoto(id, blob) {
    memory.photos[id] = blob;
    return withStore('photos', 'readwrite', function (s) { s.put(blob, id); return true; }).catch(function () { return false; });
  }

  function getPhoto(id) {
    return withStore('photos', 'readonly', function (s) { return s.get(id); })
      .then(function (b) { return b || memory.photos[id] || null; })
      .catch(function () { return memory.photos[id] || null; });
  }

  function deletePhoto(id) {
    delete memory.photos[id];
    return withStore('photos', 'readwrite', function (s) { s.delete(id); return true; }).catch(function () { return false; });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = (parts[0].match(/data:([^;]+)/) || [null, 'image/jpeg'])[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /* Build a self-contained JSON export including photos as data URLs */
  function exportProjectFile(project) {
    var ids = [];
    (project.properties || []).forEach(function (p) { (p.photoIds || []).forEach(function (id) { ids.push(id); }); });
    return Promise.all(ids.map(function (id) {
      return getPhoto(id).then(function (b) { return b ? blobToDataUrl(b).then(function (d) { return { id: id, data: d }; }) : null; });
    })).then(function (photos) {
      var out = JSON.parse(JSON.stringify(project));
      out.photos = {};
      photos.forEach(function (ph) { if (ph) out.photos[ph.id] = ph.data; });
      out.exportedAt = new Date().toISOString();
      return JSON.stringify(out);
    });
  }

  /* Parse a project file produced by exportProjectFile; stores its photos */
  function importProjectFile(text) {
    var obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.properties)) throw new Error('Not a valuation project file.');
    var photos = obj.photos || {};
    delete obj.photos;
    var saves = Object.keys(photos).map(function (id) { return savePhoto(id, dataUrlToBlob(photos[id])); });
    return Promise.all(saves).then(function () { return obj; });
  }

  /* Resize an image file to fit in maxPx and return a JPEG blob */
  function resizeImage(file, maxPx, quality) {
    maxPx = maxPx || 1024; quality = quality || 0.75;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('Could not encode image')); }, 'image/jpeg', quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Not an image file')); };
      img.src = url;
    });
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  root.Storage = {
    saveProject: saveProject, loadProject: loadProject, clearProject: clearProject,
    savePhoto: savePhoto, getPhoto: getPhoto, deletePhoto: deletePhoto,
    exportProjectFile: exportProjectFile, importProjectFile: importProjectFile,
    resizeImage: resizeImage, downloadText: downloadText
  };
}(typeof self !== 'undefined' ? self : this));
