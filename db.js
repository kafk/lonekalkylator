// ── LÖNEKALKYLATOR — LOKAL SQLITE (sql.js + IndexedDB) & SPLIT GITHUB GIST SYNC ──
// Separat modul så databas- och synklogik ligger fristående från index.html.
// I GitHub Gist sparas datan uppdelad i separata filer per modul + en separat backup-snapshot,
// så om en fil blir korrupt fortsätter övriga filer fungera och kan återställas.

(function () {
  const SQLITE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/';
  const IDB_NAME = 'lonekalkylator_sqlite';
  const IDB_STORE = 'files';
  const IDB_KEY = 'main_db';
  const GIST_CFG_KEY = 'lonekalkylator_gist_cfg';
  const GIST_DESC = 'Lönekalkylator — Privat molnsynk';

  const MODULE_FILES = [
    'kalkyl.json',
    'lan_summering.json',
    'bank_rates.json',
    'delad_ekonomi.json',
    'analys_years.json',
    'fakturor.json'
  ];

  let SQLModule = null;
  let sqliteDb = null;
  let sqliteReady = false;
  let _hydrating = false;
  let _sqliteSyncTimer = null;
  let _gistPushTimer = null;
  let _gistBusy = false;
  let sqliteByteSize = 0;
  let sqliteLastSaved = null;
  let localUpdatedAt = null;

  const SQLITE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      rate REAL NOT NULL,
      amort_pct REAL NOT NULL,
      extra_amort REAL NOT NULL DEFAULT 0,
      rent REAL NOT NULL DEFAULT 0,
      property_value REAL NOT NULL DEFAULT 0,
      current_property_value REAL NOT NULL DEFAULT 0,
      is_new_build INTEGER NOT NULL DEFAULT 0,
      start_year INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bank_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      rorlig REAL NOT NULL,
      y1 REAL NOT NULL,
      y2 REAL NOT NULL,
      y3 REAL NOT NULL,
      negotiating INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS shared_expenses (
      id INTEGER PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      split_a REAL NOT NULL,
      loan_id INTEGER,
      item_type TEXT,
      preset_name TEXT
    );
    CREATE TABLE IF NOT EXISTS analys_years (
      year INTEGER PRIMARY KEY,
      est_a TEXT NOT NULL,
      est_b TEXT NOT NULL,
      act_a TEXT NOT NULL,
      act_b TEXT NOT NULL,
      est TEXT NOT NULL,
      act TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY,
      desc TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS estimates (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      date TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_json TEXT NOT NULL
    );
  `;

  // ── INDEXEDDB HELPERS ──
  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB saknas')); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetDbBytes() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSaveDbBytes(bytes) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbClearDb() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── GIST CONFIG (sparas bara lokalt i browsern — aldrig i Gisten) ──
  function getGistCfg() {
    try {
      return JSON.parse(localStorage.getItem(GIST_CFG_KEY) || 'null') || { token: '', gistId: '', autoSync: true, lastSyncedAt: null };
    } catch (e) {
      return { token: '', gistId: '', autoSync: true, lastSyncedAt: null };
    }
  }

  function saveGistCfg(cfg) {
    try { localStorage.setItem(GIST_CFG_KEY, JSON.stringify(cfg)); } catch (e) { }
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ── UI STATUS HELPERS ──
  function setDbStatusUI(state, text) {
    ['dbStatusDot', 'dbModalDot'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.className = 'db-dot ' + state;
    });
    const statusText = document.getElementById('dbModalStatusText');
    if (statusText && text) statusText.textContent = text;

    const cfg = getGistCfg();
    const navLabel = document.getElementById('dbNavLabel');
    if (navLabel) {
      if (_gistBusy) navLabel.textContent = 'Synkar…';
      else if (cfg.token && cfg.gistId && state === 'ready') navLabel.textContent = 'Synkad';
      else if (state === 'ready') navLabel.textContent = 'SQLite';
      else if (state === 'loading') navLabel.textContent = 'SQLite…';
      else navLabel.textContent = 'Offline';
    }

    const metaEl = document.getElementById('dbModalMeta');
    if (metaEl && sqliteReady) {
      const kb = (sqliteByteSize / 1024).toFixed(1) + ' KB';
      const timeStr = sqliteLastSaved ? ' · sparad ' + sqliteLastSaved.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      metaEl.textContent = kb + timeStr;
    }
  }

  function setGistStatusUI(state, text) {
    const dot = document.getElementById('gistStatusDot');
    const lbl = document.getElementById('gistStatusText');
    const link = document.getElementById('gistOpenLink');
    if (dot) dot.className = 'db-dot ' + state;
    if (lbl && text) lbl.textContent = text;
    const cfg = getGistCfg();
    if (link) {
      if (cfg.gistId) {
        link.href = 'https://gist.github.com/' + encodeURIComponent(cfg.gistId);
        link.style.display = 'inline-flex';
      } else {
        link.style.display = 'none';
      }
    }
    setDbStatusUI(sqliteReady ? 'ready' : 'loading');
  }

  function showDbFeedback(msg, isErr) {
    const el = document.getElementById('dbFeedback');
    if (!el) return;
    el.textContent = msg;
    el.className = 'db-feedback ' + (isErr ? 'err' : 'ok');
  }

  function showGistFeedback(msg, kind) {
    const el = document.getElementById('gistFeedback');
    if (!el) return;
    el.textContent = msg;
    el.className = 'db-feedback ' + (kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'ok');
  }

  // ── APP STATE <-> SPLIT MODULE OBJECTS ──
  function collectSplitModules() {
    const kalkylData = typeof loadData === 'function' ? loadData() : { estimates: [], outcomes: [] };
    return {
      'kalkyl.json': {
        revenue: parseNum(document.getElementById('revenue')?.value || '0'),
        salary: parseNum(document.getElementById('salary')?.value || '0'),
        costs: parseNum(document.getElementById('costs')?.value || '0'),
        desiredDividend: parseNum(document.getElementById('desiredDividend')?.value || '0'),
        birthYear: parseInt(document.getElementById('birthYear')?.value) || 1986,
        municipalityIndex: document.getElementById('municipality')?.selectedIndex ?? 0,
        churchMember: !!document.getElementById('churchMember')?.checked,
        momsPeriod: typeof momsPeriod !== 'undefined' ? momsPeriod : 'kvartal',
        pocketPeriod: typeof _pocketPeriod !== 'undefined' ? _pocketPeriod : 'month',
        estimates: kalkylData.estimates || [],
        outcomes: kalkylData.outcomes || []
      },
      'lan_summering.json': {
        loans: (typeof loans !== 'undefined' ? loans : []).map(l => ({
          id: l.id,
          type: l.type || 'Bolån',
          amount: Number(l.amount) || 0,
          rate: Number(l.rate) || 0,
          amortPct: Number(l.amortPct) || 0,
          extraAmort: Number(l.extraAmort) || 0,
          rent: Number(l.rent) || 0,
          propertyValue: Number(l.propertyValue) || 0,
          currentPropertyValue: Number(l.currentPropertyValue !== undefined ? l.currentPropertyValue : l.propertyValue) || 0,
          isNewBuild: !!l.isNewBuild,
          startYear: Number(l.startYear) || new Date().getFullYear()
        })),
        summering: {
          nameA: document.getElementById('personAName')?.value || 'Person A',
          nameB: document.getElementById('personBName')?.value || 'Person B',
          ownerPct: String(document.getElementById('ownerASlider')?.value || '80'),
          salaryA: document.getElementById('salaryA')?.value || '',
          salaryB: document.getElementById('salaryB')?.value || '',
          insatsA: document.getElementById('insatsA')?.value || '',
          insatsB: document.getElementById('insatsB')?.value || ''
        },
        extraAmort: {
          loanId: document.getElementById('extraLoanSelect')?.value || '',
          amount: document.getElementById('extraAmount')?.value || '2 000 kr',
          payer: document.getElementById('extraPayer')?.value || 'A'
        }
      },
      'bank_rates.json': {
        banks: (typeof BANKS !== 'undefined' ? BANKS : []).map(b => ({
          name: b.name || 'Bank',
          rorlig: Number(b.rorlig) || 0,
          y1: Number(b.y1) || 0,
          y2: Number(b.y2) || 0,
          y3: Number(b.y3) || 0,
          negotiating: !!b.negotiating
        }))
      },
      'delad_ekonomi.json': {
        expenses: (typeof deExpenses !== 'undefined' ? deExpenses : []).map(e => {
          const item = {
            id: e.id,
            name: e.name || '',
            category: e.category || 'Övrigt',
            amount: Number(e.amount) || 0,
            splitA: Number(e.splitA) || 0
          };
          if (e._loanId !== undefined) item._loanId = e._loanId;
          if (e._type) item._type = e._type;
          if (e._preset) item._preset = e._preset;
          return item;
        })
      },
      'analys_years.json': {
        years: (typeof analysYears !== 'undefined' ? analysYears : []).map(y => ({
          year: Number(y.year),
          estA: y.estA || Array(12).fill(''),
          estB: y.estB || Array(12).fill(''),
          actA: y.actA || Array(12).fill(''),
          actB: y.actB || Array(12).fill(''),
          est: y.est || Array(12).fill(''),
          act: y.act || Array(12).fill('')
        }))
      },
      'fakturor.json': {
        invoices: (typeof fakturor !== 'undefined' ? fakturor : []).map(f => ({
          id: f.id,
          desc: f.desc || 'Faktura',
          amount: Number(f.amount) || 0,
          date: f.date || '',
          paid: !!f.paid
        }))
      }
    };
  }

  function applySplitModulesToApp(mods) {
    _hydrating = true;
    try {
      // 1. Kalkyl
      const k = mods['kalkyl.json'];
      if (k && typeof k === 'object') {
        const rev = Number(k.revenue);
        const sal = Number(k.salary);
        const cst = Number(k.costs);
        const div = Number(k.desiredDividend);
        const by = parseInt(k.birthYear) || 1986;
        const mIdx = parseInt(k.municipalityIndex);
        const church = !!k.churchMember;

        if (!isNaN(rev)) {
          document.getElementById('revenue').value = formatNum(rev);
          document.getElementById('revenueSlider').value = rev;
        }
        if (!isNaN(sal)) {
          document.getElementById('salary').value = formatNum(sal);
          document.getElementById('salarySlider').value = sal;
        }
        if (!isNaN(cst)) {
          document.getElementById('costs').value = formatNum(cst);
          document.getElementById('costsSlider').value = cst;
        }
        if (!isNaN(div)) {
          document.getElementById('desiredDividend').value = formatNum(div);
          document.getElementById('desiredDividendSlider').value = div;
        }
        document.getElementById('birthYear').value = by;
        const munEl = document.getElementById('municipality');
        if (munEl && !isNaN(mIdx) && mIdx >= 0 && mIdx < munEl.options.length) {
          munEl.selectedIndex = mIdx;
        }
        document.getElementById('churchMember').checked = church;
        if (k.momsPeriod) momsPeriod = k.momsPeriod;
        if (k.pocketPeriod) _pocketPeriod = k.pocketPeriod;

        localStorage.setItem('ab_kalkyl_inputs', JSON.stringify({
          revenue: rev, salary: sal, costs: cst, desiredDividend: div,
          birthYear: by, municipalityIndex: isNaN(mIdx) ? 0 : mIdx, churchMember: church
        }));
        localStorage.setItem('ab_moms_period', momsPeriod);
        localStorage.setItem('pocket_period', _pocketPeriod);
        localStorage.setItem('ab_kalkyl_data', JSON.stringify({
          estimates: Array.isArray(k.estimates) ? k.estimates : [],
          outcomes: Array.isArray(k.outcomes) ? k.outcomes : []
        }));
      }

      // 2. Lån & Summering
      const ls = mods['lan_summering.json'];
      if (ls && typeof ls === 'object') {
        if (Array.isArray(ls.loans)) {
          loans = ls.loans.map(l => ({
            ...l,
            currentPropertyValue: l.type === 'Bolån'
              ? (l.currentPropertyValue !== undefined ? l.currentPropertyValue : (l.propertyValue || 3000000))
              : (l.currentPropertyValue || 0),
            isNewBuild: !!l.isNewBuild,
            _extraA: 0,
            _extraB: 0
          }));
          loanIdCounter = loans.length ? Math.max(...loans.map(l => l.id)) + 1 : 1;
          localStorage.setItem('ab_loans', JSON.stringify(loans));
        }
        if (ls.summering && typeof ls.summering === 'object') {
          const s = ls.summering;
          const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
          setVal('personAName', s.nameA || 'Person A');
          setVal('personBName', s.nameB || 'Person B');
          setVal('ownerASlider', s.ownerPct || '80');
          setVal('salaryA', s.salaryA || '');
          setVal('salaryB', s.salaryB || '');
          setVal('insatsA', s.insatsA || '');
          setVal('insatsB', s.insatsB || '');
          localStorage.setItem('summering_data', JSON.stringify(s));
        }
        if (ls.extraAmort && typeof ls.extraAmort === 'object') {
          localStorage.setItem('extra_amort_data', JSON.stringify(ls.extraAmort));
        }
      }

      // 3. Bankräntor
      const br = mods['bank_rates.json'];
      if (br && Array.isArray(br.banks) && br.banks.length > 0) {
        BANKS = br.banks.map(b => ({ ...b, negotiating: !!b.negotiating }));
        localStorage.setItem('bank_rates', JSON.stringify(BANKS));
      }

      // 4. Delad ekonomi
      const de = mods['delad_ekonomi.json'];
      if (de && Array.isArray(de.expenses)) {
        deExpenses = de.expenses.map(e => ({ ...e }));
        deIdCounter = deExpenses.length ? Math.max(...deExpenses.map(e => e.id)) + 1 : 1;
        localStorage.setItem('de_expenses', JSON.stringify(deExpenses));
      }

      // 5. Analysår
      const ay = mods['analys_years.json'];
      if (ay && Array.isArray(ay.years)) {
        analysYears = ay.years.map(y => ({ ...y }));
        localStorage.setItem('analys_years', JSON.stringify(analysYears));
      }

      // 6. Fakturor
      const fk = mods['fakturor.json'];
      if (fk && Array.isArray(fk.invoices)) {
        fakturor = fk.invoices.map(f => ({ ...f, paid: !!f.paid }));
        fakIdCounter = fakturor.length ? Math.max(...fakturor.map(f => f.id)) + 1 : 1;
        localStorage.setItem('fakturor', JSON.stringify(fakturor));
      }

      // Re-render all UI components
      rerenderAllAppViews();
    } finally {
      _hydrating = false;
    }
  }

  function rerenderAllAppViews() {
    updateTaxDisplay();
    setMomsPeriod(momsPeriod);
    setPocketPeriod(_pocketPeriod);
    renderLoanPage();
    if (typeof restoreExtraAmort === 'function') restoreExtraAmort();
    renderBankRates();
    renderDelad();
    renderAnalysYears();
    renderFaktura();
    if (document.getElementById('page-analys')?.classList.contains('active')) {
      renderLoanLineChart();
      renderLtvMonthTable();
      renderLtvCostTable();
    }
  }

  // ── SQLITE READ / WRITE ──
  function writeAppStateToSqlite(db, timestampOverride) {
    const now = timestampOverride || new Date().toISOString();
    localUpdatedAt = now;
    const mods = collectSplitModules();
    const k = mods['kalkyl.json'];
    const ls = mods['lan_summering.json'];
    const s = ls.summering;
    const ea = ls.extraAmort;

    const settingsEntries = [
      ['revenue', String(k.revenue)],
      ['salary', String(k.salary)],
      ['costs', String(k.costs)],
      ['desiredDividend', String(k.desiredDividend)],
      ['birthYear', String(k.birthYear)],
      ['municipalityIndex', String(k.municipalityIndex)],
      ['churchMember', k.churchMember ? '1' : '0'],
      ['momsPeriod', k.momsPeriod],
      ['pocketPeriod', k.pocketPeriod],
      ['nameA', s.nameA],
      ['nameB', s.nameB],
      ['ownerPct', s.ownerPct],
      ['salaryA', s.salaryA],
      ['salaryB', s.salaryB],
      ['insatsA', s.insatsA],
      ['insatsB', s.insatsB],
      ['extraLoanId', ea.loanId],
      ['extraAmount', ea.amount],
      ['extraPayer', ea.payer]
    ];

    db.run('BEGIN TRANSACTION;');
    try {
      db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?);', ['schema_version', '1']);
      db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?);', ['updated_at', now]);

      db.run('DELETE FROM settings;');
      settingsEntries.forEach(([key, val]) => {
        db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?);', [key, val, now]);
      });

      db.run('DELETE FROM loans;');
      ls.loans.forEach(l => {
        db.run(
          'INSERT INTO loans (id, type, amount, rate, amort_pct, extra_amort, rent, property_value, current_property_value, is_new_build, start_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
          [l.id, l.type, l.amount, l.rate, l.amortPct, l.extraAmort, l.rent, l.propertyValue, l.currentPropertyValue, l.isNewBuild ? 1 : 0, l.startYear]
        );
      });

      db.run('DELETE FROM bank_rates;');
      mods['bank_rates.json'].banks.forEach((b, idx) => {
        db.run(
          'INSERT INTO bank_rates (sort_order, name, rorlig, y1, y2, y3, negotiating) VALUES (?, ?, ?, ?, ?, ?, ?);',
          [idx, b.name, b.rorlig, b.y1, b.y2, b.y3, b.negotiating ? 1 : 0]
        );
      });

      db.run('DELETE FROM shared_expenses;');
      mods['delad_ekonomi.json'].expenses.forEach((e, idx) => {
        db.run(
          'INSERT INTO shared_expenses (id, sort_order, name, category, amount, split_a, loan_id, item_type, preset_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
          [e.id, idx, e.name, e.category, e.amount, e.splitA, e._loanId !== undefined ? e._loanId : null, e._type || null, e._preset || null]
        );
      });

      db.run('DELETE FROM analys_years;');
      mods['analys_years.json'].years.forEach(y => {
        db.run(
          'INSERT INTO analys_years (year, est_a, est_b, act_a, act_b, est, act) VALUES (?, ?, ?, ?, ?, ?, ?);',
          [y.year, JSON.stringify(y.estA), JSON.stringify(y.estB), JSON.stringify(y.actA), JSON.stringify(y.actB), JSON.stringify(y.est), JSON.stringify(y.act)]
        );
      });

      db.run('DELETE FROM invoices;');
      mods['fakturor.json'].invoices.forEach(f => {
        db.run('INSERT INTO invoices (id, desc, amount, date, paid) VALUES (?, ?, ?, ?, ?);', [f.id, f.desc, f.amount, f.date, f.paid ? 1 : 0]);
      });

      db.run('DELETE FROM estimates;');
      k.estimates.forEach(est => {
        db.run('INSERT INTO estimates (id, label, date, snapshot_json) VALUES (?, ?, ?, ?);', [est.id || Date.now(), est.label || '', est.date || '', JSON.stringify(est.snapshot || {})]);
      });

      db.run('DELETE FROM outcomes;');
      k.outcomes.forEach(out => {
        db.run('INSERT INTO outcomes (data_json) VALUES (?);', [JSON.stringify(out)]);
      });

      db.run('COMMIT;');
    } catch (err) {
      try { db.run('ROLLBACK;'); } catch (e) { }
      throw err;
    }
  }

  function queryRows(db, sql) {
    const res = db.exec(sql);
    if (!res || res.length === 0) return [];
    const cols = res[0].columns;
    return res[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });
  }

  function hydrateAppFromSqlite(db) {
    const settingsMap = {};
    queryRows(db, 'SELECT key, value FROM settings;').forEach(r => { settingsMap[r.key] = r.value; });
    const metaRows = queryRows(db, "SELECT value FROM meta WHERE key = 'updated_at';");
    if (metaRows.length > 0) {
      localUpdatedAt = metaRows[0].value;
      sqliteLastSaved = new Date(localUpdatedAt);
    }

    const estRows = queryRows(db, 'SELECT * FROM estimates ORDER BY id;');
    const outRows = queryRows(db, 'SELECT * FROM outcomes ORDER BY id;');

    const mods = {};
    if (Object.keys(settingsMap).length > 0) {
      mods['kalkyl.json'] = {
        revenue: Number(settingsMap.revenue),
        salary: Number(settingsMap.salary),
        costs: Number(settingsMap.costs),
        desiredDividend: Number(settingsMap.desiredDividend),
        birthYear: parseInt(settingsMap.birthYear) || 1986,
        municipalityIndex: parseInt(settingsMap.municipalityIndex) || 0,
        churchMember: settingsMap.churchMember === '1',
        momsPeriod: settingsMap.momsPeriod || 'kvartal',
        pocketPeriod: settingsMap.pocketPeriod || 'month',
        estimates: estRows.map(r => ({ id: r.id, label: r.label, date: r.date, snapshot: JSON.parse(r.snapshot_json || '{}') })),
        outcomes: outRows.map(r => JSON.parse(r.data_json || '{}'))
      };
    }

    const loanRows = queryRows(db, 'SELECT * FROM loans ORDER BY id;');
    mods['lan_summering.json'] = {
      loans: loanRows.map(r => ({
        id: r.id, type: r.type, amount: r.amount, rate: r.rate, amortPct: r.amort_pct,
        extraAmort: r.extra_amort, rent: r.rent, propertyValue: r.property_value,
        currentPropertyValue: r.current_property_value, isNewBuild: !!r.is_new_build, startYear: r.start_year
      })),
      summering: {
        nameA: settingsMap.nameA || 'Person A',
        nameB: settingsMap.nameB || 'Person B',
        ownerPct: settingsMap.ownerPct || '80',
        salaryA: settingsMap.salaryA || '',
        salaryB: settingsMap.salaryB || '',
        insatsA: settingsMap.insatsA || '',
        insatsB: settingsMap.insatsB || ''
      },
      extraAmort: {
        loanId: settingsMap.extraLoanId || '',
        amount: settingsMap.extraAmount || '2 000 kr',
        payer: settingsMap.extraPayer || 'A'
      }
    };

    const bankRows = queryRows(db, 'SELECT * FROM bank_rates ORDER BY sort_order, id;');
    if (bankRows.length > 0) {
      mods['bank_rates.json'] = {
        banks: bankRows.map(r => ({ name: r.name, rorlig: r.rorlig, y1: r.y1, y2: r.y2, y3: r.y3, negotiating: !!r.negotiating }))
      };
    }

    const expRows = queryRows(db, 'SELECT * FROM shared_expenses ORDER BY sort_order, id;');
    mods['delad_ekonomi.json'] = {
      expenses: expRows.map(r => {
        const item = { id: r.id, name: r.name, category: r.category, amount: r.amount, splitA: r.split_a };
        if (r.loan_id !== null && r.loan_id !== undefined) item._loanId = r.loan_id;
        if (r.item_type) item._type = r.item_type;
        if (r.preset_name) item._preset = r.preset_name;
        return item;
      })
    };

    const ayRows = queryRows(db, 'SELECT * FROM analys_years ORDER BY year DESC;');
    mods['analys_years.json'] = {
      years: ayRows.map(r => ({
        year: r.year,
        estA: JSON.parse(r.est_a || '[]'),
        estB: JSON.parse(r.est_b || '[]'),
        actA: JSON.parse(r.act_a || '[]'),
        actB: JSON.parse(r.act_b || '[]'),
        est: JSON.parse(r.est || '[]'),
        act: JSON.parse(r.act || '[]')
      }))
    };

    const invRows = queryRows(db, 'SELECT * FROM invoices ORDER BY date DESC, id DESC;');
    mods['fakturor.json'] = {
      invoices: invRows.map(r => ({ id: r.id, desc: r.desc, amount: r.amount, date: r.date, paid: !!r.paid }))
    };

    applySplitModulesToApp(mods);
  }

  async function persistSqliteNow(timestampOverride) {
    if (!sqliteReady || !sqliteDb) return;
    try {
      writeAppStateToSqlite(sqliteDb, timestampOverride);
      const bytes = sqliteDb.export();
      sqliteByteSize = bytes.byteLength;
      sqliteLastSaved = new Date(localUpdatedAt || Date.now());
      await idbSaveDbBytes(bytes);
      setDbStatusUI('ready', 'SQLite aktiv (IndexedDB)');
      if (document.getElementById('dbModal')?.classList.contains('open')) renderDbStats();
    } catch (err) {
      console.error('SQLite save failed:', err);
      setDbStatusUI('error', 'Kunde inte spara till SQLite');
    }
  }

  function scheduleSqliteSync() {
    if (_hydrating) return;
    clearTimeout(_sqliteSyncTimer);
    if (sqliteReady) {
      _sqliteSyncTimer = setTimeout(() => { persistSqliteNow(); }, 250);
    }
    const cfg = getGistCfg();
    if (cfg.token && cfg.gistId && cfg.autoSync) {
      clearTimeout(_gistPushTimer);
      _gistPushTimer = setTimeout(() => { pushToGist(true); }, 1600);
    }
  }

  function flushSqliteSync() {
    if (!sqliteReady || !sqliteDb) return;
    clearTimeout(_sqliteSyncTimer);
    writeAppStateToSqlite(sqliteDb);
    const bytes = sqliteDb.export();
    sqliteByteSize = bytes.byteLength;
    sqliteLastSaved = new Date(localUpdatedAt || Date.now());
    idbSaveDbBytes(bytes).catch(() => { });
    setDbStatusUI('ready', 'SQLite aktiv (IndexedDB)');
  }

  // ── GITHUB GIST MULTI-FILE SYNC (SEPARATA FILER + BACKUP-SNAPSHOT) ──
  async function gistApiFetch(url, token, options) {
    const opts = Object.assign({ method: 'GET' }, options || {});
    opts.headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token.trim()
    }, opts.headers || {});
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = res.status + ' ' + res.statusText;
      try {
        const errJson = await res.json();
        if (errJson.message) detail = errJson.message;
      } catch (e) { }
      throw new Error('GitHub API: ' + detail);
    }
    return res.json();
  }

  async function readGistFileText(fileObj) {
    if (!fileObj) return null;
    if (fileObj.truncated && fileObj.raw_url) {
      const r = await fetch(fileObj.raw_url);
      if (!r.ok) throw new Error('Kunde inte hämta ' + fileObj.filename);
      return r.text();
    }
    return fileObj.content || null;
  }

  function buildValidatedGistPayload(timestamp) {
    const mods = collectSplitModules();
    const files = {};
    const fileMeta = {};
    let allValid = true;

    MODULE_FILES.forEach(fname => {
      const jsonStr = JSON.stringify(mods[fname], null, 2);
      // Validate round-trip before writing so we never upload corrupt JSON
      JSON.parse(jsonStr);
      files[fname] = { content: jsonStr };
      fileMeta[fname] = { bytes: jsonStr.length, hash: simpleHash(jsonStr) };
    });

    const manifest = {
      app: 'lonekalkylator',
      schema_version: 2,
      updated_at: timestamp,
      files: fileMeta
    };
    files['manifest.json'] = { content: JSON.stringify(manifest, null, 2) };

    if (allValid) {
      const backupObj = {
        schema_version: 2,
        updated_at: timestamp,
        modules: mods
      };
      const backupStr = JSON.stringify(backupObj, null, 2);
      JSON.parse(backupStr);
      files['backup_snapshot.json'] = { content: backupStr };
    }

    return { files, manifest };
  }

  async function findExistingGist(token) {
    const list = await gistApiFetch('https://api.github.com/gists?per_page=100', token);
    if (!Array.isArray(list)) return null;
    return list.find(g => g.files && g.files['manifest.json'] && g.files['kalkyl.json']) || null;
  }

  async function pushToGist(isAuto) {
    const cfg = getGistCfg();
    if (!cfg.token) {
      if (!isAuto) showGistFeedback('Ange din GitHub-token först.', 'err');
      return false;
    }
    if (_gistBusy) return false;
    _gistBusy = true;
    setGistStatusUI('loading', 'Sparar separata filer till GitHub Gist…');

    try {
      const now = new Date().toISOString();
      const { files } = buildValidatedGistPayload(now);
      let gistData;

      if (cfg.gistId) {
        gistData = await gistApiFetch('https://api.github.com/gists/' + encodeURIComponent(cfg.gistId), cfg.token, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: GIST_DESC, files })
        });
      } else {
        gistData = await gistApiFetch('https://api.github.com/gists', cfg.token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: GIST_DESC, public: false, files })
        });
        cfg.gistId = gistData.id;
        const idInput = document.getElementById('gistIdInput');
        if (idInput) idInput.value = cfg.gistId;
      }

      cfg.lastSyncedAt = now;
      saveGistCfg(cfg);
      if (sqliteReady) await persistSqliteNow(now);

      const tStr = new Date(now).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      _gistBusy = false;
      setGistStatusUI('ready', 'Synkad (' + MODULE_FILES.length + ' filer + backup · ' + tStr + ')');
      renderGistFilesList(gistData.files);
      if (!isAuto) showGistFeedback('Sparade ' + MODULE_FILES.length + ' separata filer + backup_snapshot.json till din privata Gist.', 'ok');
      return true;
    } catch (err) {
      console.error('Gist push failed:', err);
      _gistBusy = false;
      setGistStatusUI('error', 'Synkfel: ' + err.message);
      if (!isAuto) showGistFeedback('Kunde inte spara till Gist: ' + err.message, 'err');
      return false;
    }
  }

  async function pullFromGist(silent) {
    const cfg = getGistCfg();
    if (!cfg.token || !cfg.gistId) {
      if (!silent) showGistFeedback('Koppla en GitHub-token och Gist först.', 'err');
      return false;
    }
    if (_gistBusy) return false;
    _gistBusy = true;
    setGistStatusUI('loading', 'Hämtar filer från GitHub Gist…');

    try {
      const gistData = await gistApiFetch('https://api.github.com/gists/' + encodeURIComponent(cfg.gistId), cfg.token);
      const remoteFiles = gistData.files || {};

      // Parse manifest & backup snapshot first (separately)
      let manifest = null;
      try {
        const mText = await readGistFileText(remoteFiles['manifest.json']);
        if (mText) manifest = JSON.parse(mText);
      } catch (e) { }

      let backupModules = null;
      try {
        const bText = await readGistFileText(remoteFiles['backup_snapshot.json']);
        if (bText) {
          const parsedBackup = JSON.parse(bText);
          if (parsedBackup && parsedBackup.modules) backupModules = parsedBackup.modules;
        }
      } catch (e) { }

      // Parse each module file independently so one corrupt file never breaks the rest!
      const loadedMods = {};
      const recoveredFiles = [];
      const failedFiles = [];

      for (const fname of MODULE_FILES) {
        try {
          const text = await readGistFileText(remoteFiles[fname]);
          if (!text) throw new Error('Fil saknas');
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object') throw new Error('Ogiltigt format');
          loadedMods[fname] = parsed;
        } catch (fileErr) {
          console.warn('Korrupt eller saknad fil i Gist:', fname, fileErr);
          if (backupModules && backupModules[fname]) {
            loadedMods[fname] = backupModules[fname];
            recoveredFiles.push(fname);
          } else {
            failedFiles.push(fname);
          }
        }
      }

      if (Object.keys(loadedMods).length === 0) {
        throw new Error('Inga giltiga datafiler hittades i Gisten.');
      }

      applySplitModulesToApp(loadedMods);
      const ts = manifest?.updated_at || gistData.updated_at || new Date().toISOString();
      cfg.lastSyncedAt = ts;
      saveGistCfg(cfg);
      if (sqliteReady) await persistSqliteNow(ts);

      const tStr = new Date(ts).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      _gistBusy = false;
      setGistStatusUI('ready', 'Synkad (' + Object.keys(loadedMods).length + '/' + MODULE_FILES.length + ' filer · ' + tStr + ')');
      renderGistFilesList(remoteFiles, recoveredFiles, failedFiles);

      if (recoveredFiles.length > 0 || failedFiles.length > 0) {
        const parts = [];
        if (recoveredFiles.length) parts.push('Återställde från backup_snapshot.json: ' + recoveredFiles.join(', '));
        if (failedFiles.length) parts.push('Kunde inte läsas (behöll lokalt): ' + failedFiles.join(', '));
        showGistFeedback('⚠ Delvis korrupt data hanterades automatiskt! ' + parts.join(' · '), 'warn');
      } else if (!silent) {
        showGistFeedback('Hämtade alla ' + MODULE_FILES.length + ' filer från din privata Gist.', 'ok');
      }
      return true;
    } catch (err) {
      console.error('Gist pull failed:', err);
      _gistBusy = false;
      setGistStatusUI('error', 'Hämtningsfel: ' + err.message);
      if (!silent) showGistFeedback('Kunde inte hämta från Gist: ' + err.message, 'err');
      return false;
    }
  }

  async function connectGistSync() {
    const token = (document.getElementById('gistTokenInput')?.value || '').trim();
    let gistId = (document.getElementById('gistIdInput')?.value || '').trim();
    const autoSync = !!document.getElementById('gistAutoSync')?.checked;

    if (!token) {
      showGistFeedback('Klistra in din GitHub-token (med behörighet "gist") först.', 'err');
      return;
    }

    // Extract ID if user pasted full gist URL
    if (gistId.includes('/')) {
      gistId = gistId.replace(/\/+$/, '').split('/').pop();
    }

    setGistStatusUI('loading', 'Ansluter till GitHub…');
    try {
      let existingGist = null;
      if (!gistId) {
        existingGist = await findExistingGist(token);
        if (existingGist) {
          gistId = existingGist.id;
          const idInput = document.getElementById('gistIdInput');
          if (idInput) idInput.value = gistId;
        }
      }

      const cfg = { token, gistId, autoSync, lastSyncedAt: null };
      saveGistCfg(cfg);

      if (gistId) {
        // Existing Gist found/specified -> pull first so a new device doesn't overwrite cloud data!
        const ok = await pullFromGist(true);
        if (ok) {
          showGistFeedback(
            existingGist
              ? 'Hittade din befintliga privata Gist automatiskt och hämtade all data!'
              : 'Kopplad till Gist ' + gistId.slice(0, 8) + '… och hämtade all data!',
            'ok'
          );
        }
      } else {
        // Brand new setup -> create secret Gist with split files
        const ok = await pushToGist(true);
        if (ok) {
          const newCfg = getGistCfg();
          showGistFeedback('Skapade ny privat Gist (' + newCfg.gistId.slice(0, 8) + '…) med ' + MODULE_FILES.length + ' separata filer + backup_snapshot.json!', 'ok');
        }
      }
    } catch (err) {
      setGistStatusUI('error', 'Kunde inte ansluta: ' + err.message);
      showGistFeedback('Anslutning misslyckades: ' + err.message, 'err');
    }
  }

  function disconnectGistSync() {
    if (!confirm('Koppla bort GitHub Gist-synk på denna enhet? Din data ligger kvar både lokalt i SQLite och i din Gist.')) return;
    clearTimeout(_gistPushTimer);
    localStorage.removeItem(GIST_CFG_KEY);
    const tEl = document.getElementById('gistTokenInput');
    const iEl = document.getElementById('gistIdInput');
    if (tEl) tEl.value = '';
    if (iEl) iEl.value = '';
    const fl = document.getElementById('gistFilesList');
    if (fl) fl.innerHTML = '';
    setGistStatusUI('', 'Ej kopplad (endast lokal SQLite)');
    showGistFeedback('Molnsynk bortkopplad på denna enhet.', 'ok');
  }

  function toggleGistAutoSync(checked) {
    const cfg = getGistCfg();
    cfg.autoSync = !!checked;
    saveGistCfg(cfg);
  }

  function renderGistFilesList(filesObj, recovered, failed) {
    const el = document.getElementById('gistFilesList');
    if (!el || !filesObj) return;
    const recSet = new Set(recovered || []);
    const failSet = new Set(failed || []);
    const allNames = [...MODULE_FILES, 'backup_snapshot.json', 'manifest.json'].filter(n => filesObj[n]);
    if (allNames.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML =
      '<div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Separata filer i din privata Gist</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
      allNames.map(name => {
        const sizeKb = ((filesObj[name].size || (filesObj[name].content || '').length) / 1024).toFixed(1);
        const badgeCol = failSet.has(name) ? 'var(--red)' : recSet.has(name) ? 'var(--warning)' : 'var(--accent)';
        const mark = failSet.has(name) ? '✕' : recSet.has(name) ? '↺' : '✓';
        return '<span style="font-family:\'DM Mono\',monospace;font-size:11px;padding:3px 8px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);display:inline-flex;align-items:center;gap:5px;">' +
          '<span style="color:' + badgeCol + ';font-weight:700;">' + mark + '</span>' +
          '<span>' + name + '</span>' +
          '<span style="color:var(--muted);font-size:10px;">' + sizeKb + ' KB</span>' +
          '</span>';
      }).join('') +
      '</div>';
  }

  async function syncOnStartupIfConfigured() {
    const cfg = getGistCfg();
    if (!cfg.token || !cfg.gistId) {
      setGistStatusUI('', 'Ej kopplad (endast lokal SQLite)');
      return;
    }
    try {
      const gistData = await gistApiFetch('https://api.github.com/gists/' + encodeURIComponent(cfg.gistId), cfg.token);
      renderGistFilesList(gistData.files);
      let remoteTs = gistData.updated_at || null;
      try {
        const mText = await readGistFileText(gistData.files?.['manifest.json']);
        if (mText) {
          const m = JSON.parse(mText);
          if (m.updated_at) remoteTs = m.updated_at;
        }
      } catch (e) { }

      const remoteTime = remoteTs ? Date.parse(remoteTs) : 0;
      const localTime = localUpdatedAt ? Date.parse(localUpdatedAt) : 0;

      if (remoteTime > localTime) {
        await pullFromGist(true);
      } else if (localTime > remoteTime && cfg.autoSync) {
        await pushToGist(true);
      } else {
        const tStr = remoteTs ? new Date(remoteTs).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '';
        setGistStatusUI('ready', 'Synkad (' + MODULE_FILES.length + ' filer + backup' + (tStr ? ' · ' + tStr : '') + ')');
      }
    } catch (err) {
      console.warn('Startup Gist check failed:', err);
      setGistStatusUI('error', 'Offline / ej nåbar (använder lokal SQLite)');
    }
  }

  function ensureDbMigrations(db) {
    db.run(SQLITE_SCHEMA);
    try { db.run('ALTER TABLE loans ADD COLUMN is_new_build INTEGER NOT NULL DEFAULT 0;'); } catch (e) { }
  }

  // ── INIT SQLITE + STARTUP SYNC ──
  async function initSqliteStore() {
    if (typeof initSqlJs !== 'function') {
      setDbStatusUI('error', 'SQLite offline (använder localStorage)');
      syncOnStartupIfConfigured();
      return;
    }
    try {
      SQLModule = await initSqlJs({ locateFile: file => SQLITE_CDN + file });
      const savedBytes = await idbGetDbBytes();
      if (savedBytes && savedBytes.byteLength > 0) {
        sqliteDb = new SQLModule.Database(new Uint8Array(savedBytes));
        ensureDbMigrations(sqliteDb);
        sqliteByteSize = savedBytes.byteLength;
        sqliteReady = true;
        hydrateAppFromSqlite(sqliteDb);
        setDbStatusUI('ready', 'SQLite aktiv (IndexedDB)');
      } else {
        sqliteDb = new SQLModule.Database();
        ensureDbMigrations(sqliteDb);
        sqliteReady = true;
        await persistSqliteNow();
      }
    } catch (err) {
      console.error('Failed to init SQLite:', err);
      setDbStatusUI('error', 'SQLite kunde inte laddas (använder localStorage)');
    }
    await syncOnStartupIfConfigured();
  }

  // ── MODAL, EXPORT, IMPORT, RESET, SQL CONSOLE ──
  function renderDbStats() {
    const grid = document.getElementById('dbStatsGrid');
    if (!grid || !sqliteDb) return;
    const countOf = tbl => {
      try {
        const r = sqliteDb.exec('SELECT COUNT(*) FROM ' + tbl + ';');
        return r[0]?.values[0]?.[0] ?? 0;
      } catch (e) { return 0; }
    };
    const items = [
      ['Inställningar', countOf('settings')],
      ['Lån', countOf('loans')],
      ['Bankräntor', countOf('bank_rates')],
      ['Delade kostn.', countOf('shared_expenses')],
      ['Analysår', countOf('analys_years')],
      ['Fakturor', countOf('invoices')],
      ['Estimat', countOf('estimates')]
    ];
    grid.innerHTML = items.map(([lbl, val]) =>
      '<div class="db-stat-box"><div class="db-stat-label">' + lbl + '</div><div class="db-stat-val">' + val + '</div></div>'
    ).join('');
  }

  function openDbModal() {
    const modal = document.getElementById('dbModal');
    if (!modal) return;
    ['dbFeedback', 'gistFeedback'].forEach(id => {
      const fb = document.getElementById(id);
      if (fb) fb.className = 'db-feedback';
    });
    const cfg = getGistCfg();
    const tEl = document.getElementById('gistTokenInput');
    const iEl = document.getElementById('gistIdInput');
    const aEl = document.getElementById('gistAutoSync');
    if (tEl && !tEl.value && cfg.token) tEl.value = cfg.token;
    if (iEl && cfg.gistId) iEl.value = cfg.gistId;
    if (aEl) aEl.checked = cfg.autoSync !== false;

    if (sqliteReady) {
      flushSqliteSync();
      renderDbStats();
    }
    modal.classList.add('open');
  }

  function closeDbModal() {
    document.getElementById('dbModal')?.classList.remove('open');
  }

  function exportSqliteFile() {
    if (!sqliteReady || !sqliteDb) {
      showDbFeedback('SQLite är inte redo ännu. Kontrollera internetanslutningen och försök igen.', true);
      return;
    }
    try {
      flushSqliteSync();
      const bytes = sqliteDb.export();
      const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = 'lonekalkylator-' + dateStr + '.sqlite';
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      renderDbStats();
      showDbFeedback('Exporterade ' + filename + ' (' + (bytes.byteLength / 1024).toFixed(1) + ' KB).', false);
    } catch (err) {
      showDbFeedback('Kunde inte exportera: ' + err.message, true);
    }
  }

  async function importSqliteFile(file) {
    if (!file) return;
    if (!sqliteReady || !SQLModule) {
      showDbFeedback('SQLite är inte laddat ännu.', true);
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const header = new TextDecoder().decode(bytes.slice(0, 16));
      if (!header.startsWith('SQLite format 3')) {
        showDbFeedback('Ogiltig fil — välj en giltig .sqlite/.db-fil.', true);
        return;
      }
      const nextDb = new SQLModule.Database(bytes);
      nextDb.exec("SELECT name FROM sqlite_master WHERE type='table';");
      ensureDbMigrations(nextDb);

      if (sqliteDb) sqliteDb.close();
      sqliteDb = nextDb;
      const exported = sqliteDb.export();
      sqliteByteSize = exported.byteLength;
      sqliteLastSaved = new Date();
      await idbSaveDbBytes(exported);
      hydrateAppFromSqlite(sqliteDb);
      setDbStatusUI('ready', 'SQLite aktiv (IndexedDB)');
      renderDbStats();
      showDbFeedback('Importerade ' + file.name + ' (' + (exported.byteLength / 1024).toFixed(1) + ' KB) — all data har laddats in.', false);
    } catch (err) {
      console.error('SQLite import failed:', err);
      showDbFeedback('Kunde inte importera databasen: ' + err.message, true);
    }
  }

  async function resetSqliteDb() {
    if (!confirm('Är du säker på att du vill nollställa hela den lokala databasen och återgå till standardvärden? Exportera gärna en .sqlite-backup först.')) {
      return;
    }
    try {
      clearTimeout(_sqliteSyncTimer);
      clearTimeout(_gistPushTimer);
      await idbClearDb();
      ['ab_kalkyl_inputs', 'ab_kalkyl_data', 'ab_loans', 'ab_moms_period', 'analys_years', 'bank_rates', 'de_expenses', 'fakturor', 'pocket_period', 'summering_data', 'extra_amort_data']
        .forEach(k => localStorage.removeItem(k));
      location.reload();
    } catch (err) {
      showDbFeedback('Kunde inte återställa: ' + err.message, true);
    }
  }

  function setSqlPreset(q) {
    const inp = document.getElementById('dbSqlInput');
    if (inp) inp.value = q;
    runCustomSql();
  }

  function runCustomSql() {
    const inp = document.getElementById('dbSqlInput');
    const out = document.getElementById('dbSqlOutput');
    if (!inp || !out) return;
    if (!sqliteReady || !sqliteDb) {
      out.textContent = 'SQLite är inte laddat ännu.';
      return;
    }
    const sql = inp.value.trim();
    if (!sql) return;
    out.innerHTML = '';
    try {
      const results = sqliteDb.exec(sql);
      const isReadOnly = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql);
      if (!isReadOnly) {
        const bytes = sqliteDb.export();
        sqliteByteSize = bytes.byteLength;
        sqliteLastSaved = new Date();
        idbSaveDbBytes(bytes).catch(() => { });
        hydrateAppFromSqlite(sqliteDb);
        renderDbStats();
        setDbStatusUI('ready', 'SQLite aktiv (IndexedDB)');
        scheduleSqliteSync();
      }
      if (!results || results.length === 0) {
        const p = document.createElement('div');
        p.style.cssText = 'color:var(--accent);padding:6px 0;';
        p.textContent = isReadOnly ? '0 rader returnerade.' : '✓ SQL körd och sparad.';
        out.appendChild(p);
        return;
      }
      results.forEach(res => {
        const table = document.createElement('table');
        table.className = 'db-sql-table';
        const thead = document.createElement('thead');
        const trH = document.createElement('tr');
        res.columns.forEach(col => {
          const th = document.createElement('th');
          th.textContent = col;
          trH.appendChild(th);
        });
        thead.appendChild(trH);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        res.values.forEach(row => {
          const tr = document.createElement('tr');
          row.forEach(val => {
            const td = document.createElement('td');
            td.textContent = val === null ? 'NULL' : String(val);
            td.title = td.textContent;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        out.appendChild(table);
      });
    } catch (err) {
      const p = document.createElement('div');
      p.style.cssText = 'color:var(--red);padding:6px 0;';
      p.textContent = 'SQL-fel: ' + err.message;
      out.appendChild(p);
    }
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDbModal();
  });

  window.addEventListener('beforeunload', () => {
    if (sqliteReady && sqliteDb && _sqliteSyncTimer) {
      try { flushSqliteSync(); } catch (e) { }
    }
  });

  window.addEventListener('load', () => {
    initSqliteStore();
  });

  // Expose global hooks used by index.html
  window.__scheduleSqliteSync = scheduleSqliteSync;
  window.scheduleSqliteSync = scheduleSqliteSync;
  window.openDbModal = openDbModal;
  window.closeDbModal = closeDbModal;
  window.exportSqliteFile = exportSqliteFile;
  window.importSqliteFile = importSqliteFile;
  window.resetSqliteDb = resetSqliteDb;
  window.setSqlPreset = setSqlPreset;
  window.runCustomSql = runCustomSql;
  window.connectGistSync = connectGistSync;
  window.disconnectGistSync = disconnectGistSync;
  window.pushToGist = pushToGist;
  window.pullFromGist = pullFromGist;
  window.toggleGistAutoSync = toggleGistAutoSync;
})();
