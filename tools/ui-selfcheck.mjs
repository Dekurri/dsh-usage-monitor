#!/usr/bin/env node
/**
 * Static self-check for the dsh-usage-monitor browser half.
 *
 * The plugin cannot be mounted in a browser from this workspace, so this script
 * verifies everything that *can* be verified without a DOM:
 *
 *  1. module-loader envelope (id / factory / require('react'))
 *  2. factory exports ({ name, inject, apply })
 *  3. apply() actually registers the sidebar entry and the main panel with the
 *     exact id/key contract, by executing apply() against stub services
 *  4. zh/en dictionaries have identical key sets and every referenced t() key
 *     (including SERIES/SESSION_COLUMNS labelKey literals) exists
 *  5. no user-visible hard-coded CJK outside the dictionaries/comments
 *  6. no forbidden constructs (iframe, document.body, hex colours, CDN urls,
 *     @deepseek-ai imports) and the line budget
 *  7. v2 data lines: the all-call ledger, the platform bill and the account
 *     login flow are referenced through the contract routes
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const clientPath = path.join(root, 'lib', 'client.js');
const packagePath = path.join(root, 'package.json');

const source = fs.readFileSync(clientPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const lines = source.split(/\r?\n/);

const failures = [];
const notes = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name + (detail ? ': ' + detail : ''));
  }
}
function note(message) {
  notes.push(message);
  console.log(`  INFO  ${message}`);
}

// ───────────────────────────── helpers ─────────────────────────────
function sliceObjectLiteral(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) return null;
  const open = text.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return { start: start, end: index + 1, text: text.slice(start, index + 1) };
    }
  }
  return null;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function collectMatches(text, expression) {
  const found = [];
  let match = expression.exec(text);
  while (match) {
    found.push(match[1]);
    match = expression.exec(text);
  }
  return found;
}

// ───────────────────────────── 1. envelope ─────────────────────────────
console.log('\n[1] module-loader envelope');
check('uses window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(\{/.test(source));
check('declares a factory(require)', /factory\(require\)/.test(source));
check('React comes from require("react")', /require\('react'\)/.test(source));
check('does not import @deepseek-ai packages', source.indexOf('@deepseek-ai/') === -1);
check('does not load remote scripts', !/https?:\/\//.test(stripComments(source.slice(0, source.indexOf('const ZH_DICT')))));

const loaderIdMatch = /id:\s*'([^']+)'/.exec(source.slice(source.indexOf('__ModuleLoader__')));
check('loader id equals package.json name', Boolean(loaderIdMatch) && loaderIdMatch[1] === pkg.name,
  loaderIdMatch ? `id=${loaderIdMatch[1]} name=${pkg.name}` : 'id not found');
check(
  'declared line budget <= 2900',
  lines.length <= 2900,
  `${lines.length} lines`,
);
check('polls the all-call ledger route', source.indexOf("'/ledger?range='") !== -1);
check('polls the account route', source.indexOf("'/account'") !== -1);
check('polls the bill-history route', source.indexOf("'/bill-history?range='") !== -1);
check('posts to the account login route', /method:\s*'POST'/.test(source) && source.indexOf("'/account/login'") !== -1);
check('renders the reconciliation scope note', source.indexOf("t('reconcile.note')") !== -1);
check('renders the platform bill card', source.indexOf("t('account.title')") !== -1);
check('renders the all-call ledger card', source.indexOf("t('ledger.title')") !== -1);
check('renders the bill history card', source.indexOf("t('billHistory.title')") !== -1);
check('flags incomplete bill days', source.indexOf('complete === false') !== -1);
check(
  'labels the bill source vocabulary',
  source.indexOf("'source.walletLedger'") !== -1 && source.indexOf("'source.balanceSampling'") !== -1,
);
check(
  'reads spendSource and spendComplete from /account',
  source.indexOf('spendSource') !== -1 && source.indexOf('spendComplete') !== -1,
);

// ───────────────────────────── CNY-first currency contract ─────────────────────────────
check('defaults to CNY before USD', source.indexOf("const CURRENCIES = ['CNY', 'USD'];") !== -1);
check('starts the dashboard with CNY selected', source.indexOf("useState('CNY')") !== -1);
check('starts the dashboard on the CNY range list', source.indexOf("const RANGES = ['today', '24h', '7d', '14d', '30d', 'all'];") !== -1);
check('defaults the range to today', source.indexOf("useState('today')") !== -1);
check('renders the today range tab', source.indexOf("'range.today'") !== -1);
check('sends currency to the ledger route', source.indexOf("'&currency='") !== -1);
check('no longer derives costs from USD', source.indexOf('costInCurrency') === -1);
check('shows the KPI converted cost', source.indexOf('kpi.costUSD') !== -1);
check('marks lower-bound spend windows', source.indexOf('spendCoverage') !== -1 && source.indexOf("'≥ '") !== -1);

// ───────────────────────────── FX provenance contract ─────────────────────────────
check(
  'renders the fx provenance line',
  source.indexOf("t('fx.title')") !== -1 && source.indexOf("t('fx.effective'") !== -1,
);
check(
  'reads fx effectiveDate and sourceLabel',
  source.indexOf('effectiveDate') !== -1 && source.indexOf('sourceLabel') !== -1,
);
check(
  'labels the fx source vocabulary',
  source.indexOf("'fx.source.pboc'") !== -1 && source.indexOf("'fx.source.config'") !== -1,
);
check('has no stale hard-coded 7.1 rate', source.indexOf('7.1') === -1);

// ───────────────────────────── 2. execute the factory ─────────────────────────────
console.log('\n[2] factory execution and apply() registration');
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  memo: (component) => component,
  useCallback: (callback) => callback,
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

const localeDicts = {};
const registrations = [];
const localeStub = {
  register(namespace, first, second) {
    if (first && typeof first === 'object') {
      localeDicts.zh = first.zh;
      localeDicts.en = first.en;
    } else {
      localeDicts[first] = second;
    }
    return () => {};
  },
  bind(namespace) {
    return (key) => key;
  },
  getLocale() {
    return { active: 'en', locales: ['zh', 'en'], revision: 1 };
  },
  subscribe() {
    return () => {};
  },
};
const slotsStub = {
  inject(name, factory) {
    factory();
    return () => {};
  },
  register(options, component) {
    registrations.push({ options: options, component: component });
    return () => {};
  },
};
const layoutStub = {
  panelInfo: { getSnapshot: () => ({ activePanelId: 'usage-monitor' }) },
  selectPanel() {},
  toggleSidebar() {},
};
const timerStub = { interval: () => () => {} };

let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  },
  console: console,
  Intl: Intl,
  Math: Math,
  Date: Date,
  JSON: JSON,
  Object: Object,
  Array: Array,
  Map: Map,
  Set: Set,
  Number: Number,
  String: String,
  Boolean: Boolean,
  isFinite: isFinite,
  encodeURIComponent: encodeURIComponent,
  setInterval: setInterval,
  clearInterval: clearInterval,
};
try {
  vm.runInNewContext(source, sandbox, { filename: clientPath });
} catch (error) {
  check('module source evaluates without reference errors', false, String(error));
}

check('captured loader spec', Boolean(captured && typeof captured.factory === 'function'));

let exportsObject = null;
try {
  exportsObject = captured.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error('unexpected require: ' + name);
  });
} catch (error) {
  check('factory runs to completion', false, String(error));
}
check('factory returns an object', Boolean(exportsObject) && typeof exportsObject === 'object');
if (exportsObject) {
  check('exports.name is a string', typeof exportsObject.name === 'string');
  check('exports.inject is an array', Array.isArray(exportsObject.inject));
  check('exports.apply is a function', typeof exportsObject.apply === 'function');
  if (Array.isArray(exportsObject.inject)) {
    for (const service of ['slots', 'locale', 'layout', 'timer']) {
      check(`inject includes "${service}"`, exportsObject.inject.indexOf(service) !== -1);
    }
  }
  if (typeof exportsObject.apply === 'function') {
    try {
      exportsObject.apply({
        slots: slotsStub,
        locale: localeStub,
        layout: layoutStub,
        timer: timerStub,
        effect: (callback) => callback(),
      });
      check('apply() runs against stub services', true);
    } catch (error) {
      check('apply() runs against stub services', false, String(error));
    }
  }
}

const panellist = registrations.find((entry) => entry.options && entry.options.name === 'sidebar.panellist');
const main = registrations.find((entry) => entry.options && entry.options.name === 'main');
check('registers sidebar.panellist', Boolean(panellist));
check('registers main', Boolean(main));

const panelId = /const PANEL_ID = '([^']+)'/.exec(source);
const expectedPanelId = panelId ? panelId[1] : '<missing>';
check('PANEL_ID is usage-monitor', expectedPanelId === 'usage-monitor', expectedPanelId);
if (panellist) {
  check('panellist id === PANEL_ID', panellist.options.id === expectedPanelId, String(panellist.options.id));
  check('panellist order is a number', typeof panellist.options.order === 'number');
  check('panellist label is a resolver function', typeof panellist.options.label === 'function');
  check('panellist component is a function', typeof panellist.component === 'function');
  check('panellist id equals its main-panel key', Boolean(main) && panellist.options.id === main.options.key);
}
if (main) {
  check('main key === PANEL_ID', main.options.key === expectedPanelId, String(main.options.key));
  check('main component is a function', typeof main.component === 'function');
}

// ───────────────────────────── 3. locale dictionaries ─────────────────────────────
console.log('\n[3] locale dictionaries');
const zh = localeDicts.zh;
const en = localeDicts.en;
check('zh dictionary registered with the {zh, en} form', Boolean(zh && typeof zh === 'object'));
check('en dictionary registered with the {zh, en} form', Boolean(en && typeof en === 'object'));
const zhKeys = zh ? Object.keys(zh).sort() : [];
const enKeys = en ? Object.keys(en).sort() : [];
const missingInEn = zhKeys.filter((key) => enKeys.indexOf(key) === -1);
const missingInZh = enKeys.filter((key) => zhKeys.indexOf(key) === -1);
check('zh and en key sets are identical', missingInEn.length === 0 && missingInZh.length === 0,
  JSON.stringify({ missingInEn: missingInEn, missingInZh: missingInZh }));
note(`${zhKeys.length} locale keys per language`);

const literalKeys = new Set();
for (const match of source.matchAll(/\bt\('([^']+)'/g)) literalKeys.add(match[1]);
for (const match of source.matchAll(/labelKey:\s*'([^']+)'/g)) literalKeys.add(match[1]);
// `labelKey` literals are consumed through t(x.labelKey) — every such dynamic call
// must point at an object that carries a validated labelKey.
const dynamicCalls = collectMatches(source, /(^|[^\w$.])t\(\s*([^'")])/g);
const dynamicArgs = [...source.matchAll(/(^|[^\w$.])t\(\s*([A-Za-z_$][\w$]*\.labelKey)\s*\)/g)].map((match) => match[2]);
check('every dynamic t() argument is a validated .labelKey', dynamicCalls.length === dynamicArgs.length,
  `${dynamicCalls.length} dynamic calls, ${dynamicArgs.length} allowed`);
const zhKeySet = new Set(zhKeys);
const missingKeys = [...literalKeys].filter((key) => !zhKeySet.has(key)).sort();
check('every referenced locale key exists', missingKeys.length === 0, JSON.stringify(missingKeys));
const unusedKeys = zhKeys.filter((key) => !literalKeys.has(key));
if (unusedKeys.length) note(`keys not referenced in client.js: ${unusedKeys.join(', ')}`);

// ───────────────────────────── 4. banned constructs / hard-coded copy ─────────────────────────────
console.log('\n[4] banned constructs and copy');
const zhLiteral = sliceObjectLiteral(source, 'const ZH_DICT = {');
const enLiteral = sliceObjectLiteral(source, 'const EN_DICT = {');
check('zh dictionary block found', Boolean(zhLiteral));
check('en dictionary block found', Boolean(enLiteral));
let withoutDictionaries = source;
if (zhLiteral) withoutDictionaries = withoutDictionaries.split(zhLiteral.text).join('');
if (enLiteral) withoutDictionaries = withoutDictionaries.split(enLiteral.text).join('');
const codeOnly = stripComments(withoutDictionaries);

const cjk = codeOnly.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g);
check('no hard-coded CJK outside dictionaries/comments', !cjk, cjk ? cjk.slice(0, 12).join('') : '');
check('no iframe', !/iframe/i.test(codeOnly));
check('no document.body writes', !/document\.body/.test(codeOnly));
check('no hex colours', !/#[0-9a-fA-F]{3,8}\b/.test(codeOnly));
check('no remote/CDN assets', !/https?:\/\//.test(codeOnly));
check('no chart library import', !/from\s+'[^']*chart/i.test(codeOnly));
check('uses window.__ModuleLoader__.load only once', (source.match(/__ModuleLoader__\.load\(/g) || []).length === 1);

// ───────────────────────────── 5. inventory ─────────────────────────────
console.log('\n[5] inventory');
const components = [...source.matchAll(/^\s{4}function ([A-Z][A-Za-z0-9]*)/gm)].map((match) => match[1]);
const memos = [...source.matchAll(/const ([A-Z][A-Za-z0-9]*) = memo\(/g)].map((match) => match[1]);
note(`components (${components.length}): ${components.join(', ')}`);
if (memos.length) note(`memoized: ${memos.join(', ')}`);
note(`client.js: ${lines.length} lines, ${Buffer.byteLength(source, 'utf8')} bytes`);

// ───────────────────────────── result ─────────────────────────────
console.log('');
if (failures.length) {
  console.log(`SELF-CHECK FAILED (${failures.length} failing check${failures.length === 1 ? '' : 's'})`);
  for (const failure of failures) console.log('  - ' + failure);
  process.exitCode = 1;
} else {
  console.log('SELF-CHECK PASSED — all checks green');
}
