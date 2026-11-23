'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      const srcRow = this.sheet._data[this.row - 1 + r] || [];
      for (let c = 0; c < this.numCols; c++) {
        const v = srcRow[this.col - 1 + c];
        rowArr.push(v === undefined ? '' : v);
      }
      out.push(rowArr);
    }
    return out;
  }

  getValue() {
    return this.getValues()[0][0];
  }

  setValues(values) {
    this.sheet._stats.setValuesCalls++;
    for (let r = 0; r < values.length; r++) {
      const idx = this.row - 1 + r;
      while (this.sheet._data.length <= idx) this.sheet._data.push([]);
      for (let c = 0; c < values[r].length; c++) {
        this.sheet._data[idx][this.col - 1 + c] = values[r][c];
      }
    }
    return this;
  }

  setValue(val) {
    this.sheet._stats.setValueCalls++;
    const idx = this.row - 1;
    while (this.sheet._data.length <= idx) this.sheet._data.push([]);
    this.sheet._data[idx][this.col - 1] = val;
    return this;
  }

  clearContent() {
    this.sheet._stats.clearContentCalls++;
    for (let r = 0; r < this.numRows; r++) {
      const idx = this.row - 1 + r;
      if (!this.sheet._data[idx]) continue;
      for (let c = 0; c < this.numCols; c++) {
        this.sheet._data[idx][this.col - 1 + c] = '';
      }
    }
    return this;
  }

  setNumberFormat(fmt) {
    this.sheet._formats.push({ row: this.row, col: this.col, numRows: this.numRows, numCols: this.numCols, fmt });
    return this;
  }

  setDataValidation(rule) {
    this.sheet._validations.push({ row: this.row, col: this.col, rule });
    return this;
  }

  getRow() { return this.row; }
  getColumn() { return this.col; }
  getLastRow() { return this.row + this.numRows - 1; }
  getNumRows() { return this.numRows; }
  getA1Notation() {
    const colLetter = c => {
      let s = '';
      let n = c;
      while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    };
    const start = colLetter(this.col) + this.row;
    if (this.numRows === 1 && this.numCols === 1) return start;
    const end = colLetter(this.col + this.numCols - 1) + (this.row + this.numRows - 1);
    return `${start}:${end}`;
  }
}

class MockSheet {
  constructor(name, rows) {
    this.name = name;
    this._data = (rows || []).map(r => r.slice());
    this._stats = { setValueCalls: 0, setValuesCalls: 0, clearContentCalls: 0, clearContentsCalls: 0, appendRowCalls: 0 };
    this._formats = [];
    this._validations = [];
    this._condRules = [];
    this._activeRange = null;
  }

  getName() { return this.name; }
  getLastRow() {
    for (let i = this._data.length - 1; i >= 0; i--) {
      if (this._data[i] && this._data[i].some(v => v !== '' && v !== null && v !== undefined)) {
        return i + 1;
      }
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    for (const r of this._data) {
      if (r && r.length > max) max = r.length;
    }
    return max;
  }
  getMaxRows() { return Math.max(1000, this._data.length); }
  getDataRange() {
    const lr = Math.max(1, this.getLastRow());
    const lc = Math.max(1, this.getLastColumn());
    return new MockRange(this, 1, 1, lr, lc);
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new MockRange(this, row, col, numRows, numCols);
  }
  appendRow(rowArr) {
    this._stats.appendRowCalls++;
    this._data.push(rowArr.slice());
    return this;
  }
  clearContents() {
    this._stats.clearContentsCalls++;
    this._data = [];
    return this;
  }
  getConditionalFormatRules() { return this._condRules.slice(); }
  setConditionalFormatRules(rules) { this._condRules = rules.slice(); }
  getActiveRange() { return this._activeRange; }
  setActiveRange(row, numRows) {
    this._activeRange = new MockRange(this, row, 1, numRows, Math.max(1, this.getLastColumn()));
  }
}

function loadCode(opts = {}) {
  const sheets = new Map();
  const initialSheets = opts.sheets || {};
  for (const [name, rows] of Object.entries(initialSheets)) {
    sheets.set(name, new MockSheet(name, rows));
  }

  let activeSheetName = opts.activeSheet || 'Roster';
  const uiAlerts = [];
  const uiConfirmResponse = opts.uiConfirmResponse !== undefined ? opts.uiConfirmResponse : 'YES';

  const mockUi = {
    ButtonSet: { YES_NO: 'YES_NO', OK: 'OK' },
    Button: { YES: 'YES', NO: 'NO', OK: 'OK' },
    alert(title, body, buttons) {
      uiAlerts.push({ title, body, buttons });
      return uiConfirmResponse;
    },
    createMenu() {
      const m = { addItem() { return m; }, addSeparator() { return m; }, addToUi() {} };
      return m;
    }
  };

  const ss = {
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) {
      const s = new MockSheet(name, []);
      sheets.set(name, s);
      return s;
    },
    getActiveSheet() { return sheets.get(activeSheetName) || null; },
    setActiveSheetByName(name) { activeSheetName = name; },
    _sheets: sheets
  };

  const cacheStore = new Map();
  const cache = {
    get(k) {
      const entry = cacheStore.get(k);
      if (!entry) return null;
      if (entry.exp && Date.now() > entry.exp) {
        cacheStore.delete(k);
        return null;
      }
      return entry.val;
    },
    put(k, v, ttlSec) {
      cacheStore.set(k, { val: String(v), exp: ttlSec ? Date.now() + ttlSec * 1000 : null });
    },
    remove(k) { cacheStore.delete(k); },
    _store: cacheStore
  };

  let lockHeld = Boolean(opts.lockHeld);
  const lock = {
    tryLock() {
      if (lockHeld) return false;
      lockHeld = true;
      return true;
    },
    releaseLock() { lockHeld = false; },
    _setHeld(v) { lockHeld = v; }
  };

  let remainingQuota = opts.emailQuota !== undefined ? opts.emailQuota : 100;
  const sentEmails = [];
  const failEmails = new Set(opts.failEmails || []);
  const MailApp = {
    getRemainingDailyQuota() { return remainingQuota; },
    sendEmail(params) {
      if (remainingQuota <= 0) throw new Error('Service invoked too many times for one day: email.');
      if (failEmails.has(params.to)) throw new Error('Invalid email: ' + params.to);
      remainingQuota--;
      sentEmails.push(params);
    }
  };

  const sleeps = [];
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256', SHA256: 'SHA_256' },
    computeDigest(_alg, input) {
      const buf = crypto.createHash('sha256').update(String(input), 'utf8').digest();
      return Array.from(buf, b => (b > 127 ? b - 256 : b));
    },
    base64EncodeWebSafe(str) {
      return Buffer.from(String(str), 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    base64DecodeWebSafe(b64) {
      let s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return Array.from(Buffer.from(s, 'base64'));
    },
    newBlob(bytes) {
      return {
        getDataAsString() { return Buffer.from(bytes).toString('utf8'); },
        setName(n) { this.name = n; return this; }
      };
    },
    formatDate(date, _tz, fmt) {
      const d = new Date(date);
      const pad = n => String(n).padStart(2, '0');
      if (fmt === 'HH:mm:ss') {
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }
      return d.toISOString();
    },
    sleep(ms) { sleeps.push(ms); },
    getUuid() { return crypto.randomUUID(); }
  };

  const triggers = [];
  const ScriptApp = {
    getProjectTriggers() { return triggers.slice(); },
    newTrigger(fn) {
      return {
        timeBased() {
          return {
            everyMinutes(m) {
              return {
                create() {
                  const t = { getHandlerFunction: () => fn, everyMinutes: m };
                  triggers.push(t);
                  return t;
                }
              };
            }
          };
        },
        forSpreadsheet() {
          return {
            onEdit() {
              return {
                create() {
                  const t = { getHandlerFunction: () => fn, eventType: 'ON_EDIT' };
                  triggers.push(t);
                  return t;
                }
              };
            }
          };
        }
      };
    },
    deleteTrigger(t) {
      const i = triggers.indexOf(t);
      if (i >= 0) triggers.splice(i, 1);
    }
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ss,
    getUi: () => mockUi,
    newDataValidation: () => {
      const b = { requireValueInList() { return b; }, setAllowInvalid() { return b; }, build() { return { type: 'list' }; } };
      return b;
    },
    newConditionalFormatRule: () => {
      const r = {
        whenTextEqualTo() { return r; },
        whenTextStartsWith() { return r; },
        setBackground() { return r; },
        setFontColor() { return r; },
        setRanges(ranges) { r._ranges = ranges; return r; },
        build() { return { getRanges: () => r._ranges || [] }; }
      };
      return r;
    }
  };

  const UrlFetchApp = {
    fetch(url) {
      return {
        getBlob() {
          return { setName(name) { return { name, url }; } };
        }
      };
    }
  };

  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createHtmlOutputFromFile(name) {
      const out = { name, meta: [], xframe: 'DEFAULT' };
      out.setTitle = t => { out.title = t; return out; };
      out.setXFrameOptionsMode = m => { out.xframe = m; return out; };
      out.addMetaTag = (k, v) => { out.meta.push([k, v]); return out; };
      return out;
    }
  };

  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput(content) {
      const out = { _content: String(content || ''), _mime: 'text/plain' };
      out.setMimeType = m => { out._mime = m; return out; };
      out.getContent = () => out._content;
      out.getMimeType = () => out._mime;
      return out;
    }
  };

  const context = {
    SpreadsheetApp,
    Utilities,
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => cache },
    Session: { getScriptTimeZone: () => 'Asia/Singapore' },
    MailApp,
    UrlFetchApp,
    HtmlService,
    ContentService,
    ScriptApp,
    console,
    Date,
    Math,
    JSON,
    RegExp,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    encodeURIComponent
  };

  vm.createContext(context);
  const codePath = path.resolve(__dirname, '..', '..', 'Code.js');
  const code = fs.readFileSync(codePath, 'utf8');
  vm.runInContext(code, context, { filename: 'Code.js' });

  return {
    ctx: context,
    ss,
    sheets,
    cache,
    lock,
    sentEmails,
    uiAlerts,
    sleeps,
    triggers
  };
}

module.exports = { loadCode };
