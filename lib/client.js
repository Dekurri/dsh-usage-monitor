/**
 * dsh-usage-monitor — browser half (Web client plugin).
 *
 * Registers exactly one global panel:
 *   sidebar.panellist (list, root)   → PanelIcon   (id:  usage-monitor)
 *   main              (keyed, root)  → Dashboard   (key: usage-monitor)
 * The sidebar entry id and the main panel key MUST stay identical; the
 * sidebar resolves its label from the list registration metadata and the
 * layout service switches panels on click (no local click handling needed).
 *
 * Data arrives from the Host routes declared in CONTRACT.md:
 *   GET /usage-monitor/api/overview?range=&currency=   (30 s poll)
 *   GET /usage-monitor/api/live                        (2 s poll, visible only)
 * Both are same-origin root-relative requests; nothing host/port specific.
 *
 * Every user-visible string resolves through ctx.locale.bind('usage-monitor').
 * The zh/en dictionaries below are the single source of truth for the package's
 * locale/zh.json and locale/en.json (Lead mirrors the keys there).
 *
 * All colours are theme tokens (--dsw-alias-*); multi-series charts derive their
 * palette from brand/success/warn/error/idle/label-secondary, deeper shades use
 * color-mix(). No hard-coded hex colours, no chart library, no iframe.
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Fragment = React.Fragment;
    const memo = React.memo;
    const useCallback = React.useCallback;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useState = React.useState;
    const useSyncExternalStore = React.useSyncExternalStore;

    // ───────────────────────────── identity / constants ─────────────────────────────
    const PANEL_ID = 'usage-monitor';
    const NS = 'usage-monitor';
    const API_BASE = '/usage-monitor/api';
    const OVERVIEW_INTERVAL_MS = 30000;
    const LIVE_INTERVAL_MS = 2000;
    // v2 data lines: the all-call ledger (llm/stream) and the platform bill.
    const LEDGER_INTERVAL_MS = 30000;
    const ACCOUNT_INTERVAL_MS = 60000;
    const LOGIN_POLL_INTERVAL_MS = 5000;
    const LOGIN_TIMEOUT_MS = 180000;
    const BILL_HISTORY_INTERVAL_MS = 60000;
    const MAX_BARS = 36;
    const SESSION_STEP = 50;
    const RANGES = ['today', '24h', '7d', '14d', '30d', 'all'];
    const CURRENCIES = ['CNY', 'USD'];
    const DASH = '—';
    const EMPTY_LOCALE = { active: 'en' };
    // Section visibility: the id list is fixed so a stale saved value can never
    // reference a block that no longer exists.
    const BLOCK_STORAGE_KEY = 'usage-monitor.hiddenBlocks';
    const BLOCK_DEFS = [
      { id: 'kpi', labelKey: 'block.kpi' },
      { id: 'reconcile', labelKey: 'block.reconcile' },
      { id: 'ledger', labelKey: 'block.ledger' },
      { id: 'account', labelKey: 'block.account' },
      { id: 'fx', labelKey: 'block.fx' },
      { id: 'billHistory', labelKey: 'block.billHistory' },
      { id: 'charts', labelKey: 'block.charts' },
      { id: 'live', labelKey: 'block.live' },
      { id: 'models', labelKey: 'block.models' },
      { id: 'sessions', labelKey: 'block.sessions' },
      { id: 'performance', labelKey: 'block.performance' },
    ];
    const BLOCK_IDS = BLOCK_DEFS.map((def) => def.id);

    /** Hidden block ids from localStorage; anything unreadable degrades to "show all". */
    function readHiddenBlocks() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return [];
        const raw = window.localStorage.getItem(BLOCK_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((id) => typeof id === 'string' && BLOCK_IDS.indexOf(id) >= 0);
      } catch (error) {
        return [];
      }
    }

    /** Persist hidden block ids; a failing write must never break rendering. */
    function writeHiddenBlocks(ids) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        window.localStorage.setItem(BLOCK_STORAGE_KEY, JSON.stringify(ids));
      } catch (error) {
        /* storage disabled (private mode / quota) — settings simply do not stick */
      }
    }

    // Theme tokens only — never a literal colour.
    const C = {
      bgBase: 'var(--dsw-alias-bg-base)',
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-caption)',
      label4: 'var(--dsw-alias-label-tertiary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    const SERIES = [
      { key: 'uncachedInputTokens', labelKey: 'series.uncached', color: C.brand },
      { key: 'cacheReadTokens', labelKey: 'series.cacheRead', color: C.success },
      { key: 'cacheWriteTokens', labelKey: 'series.cacheWrite', color: C.warn },
      { key: 'outputTokens', labelKey: 'series.output', color: C.label2 },
    ];

    const MODEL_PALETTE = [C.brand, C.success, C.warn, C.error, C.idle, C.label2];

    // Contract §7.3 fixes this purpose vocabulary; unknown values fold into "other".
    const PURPOSE_META = [
      { key: 'chat', labelKey: 'purpose.chat', color: C.brand },
      { key: 'compaction', labelKey: 'purpose.compaction', color: C.success },
      { key: 'session-title', labelKey: 'purpose.sessionTitle', color: C.warn },
      { key: 'other', labelKey: 'purpose.other', color: C.label2 },
    ];
    const BUCKET_NUMERIC_KEYS = [
      'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
      'reasoningTokens', 'totalTokens', 'cost', 'sessions', 'requests',
    ];
    const SESSION_DATE_KEYS = { lastActivityAt: true, createdAt: true };

    // ───────────────────────────── locale dictionaries ─────────────────────────────
    // Keep the zh and en key sets identical — tools/ui-selfcheck.mjs enforces it.
    const ZH_DICT = {
      'panel.title': '使用量监控',
      'panel.subtitle': 'Token 消耗、成本估算与运行时监控',
      'toolbar.range': '时段',
      'toolbar.currency': '货币',
      'range.today': '今日',
      'range.24h': '24 小时',
      'range.7d': '7 天',
      'range.14d': '14 天',
      'range.30d': '30 天',
      'range.all': '全部',
      'currency.USD': '$',
      'currency.CNY': '¥',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'status.updatedAt': '更新于 {time}',
      'status.loading': '加载中…',
      'status.refreshing': '刷新中…',
      'status.scanning': '正在扫描会话 {scanned}/{total}',
      'status.live': '实时',
      'error.loadFailed': '加载失败（HTTP {status}）',
      'error.network': '网络请求失败',
      'common.noData': '暂无数据',
      'common.tokens': 'Token',
      'common.other': '其他',
      'kpi.totalTokens': '总 Token',
      'kpi.totalHint': '会话 {sessions} · 轮次 {turns}',
      'kpi.avgPerTurn': '每轮 {value}',
      'kpi.cost': '成本估算',
      'kpi.costHint': '≈ 换算为 {value}',
      'kpi.fxRate': '汇率 {rate}',
      'fx.title': '汇率',
      'fx.source.pboc': '央行中间价',
      'fx.source.history': '央行历史中间价',
      'fx.source.market': '市场汇率（非央行口径）',
      'fx.source.config': '离线配置值',
      'fx.effective': '生效 {date}',
      'fx.stale': '缓存值',
      'fx.offline': '离线值',
      'fx.fetched': '更新于 {time}',
      'kpi.sessions': '会话数',
      'kpi.sessionsHint': '此时段有活动 · 库中共 {total} 个',
      'kpi.activeSessions': '活跃会话',
      'kpi.activeHint': '此刻正在运行',
      'kpi.cacheHit': '缓存命中率',
      'kpi.cacheHint': '缓存读取 {value}',
      'chart.tokens': 'Token 消耗',
      'chart.tokensDesc': '按分桶堆叠 · 悬停查看明细',
      'chart.composition': 'Token 构成',
      'chart.models': '模型占比',
      'chart.live': '实时运行状态',
      'chart.liveDesc': '每 2 秒采样',
      'chart.performance': '对话性能',
      'tooltip.total': '合计 {value}',
      'series.uncached': '未缓存输入',
      'series.cacheRead': '缓存读取',
      'series.cacheWrite': '缓存写入',
      'series.output': '输出',
      'live.cpu': 'CPU',
      'live.mem': '内存',
      'live.gpu': 'GPU',
      'live.cores': '{n} 核',
      'live.cpuDetail': '{cores} · 负载 {load}',
      'live.memDetail': '{used} / {total}',
      'live.gpuOff': '未检测到 GPU',
      'live.uptime': '运行时长',
      'live.hostUptime': '主机运行时长',
      'live.rss': '常驻内存',
      'live.heap': '堆内存',
      'live.gpuMem': 'GPU 显存',
      'live.threads': '线程',
      'live.cpuHistory': 'CPU 历史',
      'live.tokenHistory': 'Token/分钟',
      'models.name': '模型',
      'models.requests': '请求数',
      'models.tokens': 'Token',
      'models.cost': '成本',
      'models.hitRate': '命中率',
      'models.speed': '速度',
      'models.unpriced': '无价格',
      'sessions.title': '分会话统计',
      'sessions.search': '搜索会话…',
      'sessions.count': '{n} 个会话',
      'sessions.col.session': '会话',
      'sessions.col.requests': '请求数',
      'sessions.col.tokens': '总 Token',
      'sessions.col.hitRate': '命中率',
      'sessions.col.cost': '成本',
      'sessions.col.speed': '均速',
      'sessions.col.ttft': '首 token',
      'sessions.col.lastActive': '最后活动',
      'sessions.showMore': '显示更多（还有 {n} 行）',
      'sessions.empty': '暂无会话数据',
      'sessions.noMatch': '没有匹配的会话',
      'perf.ttft': '首 Token 延迟',
      'perf.speed': '输出速度',
      'perf.avg': '均值',
      'perf.p50': 'P50',
      'perf.p90': 'P90',
      'perf.samples': '{n} 个样本',
      'perf.stats': '关键指标',
      'perf.share': '工具耗时 vs 模型耗时',
      'perf.shareTool': '工具',
      'perf.shareLlm': '模型',
      'perf.shareItem': '{label} {percent} · {value}',
      'perf.cacheHit': '缓存命中率',
      'perf.requestsPerTurn': '每轮请求数',
      'perf.toolCallsPerTurn': '每轮工具调用',
      'perf.errorTurns': '异常轮次',
      'perf.interruptedTurns': '中断轮次',
      'perf.totalTurns': '总轮次',
      'perf.empty': '暂无性能数据',
      'unit.ms': '毫秒',
      'unit.tokensPerSec': 'tok/s',
      'settings.title': '设置与计费规则',
      'settings.desc': '刷新频率、默认币种、官方价表与峰谷口径',
      'settings.blocks': '显示板块',
      'settings.blocksReset': '全部显示',
      'settings.blocksHint': '勾选决定面板显示哪些板块，只保存在本机浏览器，不影响统计数据。',
      'block.kpi': '概览指标',
      'block.reconcile': '对账',
      'block.ledger': '全量调用口径',
      'block.account': '平台账单',
      'block.fx': '汇率说明',
      'block.billHistory': '平台账单（历史）',
      'block.charts': '消耗趋势与成本构成',
      'block.live': '实时运行状态',
      'block.models': '分模型',
      'block.sessions': '分会话',
      'block.performance': '对话性能',
      'pricing.baseLabel': '计费基准',
      'pricing.baseValue': '官方人民币价表 · 元 / 百万 token',
      'pricing.peakLabel': '高峰时段',
      'pricing.peakValue': '北京时间 {window}（周一至周五）',
      'pricing.offPeakLabel': '谷价时段',
      'pricing.offPeakValue': '其余时间 · 周末与法定节假日全天',
      'pricing.holidayNote': '已内置 {years} 年共 {days} 天中国法定节假日，节假日全天按谷价（= 高峰价的一半）。',
      'pricing.holidayNone': '未内置法定节假日表，节假日按高峰价估算。',
      'pricing.boundary': '未内置年份（如 2027）的工作日高峰窗按高峰价计，可能略高估；可在配置里用 pricingHolidays 追加。',
      'pricing.estimated': '成本为按价表估算，与开放平台账单存在口径差；平台账单以「历史账单」卡为准。',
      'ledger.title': '全量调用口径',
      'ledger.desc': '含辅助模型调用 · 仅自安装起',
      'ledger.requests': '请求数',
      'ledger.tokens': 'Token',
      'ledger.cacheHit': '缓存命中率',
      'ledger.cost': '估算成本',
      'ledger.purpose': '按用途',
      'ledger.model': '按模型',
      'ledger.installedAt': '自 {time} 起记录',
      'ledger.installedHint': '安装前的辅助调用无法追回',
      'ledger.unavailable': '调用账本不可用',
      'ledger.empty': '暂无调用记录',
      'purpose.chat': '对话与审查',
      'purpose.compaction': '上下文压缩',
      'purpose.sessionTitle': '会话标题',
      'purpose.other': '其他',
      'account.title': '平台账单',
      'account.desc': '余额账本 · 与开放平台一致',
      'account.balance': '账户余额',
      'account.spendToday': '今日消费',
      'account.spendYesterday': '昨日消费',
      'account.spend7d': '近 7 天',
      'account.spend30d': '近 30 天',
      'account.sampledAt': '采样于 {time}',
      'account.spendSince': '自 {time} 起采样',
      'account.topUpDetected': '区间内有充值，无法用余额差推算',
      'account.topUpLedger': '区间内有充值；余额账本按实际扣款统计，不受影响',
      'account.usageLink': '查看用量',
      'account.topUpLink': '去充值',
      'account.signIn': '登录 DeepSeek 账号',
      'account.signingIn': '等待浏览器授权…',
      'account.signInTimeout': '登录超时，请重试',
      'account.signInFailed': '登录发起失败',
      'account.signedOut': '未登录 DeepSeek 账号',
      'account.signedOutHint': '登录后可读取余额与平台账单',
      'account.unavailable': '账号服务不可用',
      'account.noSample': '尚无采样数据',
      'account.diag': '诊断：{text}',
      'billHistory.title': '平台账单（历史）',
      'billHistory.desc': '本机余额账本 · 安装前的日期自动补齐',
      'billHistory.source': '来源：{source}',
      'billHistory.range': '覆盖 {since} → {until}',
      'billHistory.total7d': '近 7 天',
      'billHistory.total14d': '近 14 天',
      'billHistory.total30d': '近 30 天',
      'billHistory.totalAll': '全部',
      'billHistory.unavailable': '历史账单不可用',
      'billHistory.incomplete': '当天记账未覆盖零点',
      'billHistory.empty': '暂无历史记录',
      'billHistory.fresh': '更新于 {time}',
      'source.walletLedger': '余额账本',
      'source.monitor': '本机余额账本',
      'source.whale': '历史导入（其他插件账本）',
      'source.monitorWhale': '本机账本 + 历史导入',
      'source.balanceSampling': '本插件采样',
      'reconcile.title': '对账',
      'reconcile.ledger': '全量口径估算',
      'reconcile.bill': '平台账单今日',
      'reconcile.deviation': '偏差 {value}',
      'reconcile.note': '会话口径 / 全量调用口径 / 平台账单口径并列展示，不可相加',
      'reconcile.empty': '暂无对账数据',
    };

    const EN_DICT = {
      'panel.title': 'Usage Monitor',
      'panel.subtitle': 'Token usage, cost estimates and runtime metrics',
      'toolbar.range': 'Range',
      'toolbar.currency': 'Currency',
      'range.today': 'Today',
      'range.24h': '24h',
      'range.7d': '7d',
      'range.14d': '14d',
      'range.30d': '30d',
      'range.all': 'All',
      'currency.USD': '$',
      'currency.CNY': '¥',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'status.updatedAt': 'Updated {time}',
      'status.loading': 'Loading…',
      'status.refreshing': 'Refreshing…',
      'status.scanning': 'Scanning sessions {scanned}/{total}',
      'status.live': 'Live',
      'error.loadFailed': 'Failed to load (HTTP {status})',
      'error.network': 'Network request failed',
      'common.noData': 'No data',
      'common.tokens': 'Tokens',
      'common.other': 'Other',
      'kpi.totalTokens': 'Total tokens',
      'kpi.totalHint': '{sessions} sessions · {turns} turns',
      'kpi.avgPerTurn': '{value} per turn',
      'kpi.cost': 'Est. cost',
      'kpi.costHint': '≈ {value} converted',
      'kpi.fxRate': 'FX {rate}',
      'fx.title': 'FX',
      'fx.source.pboc': 'PBOC central parity',
      'fx.source.history': 'PBOC historical parity',
      'fx.source.market': 'Market rate (not PBOC)',
      'fx.source.config': 'Offline config value',
      'fx.effective': 'effective {date}',
      'fx.stale': 'cached',
      'fx.offline': 'offline',
      'fx.fetched': 'updated {time}',
      'kpi.sessions': 'Sessions',
      'kpi.sessionsHint': 'active in range · {total} total',
      'kpi.activeSessions': 'Active sessions',
      'kpi.activeHint': 'running right now',
      'kpi.cacheHit': 'Cache hit rate',
      'kpi.cacheHint': '{value} cache reads',
      'chart.tokens': 'Token consumption',
      'chart.tokensDesc': 'Stacked by bucket · hover for details',
      'chart.composition': 'Token composition',
      'chart.models': 'Model share',
      'chart.live': 'Live runtime',
      'chart.liveDesc': '2 s sampling',
      'chart.performance': 'Conversation performance',
      'tooltip.total': 'Total {value}',
      'series.uncached': 'Uncached input',
      'series.cacheRead': 'Cache read',
      'series.cacheWrite': 'Cache write',
      'series.output': 'Output',
      'live.cpu': 'CPU',
      'live.mem': 'Memory',
      'live.gpu': 'GPU',
      'live.cores': '{n} cores',
      'live.cpuDetail': '{cores} · load {load}',
      'live.memDetail': '{used} / {total}',
      'live.gpuOff': 'No GPU detected',
      'live.uptime': 'Uptime',
      'live.hostUptime': 'Host uptime',
      'live.rss': 'RSS',
      'live.heap': 'Heap',
      'live.gpuMem': 'GPU memory',
      'live.threads': 'Threads',
      'live.cpuHistory': 'CPU history',
      'live.tokenHistory': 'Tokens/min',
      'models.name': 'Model',
      'models.requests': 'Requests',
      'models.tokens': 'Tokens',
      'models.cost': 'Cost',
      'models.hitRate': 'Hit rate',
      'models.speed': 'Speed',
      'models.unpriced': 'Unpriced',
      'sessions.title': 'Per-session stats',
      'sessions.search': 'Search sessions…',
      'sessions.count': '{n} sessions',
      'sessions.col.session': 'Session',
      'sessions.col.requests': 'Requests',
      'sessions.col.tokens': 'Tokens',
      'sessions.col.hitRate': 'Hit rate',
      'sessions.col.cost': 'Cost',
      'sessions.col.speed': 'Avg speed',
      'sessions.col.ttft': 'First token',
      'sessions.col.lastActive': 'Last active',
      'sessions.showMore': 'Show more ({n} left)',
      'sessions.empty': 'No session data',
      'sessions.noMatch': 'No matching sessions',
      'perf.ttft': 'First token latency',
      'perf.speed': 'Output speed',
      'perf.avg': 'Avg',
      'perf.p50': 'P50',
      'perf.p90': 'P90',
      'perf.samples': '{n} samples',
      'perf.stats': 'Key metrics',
      'perf.share': 'Tool time vs model time',
      'perf.shareTool': 'Tools',
      'perf.shareLlm': 'Model',
      'perf.shareItem': '{label} {percent} · {value}',
      'perf.cacheHit': 'Cache hit rate',
      'perf.requestsPerTurn': 'Requests / turn',
      'perf.toolCallsPerTurn': 'Tool calls / turn',
      'perf.errorTurns': 'Error turns',
      'perf.interruptedTurns': 'Interrupted turns',
      'perf.totalTurns': 'Total turns',
      'perf.empty': 'No performance data',
      'unit.ms': 'ms',
      'unit.tokensPerSec': 'tok/s',
      'settings.title': 'Settings & pricing',
      'settings.desc': 'Refresh cadence, base currency, official price table and peak rules',
      'settings.blocks': 'Visible sections',
      'settings.blocksReset': 'Show all',
      'settings.blocksHint': 'Ticked sections appear on the panel. The choice is stored in this browser only and never affects the numbers.',
      'block.kpi': 'Overview metrics',
      'block.reconcile': 'Reconciliation',
      'block.ledger': 'All model calls',
      'block.account': 'Platform bill',
      'block.fx': 'Exchange rate',
      'block.billHistory': 'Bill history',
      'block.charts': 'Trend and composition',
      'block.live': 'Live runtime',
      'block.models': 'By model',
      'block.sessions': 'By session',
      'block.performance': 'Chat performance',
      'pricing.baseLabel': 'Pricing basis',
      'pricing.baseValue': 'Official CNY table · per 1M tokens',
      'pricing.peakLabel': 'Peak hours',
      'pricing.peakValue': '{window} Beijing time (Mon–Fri)',
      'pricing.offPeakLabel': 'Off-peak',
      'pricing.offPeakValue': 'All other hours · weekends and public holidays',
      'pricing.holidayNote': '{years} public holidays built in ({days} days); holidays are billed at off-peak (half of peak).',
      'pricing.holidayNone': 'No holiday calendar built in — holidays are estimated at peak price.',
      'pricing.boundary': 'Weekday peak windows in years without a calendar (e.g. 2027) are billed at peak and may be slightly overestimated; extend via pricingHolidays in config.',
      'pricing.estimated': 'Cost is a price-table estimate and differs from the open-platform bill; use the bill-history card for the platform figure.',
      'ledger.title': 'All model calls',
      'ledger.desc': 'Includes helper model calls · since install',
      'ledger.requests': 'Requests',
      'ledger.tokens': 'Tokens',
      'ledger.cacheHit': 'Cache hit rate',
      'ledger.cost': 'Est. cost',
      'ledger.purpose': 'By purpose',
      'ledger.model': 'By model',
      'ledger.installedAt': 'Recording since {time}',
      'ledger.installedHint': 'Helper calls before install cannot be recovered',
      'ledger.unavailable': 'Call ledger unavailable',
      'ledger.empty': 'No recorded calls',
      'purpose.chat': 'Chat and review',
      'purpose.compaction': 'Compaction',
      'purpose.sessionTitle': 'Session titles',
      'purpose.other': 'Other',
      'account.title': 'Platform bill',
      'account.desc': 'Wallet ledger · matches the open platform',
      'account.balance': 'Balance',
      'account.spendToday': 'Today',
      'account.spendYesterday': 'Yesterday',
      'account.spend7d': 'Last 7 days',
      'account.spend30d': 'Last 30 days',
      'account.sampledAt': 'Sampled {time}',
      'account.spendSince': 'sampled since {time}',
      'account.topUpDetected': 'Top-up detected — balance delta cannot be inferred',
      'account.topUpLedger': 'Top-up detected in range; the wallet ledger counts actual debits',
      'account.usageLink': 'Usage page',
      'account.topUpLink': 'Top up',
      'account.signIn': 'Sign in to DeepSeek',
      'account.signingIn': 'Waiting for browser authorization…',
      'account.signInTimeout': 'Sign-in timed out — retry',
      'account.signInFailed': 'Could not start sign-in',
      'account.signedOut': 'Not signed in to DeepSeek',
      'account.signedOutHint': 'Sign in to read the balance and platform bill',
      'account.unavailable': 'Account service unavailable',
      'account.noSample': 'No sample yet',
      'account.diag': 'Diagnostics: {text}',
      'billHistory.title': 'Platform bill (history)',
      'billHistory.desc': 'Local balance ledger · earlier days backfilled',
      'billHistory.source': 'Source: {source}',
      'billHistory.range': 'Covers {since} → {until}',
      'billHistory.total7d': 'Last 7 days',
      'billHistory.total14d': 'Last 14 days',
      'billHistory.total30d': 'Last 30 days',
      'billHistory.totalAll': 'All',
      'billHistory.unavailable': 'Bill history unavailable',
      'billHistory.incomplete': 'Day accounting does not start at midnight',
      'billHistory.empty': 'No history',
      'billHistory.fresh': 'Updated {time}',
      'source.walletLedger': 'Balance ledger',
      'source.monitor': 'Local balance ledger',
      'source.whale': 'Imported history (other plugin)',
      'source.monitorWhale': 'Local ledger + imported history',
      'source.balanceSampling': 'Plugin sampling',
      'reconcile.title': 'Reconciliation',
      'reconcile.ledger': 'All-call estimate',
      'reconcile.bill': 'Platform bill today',
      'reconcile.deviation': 'Deviation {value}',
      'reconcile.note': 'Session, all-call and platform-bill scopes are shown side by side and must not be added together',
      'reconcile.empty': 'No reconciliation data',
    };

    // ───────────────────────────── number / time formatting ─────────────────────────────
    const numberFormatters = new Map();
    const dateTimeFormatters = new Map();
    const clockFormatters = new Map();
    const relativeFormatters = new Map();

    function numberFormatter(locale, digits) {
      const cacheKey = locale + '|' + digits;
      let formatter = numberFormatters.get(cacheKey);
      if (!formatter) {
        formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: digits });
        numberFormatters.set(cacheKey, formatter);
      }
      return formatter;
    }

    function formatNumber(value, locale, digits) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      return numberFormatter(locale, typeof digits === 'number' ? digits : 1).format(value);
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      const amount = Math.round(value);
      if (amount < 1000) return String(amount);
      const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
      for (const pair of units) {
        if (amount >= pair[0]) {
          const scaled = amount / pair[0];
          const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
          return scaled.toFixed(digits).replace(/\.0+$/, '') + pair[1];
        }
      }
      return String(amount);
    }

    const CURRENCY_SYMBOLS = { USD: '$', CNY: '¥' };

    function trimTrailingZeros(text) {
      if (text.indexOf('e') !== -1) return text;
      return text.indexOf('.') === -1 ? text : text.replace(/0+$/, '').replace(/\.$/, '');
    }

    function formatMoney(value, currency, locale) {
      const symbol = CURRENCY_SYMBOLS[currency] || CURRENCY_SYMBOLS.USD;
      if (typeof value !== 'number' || !isFinite(value)) return symbol + DASH;
      const absolute = Math.abs(value);
      if (absolute === 0) return symbol + '0.00';
      if (absolute < 1e-6) return symbol + value.toExponential(2);
      if (absolute < 1) return symbol + trimTrailingZeros(value.toPrecision(4));
      const digits = absolute < 10000 ? 2 : 0;
      return symbol + numberFormatter(locale, digits).format(value);
    }

    function formatRatio(value) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      return (value * 100).toFixed(1) + '%';
    }

    function formatPercentPoints(value) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      return value.toFixed(1) + '%';
    }

    function formatSignedPercent(value) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      return (value > 0 ? '+' : '') + value.toFixed(1) + '%';
    }

    function formatRelative(value, locale) {
      const milliseconds = toMillis(value);
      if (!milliseconds) return DASH;
      const deltaSeconds = Math.round((milliseconds - Date.now()) / 1000);
      const absolute = Math.abs(deltaSeconds);
      let divisor = 1;
      let unit = 'second';
      if (absolute >= 86400) {
        divisor = 86400;
        unit = 'day';
      } else if (absolute >= 3600) {
        divisor = 3600;
        unit = 'hour';
      } else if (absolute >= 60) {
        divisor = 60;
        unit = 'minute';
      }
      let formatter = relativeFormatters.get(locale);
      if (!formatter) {
        try {
          formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
          relativeFormatters.set(locale, formatter);
        } catch (failure) {
          return formatDateTime(milliseconds, locale);
        }
      }
      try {
        return formatter.format(Math.round(deltaSeconds / divisor), unit);
      } catch (failure) {
        return formatDateTime(milliseconds, locale);
      }
    }

    // ───────────────────────────── fx provenance ─────────────────────────────
    // `/overview` carries an `fx` block describing where the USD→CNY rate came from.
    // Every field is optional: a missing block or a partial block must not break the UI.
    const FX_SOURCE_META = {
      'pboc-cfets': { labelKey: 'fx.source.pboc' },
      'pboc-cfets-history': { labelKey: 'fx.source.history' },
      market: { labelKey: 'fx.source.market' },
      config: { labelKey: 'fx.source.config' },
    };

    function readFxInfo(data) {
      const block = data && typeof data === 'object' ? data.fx : null;
      if (!block || typeof block !== 'object') return null;
      return {
        rate: typeof block.usdCnyRate === 'number' && isFinite(block.usdCnyRate) && block.usdCnyRate > 0 ? block.usdCnyRate : null,
        source: typeof block.source === 'string' ? block.source : '',
        sourceLabel: typeof block.sourceLabel === 'string' ? block.sourceLabel : '',
        effectiveDate: typeof block.effectiveDate === 'string' ? block.effectiveDate : '',
        fetchedAt: typeof block.fetchedAt === 'number' && isFinite(block.fetchedAt) && block.fetchedAt > 0 ? block.fetchedAt : null,
        stale: block.stale === true,
      };
    }

    function fxSourceText(info, t) {
      if (!info) return '';
      const meta = FX_SOURCE_META[info.source];
      return meta ? t(meta.labelKey) : info.sourceLabel;
    }

    // ─────────────────────────── ledger provenance ───────────────────────────
    // Both the bill-history card and the account card name where the daily
    // spend comes from. The Host owns the vocabulary; unknown values render as
    // an em dash instead of crashing the card.
    const LEDGER_SOURCE_META = {
      'wallet-ledger': { labelKey: 'source.walletLedger' },
      monitor: { labelKey: 'source.monitor' },
      whale: { labelKey: 'source.whale' },
      'monitor+whale': { labelKey: 'source.monitorWhale' },
      'balance-sampling': { labelKey: 'source.balanceSampling' },
    };

    function ledgerSourceLabel(source, t) {
      const meta = typeof source === 'string' ? LEDGER_SOURCE_META[source] : null;
      return meta ? t(meta.labelKey) : '';
    }

    function fxDateShort(value) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof value === 'string' ? value : '');
      return match ? match[2] + '-' + match[3] : '';
    }

    function fxDegradedMark(info, t) {
      if (!info) return '';
      if (info.source === 'config') return t('fx.offline');
      if (info.stale === true) return t('fx.stale');
      return '';
    }

    function fxFootnoteParts(info, t, locale, fallbackRate) {
      const rate = info && info.rate !== null
        ? info.rate
        : (typeof fallbackRate === 'number' && isFinite(fallbackRate) && fallbackRate > 0 ? fallbackRate : null);
      if (rate === null) return null;
      const parts = [t('kpi.fxRate', { rate: formatNumber(rate, locale, 4) })];
      const sourceText = fxSourceText(info, t);
      if (sourceText) parts.push(sourceText);
      const dateText = fxDateShort(info && info.effectiveDate);
      if (dateText) parts.push(dateText);
      const degradedText = fxDegradedMark(info, t);
      if (degradedText) parts.push(degradedText);
      return { text: parts.join(' · '), degraded: Boolean(degradedText) };
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !isFinite(value) || value < 0) return DASH;
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let size = value;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      const digits = index === 0 || size >= 100 ? 0 : 1;
      return size.toFixed(digits) + ' ' + units[index];
    }

    function formatDuration(value, locale) {
      if (typeof value !== 'number' || !isFinite(value) || value < 0) return DASH;
      const totalSeconds = Math.floor(value / 1000);
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const unitText = (unit, amount) => {
        try {
          return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(amount);
        } catch (failure) {
          return String(amount);
        }
      };
      if (days > 0) return unitText('day', days) + ' ' + unitText('hour', hours);
      if (hours > 0) return unitText('hour', hours) + ' ' + unitText('minute', minutes);
      if (minutes > 0) return unitText('minute', minutes) + ' ' + unitText('second', seconds);
      return unitText('second', seconds);
    }

    function formatMs(value, t, locale) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      return formatNumber(value, locale, 0) + ' ' + t('unit.ms');
    }

    function formatSpeed(value, t, locale) {
      if (typeof value !== 'number' || !isFinite(value)) return DASH;
      return formatNumber(value, locale, 1) + ' ' + t('unit.tokensPerSec');
    }

    function toMillis(value) {
      if (typeof value === 'number' && isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return isFinite(parsed) ? parsed : 0;
      }
      if (value instanceof Date) return value.getTime();
      return 0;
    }

    function formatDateTime(value, locale) {
      const milliseconds = toMillis(value);
      if (!milliseconds) return DASH;
      let formatter = dateTimeFormatters.get(locale);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        dateTimeFormatters.set(locale, formatter);
      }
      return formatter.format(milliseconds);
    }

    function formatClock(value, locale) {
      const milliseconds = toMillis(value);
      if (!milliseconds) return DASH;
      let formatter = clockFormatters.get(locale);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        clockFormatters.set(locale, formatter);
      }
      return formatter.format(milliseconds);
    }

    function localeToIntl(active) {
      if (typeof active !== 'string' || !active) return 'en';
      const lower = active.toLowerCase();
      if (lower.indexOf('zh') === 0) return 'zh-CN';
      if (lower.indexOf('en') === 0) return 'en-US';
      return active;
    }

    function numberOrZero(value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    }

    // Money survives only inside this file as USD; every surface converts explicitly.
    // Cost fields arrive already converted to the requested currency (CNY by default).
    // convertMoney is kept only for account amounts quoted in the platform currency.
    function convertMoney(value, from, to, fxRate) {
      const amount = numberOrZero(value);
      const source = typeof from === 'string' ? from.toUpperCase() : 'USD';
      const target = typeof to === 'string' ? to.toUpperCase() : 'USD';
      if (source === target) return amount;
      const rate = numberOrZero(fxRate) || 1;
      if (source === 'CNY' && target === 'USD') return amount / rate;
      if (source === 'USD' && target === 'CNY') return amount * rate;
      return amount;
    }

    // Only absolute http(s) URLs from the Host are rendered as links.
    function safeHttpUrl(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return '';
      if (text.indexOf('://') < 0) return '';
      if (text.slice(0, 4) !== 'http') return '';
      return text;
    }

    // ───────────────────────────── small shared helpers ─────────────────────────────
    function rangeLabel(t, key) {
      if (key === 'today') return t('range.today');
      if (key === '7d') return t('range.7d');
      if (key === '14d') return t('range.14d');
      if (key === '30d') return t('range.30d');
      if (key === 'all') return t('range.all');
      return t('range.24h');
    }

    function currencyLabel(t, key) {
      return key === 'CNY' ? t('currency.CNY') : t('currency.USD');
    }

    function shortId(value) {
      const text = typeof value === 'string' ? value : '';
      if (!text) return DASH;
      return text.length > 10 ? text.slice(0, 6) + '…' : text;
    }

    function cwdTail(value) {
      const text = typeof value === 'string' ? value : '';
      if (!text) return '';
      const parts = text.split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : text;
    }

    function shortLabel(value) {
      const text = typeof value === 'string' ? value : '';
      return text.length > 9 ? text.slice(0, 9) : text;
    }

    function bucketLabel(bucket, locale) {
      if (bucket && typeof bucket.label === 'string' && bucket.label) return bucket.label;
      const milliseconds = toMillis(bucket && bucket.t);
      return milliseconds ? formatClock(milliseconds, locale) : '';
    }

    function coalesceBuckets(buckets, max) {
      const list = Array.isArray(buckets) ? buckets.filter((bucket) => bucket && typeof bucket === 'object') : [];
      if (list.length <= max) return list;
      const factor = Math.ceil(list.length / max);
      const merged = [];
      for (let index = 0; index < list.length; index += factor) {
        const chunk = list.slice(index, index + factor);
        const bucket = { t: chunk[0].t, label: chunk[0].label };
        for (const key of BUCKET_NUMERIC_KEYS) {
          bucket[key] = chunk.reduce((sum, item) => sum + numberOrZero(item[key]), 0);
        }
        merged.push(bucket);
      }
      return merged;
    }

    function bucketTotal(bucket) {
      return SERIES.reduce((sum, series) => sum + numberOrZero(bucket[series.key]), 0);
    }

    function hitRateOf(bucket) {
      const reader = numberOrZero(bucket.cacheReadTokens) + numberOrZero(bucket.uncachedInputTokens);
      return reader > 0 ? numberOrZero(bucket.cacheReadTokens) / reader : null;
    }

    function pressureColor(percent) {
      if (typeof percent !== 'number' || !isFinite(percent)) return C.idle;
      if (percent >= 85) return C.error;
      if (percent >= 60) return C.warn;
      return C.success;
    }

    function makeActivityProbe(layout) {
      return function isPanelVisible() {
        if (typeof document !== 'undefined' && document.hidden) return false;
        try {
          const info = layout && layout.panelInfo && typeof layout.panelInfo.getSnapshot === 'function'
            ? layout.panelInfo.getSnapshot()
            : null;
          if (info && Object.prototype.hasOwnProperty.call(info, 'activePanelId') && info.activePanelId !== PANEL_ID) return false;
        } catch (failure) {
          // The layout probe is advisory only — keep polling when it is unavailable.
        }
        return true;
      };
    }

    // ───────────────────────────── data hooks ─────────────────────────────
    function usePolledJson(props) {
      const url = props.url;
      const intervalMs = props.intervalMs;
      const timer = props.timer;
      const probe = props.probe;
      const [state, setState] = useState({ data: null, error: null, loading: true, fetchedAt: 0 });
      const [reloadToken, setReloadToken] = useState(0);
      const refresh = useCallback(() => setReloadToken((value) => value + 1), []);

      useEffect(() => {
        let alive = true;
        let busy = false;
        const load = async () => {
          if (busy) return;
          busy = true;
          try {
            const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
            if (!response.ok) {
              const failure = new Error('HTTP ' + response.status);
              failure.status = response.status;
              throw failure;
            }
            const payload = await response.json();
            if (alive) setState({ data: payload, error: null, loading: false, fetchedAt: Date.now() });
          } catch (failure) {
            if (alive) {
              setState((previous) => ({
                data: previous.data,
                error: failure,
                loading: false,
                fetchedAt: previous.fetchedAt,
              }));
            }
          } finally {
            busy = false;
          }
        };

        if (probe()) load();
        const disposers = [];
        if (timer && typeof timer.interval === 'function') {
          disposers.push(timer.interval(() => {
            if (probe()) load();
          }, intervalMs));
        } else if (typeof setInterval === 'function') {
          const handle = setInterval(() => {
            if (probe()) load();
          }, intervalMs);
          disposers.push(() => clearInterval(handle));
        }
        const onVisibilityChange = () => {
          if (!document.hidden && probe()) load();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange);
          disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
        }

        return () => {
          alive = false;
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (failure) {
              // Disposal must never break unmount.
            }
          }
        };
      }, [url, intervalMs, timer, probe, reloadToken]);

      return { data: state.data, error: state.error, loading: state.loading, fetchedAt: state.fetchedAt, refresh };
    }

    function useLocaleSnapshot(locale) {
      const subscribe = useCallback((listener) => {
        if (!locale || typeof locale.subscribe !== 'function') return () => {};
        return locale.subscribe(listener);
      }, [locale]);
      const getSnapshot = useCallback(() => {
        if (!locale || typeof locale.getLocale !== 'function') return EMPTY_LOCALE;
        return locale.getLocale() || EMPTY_LOCALE;
      }, [locale]);
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // ───────────────────────────── SVG primitives ─────────────────────────────
    const TAU = Math.PI * 2;
    const round3 = (value) => Math.round(value * 1000) / 1000;

    function polarPoint(cx, cy, radius, angle) {
      const radians = ((angle - 90) * Math.PI) / 180;
      return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
    }

    function arcPath(cx, cy, radius, inner, startAngle, endAngle) {
      const end = Math.min(endAngle, startAngle + 359.99);
      const startOuter = polarPoint(cx, cy, radius, startAngle);
      const endOuter = polarPoint(cx, cy, radius, end);
      const largeArc = end - startAngle > 180 ? 1 : 0;
      if (!(inner > 0)) {
        return 'M ' + round3(cx) + ' ' + round3(cy)
          + ' L ' + round3(startOuter.x) + ' ' + round3(startOuter.y)
          + ' A ' + round3(radius) + ' ' + round3(radius) + ' 0 ' + largeArc + ' 1 ' + round3(endOuter.x) + ' ' + round3(endOuter.y) + ' Z';
      }
      const startInner = polarPoint(cx, cy, inner, startAngle);
      const endInner = polarPoint(cx, cy, inner, end);
      return 'M ' + round3(startOuter.x) + ' ' + round3(startOuter.y)
        + ' A ' + round3(radius) + ' ' + round3(radius) + ' 0 ' + largeArc + ' 1 ' + round3(endOuter.x) + ' ' + round3(endOuter.y)
        + ' L ' + round3(endInner.x) + ' ' + round3(endInner.y)
        + ' A ' + round3(inner) + ' ' + round3(inner) + ' 0 ' + largeArc + ' 0 ' + round3(startInner.x) + ' ' + round3(startInner.y) + ' Z';
    }

    function Sparkline(props) {
      const values = Array.isArray(props.values)
        ? props.values.filter((value) => typeof value === 'number' && isFinite(value))
        : [];
      const height = props.height || 32;
      if (values.length < 2) {
        return h('div', { className: 'um-sparkline-empty', style: { height: height } });
      }
      const width = 100;
      const maximum = Math.max.apply(null, values);
      const minimum = Math.min.apply(null, values);
      const span = maximum - minimum || 1;
      const stepX = width / (values.length - 1);
      let line = '';
      values.forEach((value, index) => {
        const x = index * stepX;
        const y = height - ((value - minimum) / span) * (height - 6) - 3;
        line += (index === 0 ? 'M ' : ' L ') + round3(x) + ' ' + round3(y);
      });
      const area = line + ' L ' + width + ' ' + height + ' L 0 ' + height + ' Z';
      return h('svg', {
        className: 'um-sparkline',
        viewBox: '0 0 ' + width + ' ' + height,
        preserveAspectRatio: 'none',
        height: height,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: area, style: { fill: props.color || C.brand, opacity: 0.12 }, stroke: 'none' }),
        h('path', {
          d: line,
          fill: 'none',
          style: { stroke: props.color || C.brand },
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
        }));
    }

    function RingGauge(props) {
      const percent = typeof props.value === 'number' && isFinite(props.value)
        ? Math.max(0, Math.min(100, props.value))
        : null;
      const radius = 30;
      const circumference = TAU * radius;
      const dash = percent === null ? 0 : (percent / 100) * circumference;
      return h('div', { className: 'um-gauge' },
        h('div', { className: 'um-gauge-ring' },
          h('svg', { viewBox: '0 0 80 80', width: 84, height: 84, role: 'img', 'aria-label': props.label },
            h('circle', { cx: 40, cy: 40, r: radius, fill: 'none', style: { stroke: C.bg2 }, strokeWidth: 8 }),
            percent !== null
              ? h('circle', {
                cx: 40,
                cy: 40,
                r: radius,
                fill: 'none',
                style: { stroke: props.color || pressureColor(percent) },
                strokeWidth: 8,
                strokeLinecap: 'round',
                strokeDasharray: round3(dash) + ' ' + round3(circumference),
                transform: 'rotate(-90 40 40)',
                className: 'um-gauge-arc',
              })
              : null),
          h('div', { className: 'um-gauge-value' }, percent === null ? DASH : Math.round(percent) + '%')),
        h('div', { className: 'um-gauge-label' }, props.label),
        props.detail ? h('div', { className: 'um-gauge-detail', title: props.detail }, props.detail) : null);
    }

    function DonutChart(props) {
      const slices = props.slices || [];
      const size = props.size || 172;
      const total = slices.reduce((sum, slice) => sum + Math.max(0, numberOrZero(slice.value)), 0);
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2 - 6;
      const inner = radius * 0.6;
      let angle = 0;
      const paths = [];
      for (const slice of slices) {
        const value = Math.max(0, numberOrZero(slice.value));
        if (value <= 0) continue;
        const sweep = total > 0 ? (value / total) * 360 : 0;
        paths.push(h('path', {
          key: slice.key,
          d: arcPath(cx, cy, radius, inner, angle, angle + sweep),
          style: { fill: slice.color },
          stroke: C.bg1,
          strokeWidth: 1,
        }));
        angle += sweep;
      }
      if (!paths.length) {
        paths.push(h('circle', {
          key: 'empty',
          cx: cx,
          cy: cy,
          r: (radius + inner) / 2,
          fill: 'none',
          style: { stroke: C.border1 },
          strokeWidth: 1,
          strokeDasharray: '3 4',
        }));
      }
      return h('svg', {
        className: 'um-donut',
        viewBox: '0 0 ' + size + ' ' + size,
        width: size,
        height: size,
        role: 'img',
        'aria-label': props.label || '',
      },
        paths,
        props.centerValue
          ? h('text', { x: cx, y: cy - 2, textAnchor: 'middle', style: { fill: C.label1 }, fontSize: 15, fontWeight: 600 }, props.centerValue)
          : null,
        props.centerLabel
          ? h('text', { x: cx, y: cy + 13, textAnchor: 'middle', style: { fill: C.label3 }, fontSize: 9 }, props.centerLabel)
          : null);
    }

    function Legend(props) {
      const items = props.items || [];
      return h('ul', { className: 'um-legend' }, items.map((item) => h('li', { key: item.key, className: 'um-legend-item' },
        h('span', { className: 'um-legend-chip', style: { background: item.color } }),
        h('span', { className: 'um-legend-label', title: item.label }, item.label),
        h('span', { className: 'um-legend-value' }, item.valueLabel),
        h('span', { className: 'um-legend-percent' }, item.percentLabel))));
    }

    function EmptyState(props) {
      return h('div', { className: 'um-empty' }, h('span', null, props.label));
    }

    function Card(props) {
      const hasHead = Boolean(props.title || props.desc || props.right);
      return h('section', { className: 'um-card' },
        hasHead
          ? h('header', { className: 'um-card-head' },
            h('div', null,
              props.title ? h('h2', { className: 'um-card-title' }, props.title) : null,
              props.desc ? h('p', { className: 'um-card-desc' }, props.desc) : null),
            props.right || null)
          : null,
        h('div', { className: 'um-card-body' }, props.children));
    }

    function KpiCard(props) {
      return h('div', { className: 'um-kpi' },
        h('div', { className: 'um-kpi-title', title: props.title }, props.title),
        h('div', { className: 'um-kpi-value' }, props.value),
        props.hint ? h('div', { className: 'um-kpi-hint', title: props.hint }, props.hint) : null,
        props.trend && props.trend.length > 1
          ? h('div', { className: 'um-kpi-trend' }, h(Sparkline, { values: props.trend, height: 30, color: props.trendColor || C.brand }))
          : null,
        props.foot ? h('div', { className: 'um-kpi-foot' }, props.foot) : null);
    }

    function MetricBars(props) {
      const items = props.items || [];
      const maximum = items.reduce((max, item) => Math.max(max, numberOrZero(item.value)), 0) || 1;
      return h('div', { className: 'um-metric-bars' }, items.map((item) => h('div', { key: item.key, className: 'um-metric-row' },
        h('span', { className: 'um-metric-label' }, item.label),
        h('span', { className: 'um-metric-track' },
          h('span', { className: 'um-metric-fill', style: { width: Math.max(2, (numberOrZero(item.value) / maximum) * 100) + '%' } })),
        h('span', { className: 'um-metric-value' }, item.formatted))));
    }

    // ───────────────────────────── toolbar / status ─────────────────────────────
    function Toolbar(props) {
      const t = props.t;
      return h('div', { className: 'um-toolbar' },
        h('div', { className: 'um-toolbar-main' },
          h('div', { className: 'um-toolbar-titles' },
            h('h1', { className: 'um-title' }, t('panel.title')),
            h('p', { className: 'um-subtitle' }, t('panel.subtitle'))),
          h('div', { className: 'um-toolbar-actions' },
            h('div', { className: 'um-seg', role: 'group', 'aria-label': t('toolbar.range') },
              RANGES.map((range) => h('button', {
                key: range,
                type: 'button',
                className: 'um-seg-btn',
                'data-active': range === props.range,
                'aria-pressed': range === props.range,
                onClick: () => props.onRange(range),
              }, rangeLabel(t, range)))),
            h('div', { className: 'um-seg', role: 'group', 'aria-label': t('toolbar.currency') },
              CURRENCIES.map((currency) => h('button', {
                key: currency,
                type: 'button',
                className: 'um-seg-btn',
                'data-active': currency === props.currency,
                'aria-pressed': currency === props.currency,
                onClick: () => props.onCurrency(currency),
              }, currencyLabel(t, currency)))),
            h('button', {
              type: 'button',
              className: 'um-btn um-btn-primary',
              onClick: props.onRefresh,
              disabled: props.loading,
            }, props.loading ? t('status.refreshing') : t('action.refresh')),
            props.updatedAt
              ? h('span', { className: 'um-updated' }, t('status.updatedAt', { time: formatClock(props.updatedAt, props.locale) }))
              : null)));
    }

    function ScanBar(props) {
      const scan = props.scan;
      if (!scan || scan.scanning !== true) return null;
      const total = numberOrZero(scan.sessionsTotal);
      const done = numberOrZero(scan.scanned);
      const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
      return h('div', { className: 'um-scan', role: 'status' },
        h('span', { className: 'um-scan-text' }, props.t('status.scanning', { scanned: done, total: total })),
        h('div', { className: 'um-progress' }, h('i', { style: { width: percent + '%' } })));
    }

    function ErrorBar(props) {
      const status = props.error && typeof props.error.status === 'number' ? props.error.status : 0;
      const message = status ? props.t('error.loadFailed', { status: status }) : props.t('error.network');
      return h('div', { className: 'um-error', role: 'alert' },
        h('span', { className: 'um-error-text' }, message),
        h('button', { type: 'button', className: 'um-btn', onClick: props.onRetry }, props.t('action.retry')));
    }

    function SkeletonBlock(props) {
      return h('div', {
        className: 'um-skeleton',
        style: { height: props.height || 16, width: props.width || '100%', borderRadius: props.radius || 8 },
      });
    }

    function SkeletonPage(props) {
      const cards = [0, 1, 2, 3, 4];
      return h('div', { className: 'um-skeleton-page', 'aria-busy': 'true', 'aria-label': props.t('status.loading') },
        h('div', { className: 'um-kpi-row' }, cards.map((index) => h('div', { key: index, className: 'um-kpi' },
          h(SkeletonBlock, { height: 11, width: '45%' }),
          h(SkeletonBlock, { height: 26, width: '68%' }),
          h(SkeletonBlock, { height: 30 })))),
        h('div', { className: 'um-grid2' },
          h('div', { className: 'um-card' }, h('div', { className: 'um-card-body' }, h(SkeletonBlock, { height: 220 }))),
          h('div', { className: 'um-card' }, h('div', { className: 'um-card-body' }, h(SkeletonBlock, { height: 220 })))),
        h('div', { className: 'um-card' }, h('div', { className: 'um-card-body' }, h(SkeletonBlock, { height: 160 }))));
    }

    // ───────────────────────────── KPI row ─────────────────────────────
    function KpiRow(props) {
      const t = props.t;
      const locale = props.locale;
      const data = props.data;
      const kpi = data.kpi || {};
      const buckets = (data.series && Array.isArray(data.series.buckets)) ? data.series.buckets : [];
      const trendTokens = buckets.map((bucket) => numberOrZero(bucket.totalTokens));
      const trendCost = buckets.map((bucket) => numberOrZero(bucket.cost));
      const trendSessions = buckets.map((bucket) => numberOrZero(bucket.sessions));
      const trendRequests = buckets.map((bucket) => numberOrZero(bucket.requests));
      const trendHitRate = buckets.map(hitRateOf).filter((value) => value !== null);
      const currency = kpi.currency || props.currency;
      // CNY is authoritative; the subtitle always carries the converted counterpart.
      const costConverted = currency === 'USD' && kpi.costCNY !== undefined && kpi.costCNY !== null
        ? formatMoney(numberOrZero(kpi.costCNY), 'CNY', locale)
        : formatMoney(numberOrZero(kpi.costUSD), 'USD', locale);
      const fxInfo = readFxInfo(data);
      const fxFootnote = fxFootnoteParts(fxInfo, t, locale, kpi.fxRate);
      const fxFoot = fxFootnote
        ? h('span', { style: fxFootnote.degraded ? { color: C.warn } : null }, fxFootnote.text)
        : null;
      return h('div', { className: 'um-kpi-row' },
        h(KpiCard, {
          title: t('kpi.totalTokens'),
          value: formatTokens(numberOrZero(kpi.totalTokens)),
          hint: t('kpi.totalHint', { sessions: numberOrZero(kpi.sessions), turns: numberOrZero(kpi.turns) }),
          foot: t('kpi.avgPerTurn', { value: formatTokens(numberOrZero(kpi.avgTokensPerTurn)) }),
          trend: trendTokens,
          trendColor: C.brand,
        }),
        h(KpiCard, {
          title: t('kpi.cost'),
          value: formatMoney(numberOrZero(kpi.cost), currency, locale),
          hint: t('kpi.costHint', { value: costConverted }),
          foot: fxFoot,
          trend: trendCost,
          trendColor: C.success,
        }),
        h(KpiCard, {
          title: t('kpi.sessions'),
          value: formatNumber(numberOrZero(kpi.sessions), locale, 0),
          hint: t('kpi.sessionsHint', { total: numberOrZero((data.scan && (data.scan.sessionsTotal || data.scan.scanned)) || 0) }),
          trend: trendSessions,
          trendColor: C.warn,
        }),
        h(KpiCard, {
          title: t('kpi.activeSessions'),
          value: formatNumber(numberOrZero(kpi.activeSessions), locale, 0),
          hint: t('kpi.activeHint'),
          trend: trendRequests,
          trendColor: C.error,
        }),
        h(KpiCard, {
          title: t('kpi.cacheHit'),
          value: formatRatio(numberOrZero(kpi.cacheHitRate)),
          hint: t('kpi.cacheHint', { value: formatTokens(numberOrZero(kpi.cacheReadTokens)) }),
          trend: trendHitRate,
          trendColor: C.idle,
        }));
    }

    // ───────────────────────────── stacked bar chart ─────────────────────────────
    function StackedBarChart(props) {
      const t = props.t;
      const locale = props.locale;
      const [hoverIndex, setHoverIndex] = useState(-1);
      const buckets = useMemo(() => coalesceBuckets(props.buckets, MAX_BARS), [props.buckets]);
      const totals = useMemo(() => buckets.map(bucketTotal), [buckets]);
      const maximum = Math.max(1, Math.max.apply(null, totals));
      const width = 640;
      const height = 232;
      const padLeft = 54;
      const padRight = 10;
      const padTop = 12;
      const padBottom = 28;
      const plotWidth = width - padLeft - padRight;
      const plotHeight = height - padTop - padBottom;
      const groupWidth = plotWidth / Math.max(1, buckets.length);
      const barWidth = Math.max(3, Math.min(34, groupWidth * 0.68));
      const ticks = [0, 0.5, 1].map((fraction) => ({
        key: 'tick-' + fraction,
        y: padTop + plotHeight * (1 - fraction),
        label: formatTokens(maximum * fraction),
      }));
      const labelEvery = Math.max(1, Math.ceil(buckets.length / 7));
      const hoverBucket = hoverIndex >= 0 && hoverIndex < buckets.length ? buckets[hoverIndex] : null;

      return h('div', { className: 'um-chart' },
        h('svg', {
          className: 'um-chart-svg',
          viewBox: '0 0 ' + width + ' ' + height,
          role: 'img',
          'aria-label': t('chart.tokens'),
        },
          ticks.map((tick) => h('g', { key: tick.key },
            h('line', { x1: padLeft, x2: width - padRight, y1: tick.y, y2: tick.y, style: { stroke: C.border1 }, strokeWidth: 1 }),
            h('text', { x: padLeft - 8, y: tick.y + 3.5, textAnchor: 'end', style: { fill: C.label3 }, fontSize: 10 }, tick.label))),
          buckets.map((bucket, index) => {
            let cursorY = padTop + plotHeight;
            const x = padLeft + index * groupWidth + (groupWidth - barWidth) / 2;
            const segments = SERIES.map((series) => {
              const value = numberOrZero(bucket[series.key]);
              if (value <= 0) return null;
              const segmentHeight = (value / maximum) * plotHeight;
              cursorY -= segmentHeight;
              return h('rect', {
                key: series.key,
                x: x,
                y: cursorY,
                width: barWidth,
                height: Math.max(0.5, segmentHeight),
                style: { fill: series.color },
                rx: 1,
              });
            }).filter(Boolean);
            return h('g', { key: 'bucket-' + index },
              segments,
              h('rect', {
                x: padLeft + index * groupWidth,
                y: padTop,
                width: groupWidth,
                height: plotHeight,
                fill: 'transparent',
                onMouseEnter: () => setHoverIndex(index),
                onMouseLeave: () => setHoverIndex(-1),
              }),
              index % labelEvery === 0
                ? h('text', {
                  x: padLeft + index * groupWidth + groupWidth / 2,
                  y: height - 9,
                  textAnchor: 'middle',
                  style: { fill: C.label3 },
                  fontSize: 10,
                }, shortLabel(bucketLabel(bucket, locale)))
                : null);
          }),
          hoverBucket
            ? h('line', {
              x1: padLeft + hoverIndex * groupWidth,
              x2: padLeft + hoverIndex * groupWidth,
              y1: padTop,
              y2: padTop + plotHeight,
              style: { stroke: C.border2 },
              strokeWidth: 1,
              strokeDasharray: '3 3',
            })
            : null),
        hoverBucket
          ? h('div', {
            className: 'um-tooltip',
            style: { left: ((padLeft + hoverIndex * groupWidth + groupWidth / 2) / width) * 100 + '%' },
          },
            h('div', { className: 'um-tooltip-title' }, bucketLabel(hoverBucket, locale)),
            SERIES.map((series) => h('div', { key: series.key, className: 'um-tooltip-row' },
              h('span', { className: 'um-tooltip-chip', style: { background: series.color } }),
              h('span', { className: 'um-tooltip-label' }, t(series.labelKey)),
              h('span', { className: 'um-tooltip-value' }, formatTokens(numberOrZero(hoverBucket[series.key]))))),
            h('div', { className: 'um-tooltip-total' }, t('tooltip.total', { value: formatTokens(totals[hoverIndex]) })))
          : null);
    }

    // ───────────────────────────── composition + models ─────────────────────────────
    function CompositionChart(props) {
      const t = props.t;
      const kpi = props.kpi;
      const slices = SERIES.map((series) => ({
        key: series.key,
        label: t(series.labelKey),
        value: numberOrZero(kpi[series.key]),
        color: series.color,
      }));
      const total = slices.reduce((sum, slice) => sum + slice.value, 0);
      const legend = slices.map((slice) => ({
        key: slice.key,
        label: slice.label,
        color: slice.color,
        valueLabel: formatTokens(slice.value),
        percentLabel: formatRatio(total > 0 ? slice.value / total : 0),
      }));
      return h('div', { className: 'um-composition' },
        h(DonutChart, {
          slices: slices,
          label: t('chart.composition'),
          centerValue: formatTokens(total),
          centerLabel: t('common.tokens'),
        }),
        h(Legend, { items: legend }));
    }

    const ModelsTable = memo(function ModelsTable(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const models = Array.isArray(props.models) ? props.models : [];
      if (!models.length) return h(EmptyState, { label: t('common.noData') });
      return h('div', { className: 'um-table-wrap' },
        h('table', { className: 'um-table' },
          h('thead', null, h('tr', null,
            h('th', null, t('models.name')),
            h('th', { className: 'um-num' }, t('models.requests')),
            h('th', { className: 'um-num' }, t('models.tokens')),
            h('th', { className: 'um-num' }, t('models.cost')),
            h('th', { className: 'um-num' }, t('models.hitRate')),
            h('th', { className: 'um-num' }, t('models.speed')))),
          h('tbody', null, models.map((model, index) => {
            const name = model.model || model.provider || DASH;
            return h('tr', { key: (model.provider || '') + '|' + name + '|' + index },
              h('td', null,
                h('div', { className: 'um-session-id', title: name }, name),
                model.provider && model.provider !== name
                  ? h('div', { className: 'um-session-path' }, model.provider)
                  : null),
              h('td', { className: 'um-num' }, formatNumber(numberOrZero(model.requests), locale, 0)),
              h('td', { className: 'um-num' }, formatTokens(numberOrZero(model.totalTokens))),
              h('td', { className: 'um-num' }, model.priced === false ? t('models.unpriced') : formatMoney(numberOrZero(model.cost), currency, locale)),
              h('td', { className: 'um-num' }, formatRatio(model.cacheHitRate)),
              h('td', { className: 'um-num' }, formatSpeed(model.tokensPerSec, t, locale)));
          }))));
    });

    function ModelsPanel(props) {
      const t = props.t;
      const models = Array.isArray(props.models) ? props.models : [];
      const sorted = useMemo(() => models
        .slice()
        .sort((left, right) => numberOrZero(right.totalTokens) - numberOrZero(left.totalTokens)), [models]);
      const top = sorted.slice(0, 5);
      const rest = sorted.slice(5);
      const restTotal = rest.reduce((sum, model) => sum + numberOrZero(model.totalTokens), 0);
      const slices = top.map((model, index) => ({
        key: 'model-' + index,
        label: model.model || model.provider || DASH,
        value: numberOrZero(model.totalTokens),
        color: MODEL_PALETTE[index % MODEL_PALETTE.length],
      }));
      if (restTotal > 0) {
        slices.push({ key: 'models-other', label: t('common.other'), value: restTotal, color: MODEL_PALETTE[MODEL_PALETTE.length - 1] });
      }
      const total = slices.reduce((sum, slice) => sum + slice.value, 0);
      const legend = slices.map((slice) => ({
        key: slice.key,
        label: slice.label,
        color: slice.color,
        valueLabel: formatTokens(slice.value),
        percentLabel: formatRatio(total > 0 ? slice.value / total : 0),
      }));
      return h('div', { className: 'um-models' },
        h('div', { className: 'um-composition' },
          h(DonutChart, {
            slices: slices,
            label: t('chart.models'),
            centerValue: formatTokens(total),
            centerLabel: t('common.tokens'),
          }),
          h(Legend, { items: legend })),
        h(ModelsTable, { t: t, locale: props.locale, currency: props.currency, models: props.models }));
    }

    // ───────────────────────────── live runtime panel ─────────────────────────────
    const LivePanel = memo(function LivePanel(props) {
      const t = props.t;
      const locale = props.locale;
      const live = usePolledJson({
        url: API_BASE + '/live',
        intervalMs: LIVE_INTERVAL_MS,
        timer: props.timer,
        probe: props.probe,
      });
      const data = live.data;
      if (!data) {
        return live.error
          ? h(EmptyState, { label: t('error.network') })
          : h(SkeletonBlock, { height: 236 });
      }
      const host = data.host || {};
      const processInfo = data.process || {};
      const gpu = data.gpu || {};
      const counters = data.counters || {};
      const uptime = data.uptime || {};
      const history = data.history || {};
      const loadAvg = Array.isArray(host.loadAvg) ? host.loadAvg : [];
      const cpuDetail = host.cores
        ? t('live.cpuDetail', {
          cores: t('live.cores', { n: numberOrZero(host.cores) }),
          load: formatNumber(numberOrZero(loadAvg[0]), locale, 2),
        })
        : '';
      const facts = [
        { key: 'uptime', label: t('live.uptime'), value: formatDuration(uptime.processMs, locale) },
        { key: 'rss', label: t('live.rss'), value: formatBytes(processInfo.rssBytes) },
        { key: 'heap', label: t('live.heap'), value: formatBytes(processInfo.heapUsedBytes) + ' / ' + formatBytes(processInfo.heapTotalBytes) },
        { key: 'threads', label: t('live.threads'), value: formatNumber(numberOrZero(processInfo.threads), locale, 0) },
        { key: 'gpuMem', label: t('live.gpuMem'), value: gpu.available ? formatBytes(gpu.memUsedBytes) + ' / ' + formatBytes(gpu.memTotalBytes) : DASH },
        { key: 'hostUptime', label: t('live.hostUptime'), value: formatDuration(uptime.hostMs, locale) },
      ];
      return h('div', { className: 'um-live' },
        h('div', { className: 'um-live-gauges' },
          h(RingGauge, { label: t('live.cpu'), value: host.cpuPercent, detail: cpuDetail }),
          h(RingGauge, {
            label: t('live.mem'),
            value: host.memPercent,
            detail: t('live.memDetail', { used: formatBytes(host.memUsedBytes), total: formatBytes(host.memTotalBytes) }),
          }),
          h(RingGauge, {
            label: t('live.gpu'),
            value: gpu.available ? gpu.utilPercent : null,
            detail: gpu.available ? (gpu.name || '') : t('live.gpuOff'),
          })),
        h('div', { className: 'um-live-spark' },
          h('div', { className: 'um-live-spark-head' },
            h('span', null, t('live.cpuHistory')),
            h('b', null, formatPercentPoints(host.cpuPercent))),
          h(Sparkline, { values: history.cpu, height: 30, color: C.brand })),
        h('div', { className: 'um-live-spark' },
          h('div', { className: 'um-live-spark-head' },
            h('span', null, t('live.tokenHistory')),
            h('b', null, formatTokens(numberOrZero(counters.tokensPerMin)))),
          h(Sparkline, { values: history.tokensPerMin, height: 30, color: C.success })),
        h('div', { className: 'um-live-facts' }, facts.map((fact) => h('div', { key: fact.key, className: 'um-fact' },
          h('div', { className: 'um-fact-label' }, fact.label),
          h('div', { className: 'um-fact-value', title: fact.value }, fact.value)))));
    });

    // ───────────────────────────── sessions table ─────────────────────────────
    const SESSION_COLUMNS = [
      { key: 'id', labelKey: 'sessions.col.session', numeric: false, sortable: false },
      { key: 'requests', labelKey: 'sessions.col.requests', numeric: true, sortable: true },
      { key: 'totalTokens', labelKey: 'sessions.col.tokens', numeric: true, sortable: true },
      { key: 'cacheHitRate', labelKey: 'sessions.col.hitRate', numeric: true, sortable: true },
      { key: 'cost', labelKey: 'sessions.col.cost', numeric: true, sortable: true },
      { key: 'tokensPerSec', labelKey: 'sessions.col.speed', numeric: true, sortable: true },
      { key: 'avgTtftMs', labelKey: 'sessions.col.ttft', numeric: true, sortable: true },
      { key: 'lastActivityAt', labelKey: 'sessions.col.lastActive', numeric: true, sortable: true },
    ];

    function sessionSortValue(session, key) {
      const raw = session[key];
      if (SESSION_DATE_KEYS[key]) {
        const milliseconds = toMillis(raw);
        return milliseconds || 0;
      }
      const value = typeof raw === 'number' ? raw : Number(raw);
      return isFinite(value) ? value : 0;
    }

    function sessionMatches(session, query) {
      const parts = [session.id, session.title, session.cwd, session.agentPreset, session.origin];
      if (Array.isArray(session.models)) {
        for (const model of session.models) {
          if (typeof model === 'string') parts.push(model);
          else if (model && typeof model === 'object') parts.push(model.provider, model.model);
        }
      }
      return parts.filter((part) => typeof part === 'string').join(' ').toLowerCase().indexOf(query) !== -1;
    }

    const SessionRow = memo(function SessionRow(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const session = props.session;
      return h('tr', null,
        h('td', null,
          h('div', { className: 'um-session' },
            h('div', { className: 'um-session-id', title: session.title || session.id || '' },
              shortId(session.id),
              session.live ? h('span', { className: 'um-badge' }, h('span', { className: 'um-live-dot' }), t('status.live')) : null),
            h('div', { className: 'um-session-path', title: session.cwd || '' }, cwdTail(session.cwd)))),
        h('td', { className: 'um-num' }, formatNumber(numberOrZero(session.requests), locale, 0)),
        h('td', { className: 'um-num' }, formatTokens(numberOrZero(session.totalTokens))),
        h('td', { className: 'um-num' }, formatRatio(session.cacheHitRate)),
        h('td', { className: 'um-num' }, formatMoney(numberOrZero(session.cost), currency, locale)),
        h('td', { className: 'um-num' }, formatSpeed(session.tokensPerSec, t, locale)),
        h('td', { className: 'um-num' }, formatMs(session.avgTtftMs, t, locale)),
        h('td', { className: 'um-num', title: session.lastActivityAt || '' }, formatDateTime(session.lastActivityAt, locale)));
    });

    function SessionsTable(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const sessions = Array.isArray(props.sessions) ? props.sessions : [];
      const [query, setQuery] = useState('');
      const [sort, setSort] = useState({ key: 'totalTokens', dir: 'desc' });
      const [visible, setVisible] = useState(SESSION_STEP);

      useEffect(() => {
        setVisible(SESSION_STEP);
      }, [query, sort.key, sort.dir]);

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matched = needle
          ? sessions.filter((session) => sessionMatches(session, needle))
          : sessions.slice();
        matched.sort((left, right) => {
          const delta = sessionSortValue(left, sort.key) - sessionSortValue(right, sort.key);
          return sort.dir === 'asc' ? delta : -delta;
        });
        return matched;
      }, [sessions, query, sort]);

      const shown = filtered.slice(0, visible);
      const remaining = Math.max(0, filtered.length - shown.length);

      const toggleSort = (key) => {
        setSort((previous) => previous.key === key
          ? { key: key, dir: previous.dir === 'desc' ? 'asc' : 'desc' }
          : { key: key, dir: 'desc' });
      };

      return h('div', { className: 'um-sessions' },
        h('div', { className: 'um-table-toolbar' },
          h('input', {
            className: 'um-search-input',
            type: 'search',
            value: query,
            placeholder: t('sessions.search'),
            'aria-label': t('sessions.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { className: 'um-count' }, t('sessions.count', { n: filtered.length }))),
        !sessions.length
          ? h(EmptyState, { label: t('sessions.empty') })
          : h(Fragment, null,
            h('div', { className: 'um-table-wrap' },
              h('table', { className: 'um-table' },
                h('thead', null, h('tr', null, SESSION_COLUMNS.map((column) => h('th', {
                  key: column.key,
                  className: column.numeric ? 'um-num' : null,
                  'aria-sort': sort.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
                },
                  column.sortable
                    ? h('button', {
                      type: 'button',
                      className: 'um-sort',
                      'data-active': sort.key === column.key,
                      onClick: () => toggleSort(column.key),
                    }, t(column.labelKey), sort.key === column.key
                      ? h('span', { 'aria-hidden': 'true' }, sort.dir === 'asc' ? '↑' : '↓')
                      : null)
                    : t(column.labelKey))))),
                h('tbody', null, shown.map((session) => h(SessionRow, {
                  key: session.id,
                  session: session,
                  t: t,
                  locale: locale,
                  currency: currency,
                }))))),
            !filtered.length
              ? h(EmptyState, { label: t('sessions.noMatch') })
              : null,
            remaining > 0
              ? h('div', { className: 'um-showmore' },
                h('button', { type: 'button', className: 'um-btn', onClick: () => setVisible((value) => value + SESSION_STEP) },
                  t('sessions.showMore', { n: remaining })))
              : null));
    }

    // ───────────────────────────── performance panel ─────────────────────────────
    function PerformancePanel(props) {
      const t = props.t;
      const locale = props.locale;
      const performance = props.performance;
      if (!performance || typeof performance !== 'object') return h(EmptyState, { label: t('perf.empty') });
      const ttft = performance.ttft || {};
      const speed = performance.tokensPerSec || {};
      const ttftItems = [
        { key: 'ttft-avg', label: t('perf.avg'), value: ttft.avg, formatted: formatMs(ttft.avg, t, locale) },
        { key: 'ttft-p50', label: t('perf.p50'), value: ttft.p50, formatted: formatMs(ttft.p50, t, locale) },
        { key: 'ttft-p90', label: t('perf.p90'), value: ttft.p90, formatted: formatMs(ttft.p90, t, locale) },
      ];
      const speedItems = [
        { key: 'speed-avg', label: t('perf.avg'), value: speed.avg, formatted: formatSpeed(speed.avg, t, locale) },
        { key: 'speed-p50', label: t('perf.p50'), value: speed.p50, formatted: formatSpeed(speed.p50, t, locale) },
        { key: 'speed-p90', label: t('perf.p90'), value: speed.p90, formatted: formatSpeed(speed.p90, t, locale) },
      ];
      const toolMs = numberOrZero(performance.toolMs);
      const llmMs = numberOrZero(performance.llmMs);
      const shareTotal = toolMs + llmMs;
      const toolPart = shareTotal > 0 ? toolMs / shareTotal : Math.min(1, Math.max(0, numberOrZero(performance.toolShare)));
      const llmPart = 1 - toolPart;
      const stats = [
        { key: 'cache', label: t('perf.cacheHit'), value: formatRatio(performance.cacheHitRate) },
        { key: 'rpt', label: t('perf.requestsPerTurn'), value: formatNumber(performance.requestsPerTurn, locale, 2) },
        { key: 'tpt', label: t('perf.toolCallsPerTurn'), value: formatNumber(performance.toolCallsPerTurn, locale, 2) },
        { key: 'err', label: t('perf.errorTurns'), value: formatNumber(numberOrZero(performance.errorTurns), locale, 0) },
        { key: 'int', label: t('perf.interruptedTurns'), value: formatNumber(numberOrZero(performance.interruptedTurns), locale, 0) },
        { key: 'total', label: t('perf.totalTurns'), value: formatNumber(numberOrZero(performance.totalTurns), locale, 0) },
      ];
      const shareItems = [
        { key: 'tool', label: t('perf.shareTool'), color: C.brand, percent: formatRatio(toolPart), value: formatMs(toolMs, t, locale) },
        { key: 'llm', label: t('perf.shareLlm'), color: C.success, percent: formatRatio(llmPart), value: formatMs(llmMs, t, locale) },
      ];
      return h('div', { className: 'um-perf' },
        h('div', { className: 'um-perf-grid' },
          h('div', { className: 'um-subcard' },
            h('div', { className: 'um-subcard-title' }, t('perf.ttft')),
            h(MetricBars, { items: ttftItems }),
            h('div', { className: 'um-subcard-note' }, t('perf.samples', { n: numberOrZero(ttft.samples) }))),
          h('div', { className: 'um-subcard' },
            h('div', { className: 'um-subcard-title' }, t('perf.speed')),
            h(MetricBars, { items: speedItems }),
            h('div', { className: 'um-subcard-note' }, t('perf.samples', { n: numberOrZero(speed.samples) })))),
        h('div', { className: 'um-perf-grid' },
          h('div', { className: 'um-subcard' },
            h('div', { className: 'um-subcard-title' }, t('perf.share')),
            h('div', { className: 'um-share-bar' },
              shareItems.map((item) => (item.key === 'tool' ? toolPart : llmPart) > 0
                ? h('span', {
                  key: item.key,
                  className: 'um-share-seg',
                  style: { width: ((item.key === 'tool' ? toolPart : llmPart) * 100) + '%', background: item.color },
                })
                : null)),
            h('div', { className: 'um-share-legend' }, shareItems.map((item) => h('span', { key: item.key },
              h('i', { className: 'um-chip', style: { background: item.color } }),
              t('perf.shareItem', { label: item.label, percent: item.percent, value: item.value }))))),
          h('div', { className: 'um-subcard' },
            h('div', { className: 'um-subcard-title' }, t('perf.stats')),
            h('div', { className: 'um-stat-grid' }, stats.map((item) => h('div', { key: item.key, className: 'um-stat' },
              h('div', { className: 'um-stat-label', title: item.label }, item.label),
              h('div', { className: 'um-stat-value' }, item.value)))))));
    }

    // ───────────────────────────── v2: reconciliation strip ─────────────────────────────
    function ReconcileBar(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const fxRate = props.fxRate;
      const ledgerData = props.ledger && props.ledger.data;
      const accountData = props.account && props.account.data;
      const ledgerTotals = (ledgerData && ledgerData.totals) || null;
      const accountCurrency = (accountData && typeof accountData.currency === 'string' && accountData.currency) || '';
      const spendToday = accountData && accountData.spend ? accountData.spend.today : null;
      const hasBill = accountData && typeof spendToday === 'number' && isFinite(spendToday);
      const ledgerCost = ledgerTotals && typeof ledgerTotals.cost === 'number' && isFinite(ledgerTotals.cost)
        ? ledgerTotals.cost
        : null;
      const billToday = hasBill ? convertMoney(spendToday, accountCurrency, currency, fxRate) : null;
      let deviation = null;
      if (hasBill && ledgerCost !== null && billToday > 0) deviation = ((ledgerCost - billToday) / billToday) * 100;
      const deviationColor = deviation === null ? C.label4 : Math.abs(deviation) <= 10 ? C.success : Math.abs(deviation) <= 30 ? C.warn : C.error;
      return h('div', { className: 'um-reconcile' },
        h('span', { className: 'um-reconcile-title' }, t('reconcile.title')),
        h('span', { className: 'um-reconcile-item' },
          h('span', { className: 'um-reconcile-label' }, t('reconcile.ledger')),
          h('span', { className: 'um-reconcile-value' }, ledgerCost === null ? DASH : formatMoney(ledgerCost, currency, locale))),
        h('span', { className: 'um-reconcile-item' },
          h('span', { className: 'um-reconcile-label' }, t('reconcile.bill')),
          h('span', { className: 'um-reconcile-value' }, billToday === null ? DASH : formatMoney(billToday, currency, locale))),
        deviation === null
          ? h('span', { className: 'um-deviation', style: { color: C.label4 } }, t('reconcile.empty'))
          : h('span', {
            className: 'um-deviation',
            style: {
              color: deviationColor,
              background: 'color-mix(in oklab, ' + deviationColor + ' 16%, transparent)',
            },
          }, t('reconcile.deviation', { value: formatSignedPercent(deviation) })),
        h('span', { className: 'um-reconcile-note' }, t('reconcile.note')));
    }

    // ───────────────────────────── v2: all-call ledger ─────────────────────────────
    function ledgerPurposeRows(byPurpose) {
      const map = new Map();
      const list = Array.isArray(byPurpose) ? byPurpose : [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const raw = typeof entry.purpose === 'string' ? entry.purpose : 'other';
        const known = PURPOSE_META.some((item) => item.key === raw) ? raw : 'other';
        const previous = map.get(known) || { requests: 0, totalTokens: 0, cost: 0 };
        map.set(known, {
          requests: previous.requests + numberOrZero(entry.requests),
          totalTokens: previous.totalTokens + numberOrZero(entry.totalTokens),
          cost: previous.cost + numberOrZero(entry.cost),
        });
      }
      return PURPOSE_META.map((meta) => {
        const value = map.get(meta.key) || { requests: 0, totalTokens: 0, cost: 0 };
        return {
          key: meta.key,
          labelKey: meta.labelKey,
          color: meta.color,
          requests: value.requests,
          totalTokens: value.totalTokens,
          cost: value.cost,
        };
      });
    }

    function LedgerModelTable(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const models = Array.isArray(props.models) ? props.models.slice() : [];
      models.sort((left, right) => numberOrZero(right.totalTokens) - numberOrZero(left.totalTokens));
      const rows = models.slice(0, 8);
      if (!rows.length) return h(EmptyState, { label: t('ledger.empty') });
      return h('div', { className: 'um-table-wrap' },
        h('table', { className: 'um-table um-table-compact' },
          h('thead', null,
            h('tr', null,
              h('th', null, t('ledger.model')),
              h('th', { className: 'um-num' }, t('ledger.requests')),
              h('th', { className: 'um-num' }, t('ledger.tokens')),
              h('th', { className: 'um-num' }, t('ledger.cost')))),
          h('tbody', null, rows.map((model, index) => h('tr', { key: String(index) + '|' + String(model.provider || '') + '|' + String(model.model || '') },
            h('td', null,
              h('div', { className: 'um-session-id', title: model.model || model.provider || DASH }, String(model.model || model.provider || DASH)),
              model.provider && model.provider !== model.model
                ? h('div', { className: 'um-session-path' }, String(model.provider))
                : null),
            h('td', { className: 'um-num' }, formatNumber(numberOrZero(model.requests), locale, 0)),
            h('td', { className: 'um-num' }, formatTokens(numberOrZero(model.totalTokens))),
            h('td', { className: 'um-num' }, formatMoney(numberOrZero(model.cost), currency, locale)))))));
    }

    function LedgerPanel(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const state = props.ledger || {};
      const data = state.data;
      const totals = (data && data.totals) || {};
      const rows = ledgerPurposeRows(data && data.byPurpose);
      const purposeTotal = rows.reduce((sum, row) => sum + row.totalTokens, 0);
      const slices = rows.map((row) => ({ key: row.key, value: row.totalTokens, color: row.color }));
      const legendItems = rows
        .filter((row) => row.totalTokens > 0)
        .map((row) => ({
          key: row.key,
          label: t(row.labelKey),
          color: row.color,
          valueLabel: formatTokens(row.totalTokens),
          percentLabel: formatRatio(purposeTotal > 0 ? row.totalTokens / purposeTotal : 0),
        }));
      const stats = [
        { key: 'requests', label: t('ledger.requests'), value: formatNumber(numberOrZero(totals.requests), locale, 0) },
        { key: 'tokens', label: t('ledger.tokens'), value: formatTokens(numberOrZero(totals.totalTokens)) },
        { key: 'cache', label: t('ledger.cacheHit'), value: formatRatio(totals.cacheHitRate) },
        { key: 'cost', label: t('ledger.cost'), value: formatMoney(numberOrZero(totals.cost), currency, locale) },
      ];
      return h(Card, { title: t('ledger.title'), desc: t('ledger.desc') },
        h('div', { className: 'um-ledger' },
          state.error && !data ? h(ErrorBar, { t: t, error: state.error, onRetry: state.refresh }) : null,
          !data && state.loading ? h(SkeletonBlock, { height: 180 }) : null,
          !data && !state.loading && !state.error ? h(EmptyState, { label: t('common.noData') }) : null,
          data && data.available === false
            ? h(Fragment, null,
              h(EmptyState, { label: t('ledger.unavailable') }),
              data.diag ? h('div', { className: 'um-diag' }, String(data.diag)) : null)
            : null,
          data && data.available !== false
            ? h(Fragment, null,
              h('div', { className: 'um-ledger-stats' }, stats.map((stat) => h('div', { key: stat.key, className: 'um-stat' },
                h('div', { className: 'um-stat-label', title: stat.label }, stat.label),
                h('div', { className: 'um-stat-value', title: stat.value }, stat.value)))),
              h('div', { className: 'um-subcard' },
                h('div', { className: 'um-subcard-title' }, t('ledger.purpose')),
                h('div', { className: 'um-composition' },
                  h(DonutChart, {
                    slices: slices,
                    size: 132,
                    label: t('ledger.purpose'),
                    centerValue: formatTokens(purposeTotal),
                    centerLabel: t('common.tokens'),
                  }),
                  h(Legend, {
                    items: legendItems.length
                      ? legendItems
                      : [{ key: 'empty', label: t('ledger.empty'), color: C.border1, valueLabel: DASH, percentLabel: DASH }],
                  }))),
              h('div', { className: 'um-subcard' },
                h('div', { className: 'um-subcard-title' }, t('ledger.model')),
                h(LedgerModelTable, { t: t, locale: locale, currency: currency, models: data.byModel })),
              h('div', { className: 'um-installed' },
                data.installedAt
                  ? h('span', null, t('ledger.installedAt', { time: formatDateTime(data.installedAt, locale) }))
                  : null,
                h('span', { className: 'um-installed-hint' }, t('ledger.installedHint'))),
              data.diag ? h('div', { className: 'um-diag' }, String(data.diag)) : null)
            : null));
    }

    // ───────────────────────────── v2: platform bill ─────────────────────────────
    function AccountPanel(props) {
      const t = props.t;
      const locale = props.locale;
      const timer = props.timer;
      const probe = props.probe;
      const displayCurrency = props.currency || 'CNY';
      const fxRate = numberOrZero(props.fxRate) || 1;
      const state = props.account || {};
      const data = state.data;
      const error = state.error;
      const refresh = state.refresh;
      const [phase, setPhase] = useState('idle');
      const [detail, setDetail] = useState('');
      const startSignIn = useCallback(() => {
        setPhase('requesting');
        setDetail('');
        const run = async () => {
          try {
            const response = await fetch(API_BASE + '/account/login', { method: 'POST', headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const payload = await response.json();
            const authorizeUrl = safeHttpUrl(payload && payload.authorizeUrl);
            if (!authorizeUrl) throw new Error('missing authorizeUrl');
            try {
              if (typeof window !== 'undefined' && typeof window.open === 'function') {
                window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
              }
            } catch (failure) {
              // Popup blocked — the polling below still picks up the signed-in state.
            }
            setPhase('waiting');
          } catch (failure) {
            setPhase('failed');
            setDetail(String((failure && failure.message) || failure));
          }
        };
        run();
      }, []);
      useEffect(() => {
        if (phase !== 'waiting') return undefined;
        let alive = true;
        const startedAt = Date.now();
        const poll = async () => {
          if (!alive) return;
          if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
            setPhase('timeout');
            return;
          }
          try {
            const response = await fetch(API_BASE + '/account', { cache: 'no-store', headers: { accept: 'application/json' } });
            if (!response.ok) return;
            const payload = await response.json();
            if (alive && payload && payload.signedIn === true) {
              setPhase('idle');
              refresh();
            }
          } catch (failure) {
            // Keep waiting until the deadline.
          }
        };
        const disposers = [];
        if (timer && typeof timer.interval === 'function') {
          disposers.push(timer.interval(() => {
            if (probe()) poll();
          }, LOGIN_POLL_INTERVAL_MS));
        } else if (typeof setInterval === 'function') {
          const handle = setInterval(() => {
            if (probe()) poll();
          }, LOGIN_POLL_INTERVAL_MS);
          disposers.push(() => clearInterval(handle));
        }
        return () => {
          alive = false;
          for (const dispose of disposers) {
            try {
              dispose();
            } catch (failure) {
              // Disposal is best-effort.
            }
          }
        };
      }, [phase, timer, probe, refresh]);
      let content = null;
      if (error && !data) {
        content = h(ErrorBar, { t: t, error: error, onRetry: refresh });
      } else if (!data && state.loading) {
        content = h(SkeletonBlock, { height: 140 });
      } else if (!data && !state.loading) {
        content = h(EmptyState, { label: t('common.noData') });
      } else if (data && data.available === false) {
        content = h(Fragment, null,
          h(EmptyState, { label: t('account.unavailable') }),
          data.diag ? h('div', { className: 'um-diag' }, t('account.diag', { text: String(data.diag) })) : null);
      } else if (data) {
        const platformCurrency = (typeof data.currency === 'string' && data.currency) || 'CNY';
        const balance = data.balance || {};
        const spend = data.spend || {};
        const coverage = (data.spendCoverage && typeof data.spendCoverage === 'object') ? data.spendCoverage : {};
        const completeFlags = (data.spendComplete && typeof data.spendComplete === 'object') ? data.spendComplete : null;
        const spendSource = typeof data.spendSource === 'string' ? data.spendSource : '';
        const spendSourceLabel = ledgerSourceLabel(spendSource, t);
        const coverageToday = coverage.today || null;
        const samplingStart = spendSource === 'balance-sampling' && coverageToday && coverageToday.fromAt
          ? formatRelative(coverageToday.fromAt, locale)
          : '';
        const sourceText = spendSourceLabel
          ? t('billHistory.source', {
            source: samplingStart
              ? spendSourceLabel + ' · ' + t('account.spendSince', { time: samplingStart })
              : spendSourceLabel,
          })
          : null;
        const spendCells = [
          { key: 'today', label: t('account.spendToday'), value: spend.today },
          { key: 'yesterday', label: t('account.spendYesterday'), value: spend.yesterday },
          { key: 'last7d', label: t('account.spend7d'), value: spend.last7d },
          { key: 'last30d', label: t('account.spend30d'), value: spend.last30d },
        ].map((cell) => {
          const windowCoverage = coverage[cell.key];
          const flag = completeFlags && typeof completeFlags[cell.key] === 'boolean' ? completeFlags[cell.key] : null;
          const complete = flag === null ? (!windowCoverage || windowCoverage.complete !== false) : flag;
          const since = !complete && windowCoverage && windowCoverage.fromAt
            ? formatRelative(windowCoverage.fromAt, locale)
            : '';
          const note = complete ? null : (since ? t('account.spendSince', { time: since }) : null);
          const amount = formatMoney(convertMoney(numberOrZero(cell.value), platformCurrency, displayCurrency, fxRate), displayCurrency, locale);
          const valueText = complete ? amount : '≥ ' + amount;
          return h('div', { key: cell.key, className: 'um-spend' },
            h('div', { className: 'um-spend-label', title: cell.label }, cell.label),
            h('div', { className: 'um-spend-value', title: note || valueText }, valueText),
            note ? h('div', { className: 'um-spend-note', title: note }, note) : null);
        });
        if (data.signedIn === true) {
          const links = [
            { key: 'usage', href: safeHttpUrl(data.usageUrl), label: t('account.usageLink') },
            { key: 'topup', href: safeHttpUrl(data.topUpUrl), label: t('account.topUpLink') },
          ].filter((link) => link.href);
          content = h(Fragment, null,
            h('div', { className: 'um-balance' },
              h('div', { className: 'um-balance-label' }, t('account.balance')),
              h('div', { className: 'um-balance-value' }, formatMoney(convertMoney(numberOrZero(balance.total), platformCurrency, displayCurrency, fxRate), displayCurrency, locale)),
              h('div', { className: 'um-balance-sub' }, data.sampledAt
                ? t('account.sampledAt', { time: formatRelative(data.sampledAt, locale) })
                : t('account.noSample'))),
            sourceText ? h('div', { className: 'um-account-source' }, sourceText) : null,
            data.hasTopUp && spendSource !== 'wallet-ledger'
              ? h('div', { className: 'um-note-warn' }, t('account.topUpDetected'))
              : h('div', { className: 'um-spend-grid' }, spendCells),
            data.hasTopUp && spendSource === 'wallet-ledger'
              ? h('div', { className: 'um-note' }, t('account.topUpLedger'))
              : null,
            links.length
              ? h('div', { className: 'um-link-row' }, links.map((link) => h('a', {
                key: link.key,
                className: 'um-btn um-link-btn',
                href: link.href,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, link.label)))
              : null);
        } else {
          content = h('div', { className: 'um-signin' },
            h('div', { className: 'um-signin-title' }, t('account.signedOut')),
            h('div', { className: 'um-signin-hint' }, t('account.signedOutHint')),
            phase === 'waiting' ? h('div', { className: 'um-signin-hint' }, t('account.signingIn')) : null,
            phase === 'timeout' ? h('div', { className: 'um-note-warn' }, t('account.signInTimeout')) : null,
            phase === 'failed'
              ? h('div', { className: 'um-note-warn' }, detail ? t('account.signInFailed') + ' · ' + detail : t('account.signInFailed'))
              : null,
            h('button', {
              type: 'button',
              className: 'um-btn um-btn-primary',
              disabled: phase === 'requesting' || phase === 'waiting',
              onClick: startSignIn,
            }, phase === 'requesting' ? t('status.loading') : phase === 'waiting' ? t('account.signingIn') : t('account.signIn')));
        }
      }
      return h(Card, { title: t('account.title'), desc: t('account.desc') },
        h('div', { className: 'um-account' }, content));
    }

    // ───────────────────────────── v3: platform bill history ─────────────────────────────
    function BillHistoryChart(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const fxRate = numberOrZero(props.fxRate) || 1;
      const sourceCurrency = typeof props.sourceCurrency === 'string' ? props.sourceCurrency : 'CNY';
      const days = Array.isArray(props.days) ? props.days : [];
      if (!days.length) return h(EmptyState, { label: t('billHistory.empty') });
      const values = days.map((day) => convertMoney(numberOrZero(day && day.cost), sourceCurrency, currency, fxRate));
      const maxValue = values.reduce((max, value) => Math.max(max, value), 0) || 1;
      const count = days.length;
      const slot = 100 / count;
      const barWidth = Math.max(1.1, slot * 0.6);
      const axisIndexes = count > 2 ? [0, Math.floor((count - 1) / 2), count - 1] : count === 2 ? [0, 1] : [0];
      return h('div', { className: 'um-bill-chart' },
        h('svg', {
          className: 'um-chart-svg um-bill-svg',
          viewBox: '0 0 100 64',
          preserveAspectRatio: 'none',
          role: 'img',
        },
          h('line', { x1: 0, y1: 63.5, x2: 100, y2: 63.5, stroke: C.border1, strokeWidth: 0.4 }),
          days.map((day, index) => {
            const value = values[index];
            const incomplete = Boolean(day && day.complete === false);
            const barHeight = Math.max((value / maxValue) * 58, 0.4);
            const title = String(day && day.day ? day.day : '') + ' · ' + formatMoney(value, currency, locale)
              + (incomplete ? ' · ' + t('billHistory.incomplete') : '');
            return h('rect', {
              key: String(index) + '|' + String(day && day.day ? day.day : ''),
              x: index * slot + (slot - barWidth) / 2,
              y: 63.5 - barHeight,
              width: barWidth,
              height: barHeight,
              rx: 0.8,
              fill: incomplete ? 'color-mix(in oklab, ' + C.brand + ' 42%, ' + C.bg1 + ')' : C.brand,
              stroke: incomplete ? C.warn : 'none',
              strokeWidth: incomplete ? 0.35 : 0,
              strokeDasharray: incomplete ? '1.1 0.8' : 'none',
            }, h('title', null, title));
          })),
        h('div', { className: 'um-bill-axis' }, axisIndexes.map((index) => h('span', { key: String(index) },
          days[index] && days[index].day ? String(days[index].day).slice(5) : DASH))));
    }

    function BillHistoryPanel(props) {
      const t = props.t;
      const locale = props.locale;
      const currency = props.currency;
      const fxRate = numberOrZero(props.fxRate) || 1;
      const state = props.billHistory || {};
      const data = state.data;
      const sourceCurrency = (data && typeof data.currency === 'string' && data.currency) || 'CNY';
      const days = data && Array.isArray(data.days) ? data.days : [];
      const totals = (data && data.totals) || {};
      const sourceLabel = ledgerSourceLabel(data && data.source, t) || DASH;
      const totalCells = [
        { key: '7d', labelKey: 'billHistory.total7d' },
        { key: '14d', labelKey: 'billHistory.total14d' },
        { key: '30d', labelKey: 'billHistory.total30d' },
        { key: 'all', labelKey: 'billHistory.totalAll' },
      ].map((cell) => {
        const bucket = totals[cell.key] || {};
        const value = convertMoney(numberOrZero(bucket.cost), sourceCurrency, currency, fxRate);
        return { key: cell.key, labelKey: cell.labelKey, label: t(cell.labelKey), value: formatMoney(value, currency, locale) };
      });
      const hasIncomplete = days.some((day) => Boolean(day && day.complete === false));
      const ageMs = data && data.freshness && typeof data.freshness.ageMs === 'number' ? data.freshness.ageMs : null;
      const freshText = ageMs === null ? '' : t('billHistory.fresh', { time: formatRelative(Date.now() - ageMs, locale) });
      return h(Card, { title: t('billHistory.title'), desc: t('billHistory.desc') },
        h('div', { className: 'um-bill' },
          state.error && !data ? h(ErrorBar, { t: t, error: state.error, onRetry: state.refresh }) : null,
          !data && state.loading ? h(SkeletonBlock, { height: 160 }) : null,
          !data && !state.loading && !state.error ? h(EmptyState, { label: t('common.noData') }) : null,
          data && data.available === false
            ? h('div', { className: 'um-bill-unavailable' },
              h('span', { className: 'um-note-warn' }, t('billHistory.unavailable')),
              data.diag ? h('span', { className: 'um-diag' }, String(data.diag)) : null)
            : null,
          data && data.available !== false
            ? h(Fragment, null,
              h('div', { className: 'um-bill-meta' },
                h('span', null, t('billHistory.source', { source: sourceLabel })),
                data.since || data.until
                  ? h('span', null, t('billHistory.range', { since: data.since || DASH, until: data.until || DASH }))
                  : null,
                freshText ? h('span', { className: 'um-bill-fresh' }, freshText) : null),
              h(BillHistoryChart, {
                t: t,
                locale: locale,
                currency: currency,
                fxRate: fxRate,
                sourceCurrency: sourceCurrency,
                days: days,
              }),
              h('div', { className: 'um-bill-totals' }, totalCells.map((cell) => h('div', { key: cell.key, className: 'um-stat' },
                h('div', { className: 'um-stat-label', title: cell.label }, cell.label),
                h('div', { className: 'um-stat-value' }, cell.value)))),
              hasIncomplete ? h('div', { className: 'um-bill-note' }, t('billHistory.incomplete')) : null,
              h('div', { className: 'um-bill-scope' }, t('reconcile.note')))
            : null));
    }

    // ───────────────────────────── fx provenance line ─────────────────────────────
    // A single slim row under the account/bill cards. Rendered only when `/overview`
    // carries an `fx` block; reuses the existing overview poll, never a new request.
    function FxNote(props) {
      const t = props.t;
      const locale = props.locale;
      const info = readFxInfo(props.data);
      if (!info) return null;
      const sourceText = fxSourceText(info, t);
      const dateText = fxDateShort(info.effectiveDate);
      const degradedText = fxDegradedMark(info, t);
      const fetchedText = info.fetchedAt ? formatRelative(info.fetchedAt, locale) : '';
      const items = [];
      if (sourceText) items.push({ key: 'source', text: sourceText, tone: info.source === 'market' ? 'warn' : '' });
      if (dateText) items.push({ key: 'effective', text: t('fx.effective', { date: dateText }), tone: '' });
      if (fetchedText) items.push({ key: 'fetched', text: t('fx.fetched', { time: fetchedText }), tone: '' });
      if (degradedText) items.push({ key: 'degraded', text: degradedText, tone: 'warn' });
      if (!items.length) return null;
      return h('div', { className: 'um-fx' },
        h('span', { className: 'um-fx-title' }, t('fx.title')),
        items.map((item) => h('span', {
          key: item.key,
          className: item.tone === 'warn' ? 'um-fx-item um-fx-warn' : 'um-fx-item',
        }, item.text)));
    }

    /** UTC hour window list → Beijing "HH:MM–HH:MM" list (host sends peakHoursUtc). */
    function beijingHourWindows(ranges) {
      if (!Array.isArray(ranges)) return '';
      const parts = [];
      for (const range of ranges) {
        if (!Array.isArray(range) || range.length < 2) continue;
        const start = ((numberOrZero(range[0]) + 8) % 24 + 24) % 24;
        const end = ((numberOrZero(range[1]) + 8) % 24 + 24) % 24;
        const pad = (hour) => (hour < 10 ? `0${hour}` : String(hour));
        parts.push(`${pad(start)}:00–${pad(end)}:00`);
      }
      return parts.join(' / ');
    }

    function SettingsSection(props) {
      const t = props.t;
      const pricing = props.pricing && typeof props.pricing === 'object' ? props.pricing : null;
      const facts = [];
      if (pricing) {
        facts.push({ key: 'base', label: t('pricing.baseLabel'), value: t('pricing.baseValue') });
        const peakWindow = beijingHourWindows(pricing.peakHoursUtc);
        if (peakWindow) {
          facts.push({ key: 'peak', label: t('pricing.peakLabel'), value: t('pricing.peakValue', { window: peakWindow }) });
        }
        facts.push({ key: 'off', label: t('pricing.offPeakLabel'), value: t('pricing.offPeakValue') });
      }
      const holidayYears = pricing && Array.isArray(pricing.holidayYears) ? pricing.holidayYears.join('/') : '';
      const holidayDays = pricing && typeof pricing.holidayDays === 'number' ? String(pricing.holidayDays) : '';
      const holidayText = pricing && pricing.holidaysIncluded === true && holidayYears && holidayDays
        ? t('pricing.holidayNote', { years: holidayYears, days: holidayDays })
        : t('pricing.holidayNone');
      return h(Card, { title: t('settings.title'), desc: t('settings.desc') },
        facts.length > 0 ? h('div', { className: 'um-live-facts' }, facts.map((fact) =>
          h('div', { key: fact.key, className: 'um-fact' },
            h('div', { className: 'um-fact-label' }, fact.label),
            h('div', { className: 'um-fact-value', title: fact.value }, fact.value)))) : null,
        h('p', { className: 'um-bill-note' }, holidayText),
        h('p', { className: 'um-bill-note' }, t('pricing.boundary')),
        h('p', { className: 'um-bill-note' }, t('pricing.estimated')),
        h('div', { className: 'um-block-head' },
          h('span', { className: 'um-block-title' }, t('settings.blocks')),
          h('button', {
            type: 'button',
            className: 'um-btn um-btn-ghost',
            onClick: props.onResetBlocks,
          }, t('settings.blocksReset'))),
        h('div', { className: 'um-blocks' }, (props.blocks || []).map((block) =>
          h('label', { key: block.id, className: 'um-block-opt', title: block.label },
            h('input', {
              type: 'checkbox',
              checked: block.checked,
              onChange: () => props.onToggleBlock(block.id),
            }),
            h('span', null, block.label)))),
        h('p', { className: 'um-bill-note' }, t('settings.blocksHint')));
    }

    // ───────────────────────────── dashboard composition ─────────────────────────────
    function DashboardBody(props) {
      const t = props.t;
      const data = props.data;
      const currency = props.currency;
      const locale = props.locale;
      const series = data.series || {};
      const hidden = props.hidden || [];
      const isHidden = (id) => hidden.indexOf(id) >= 0;
      const fxRate = numberOrZero(data.kpi && data.kpi.fxRate);
      // A two-column row that collapses to a single full-width card when one side
      // is hidden, so hiding a block never leaves an empty half-row.
      const pair = (first, second) => {
        const items = [first, second].filter(Boolean);
        if (!items.length) return null;
        if (items.length === 1) return items[0];
        return h('div', { className: 'um-grid2' }, items[0], items[1]);
      };
      const blocks = BLOCK_DEFS.map((def) => ({ id: def.id, label: t(def.labelKey), checked: !isHidden(def.id) }));
      return h(Fragment, null,
        isHidden('kpi') ? null : h(KpiRow, { t: t, data: data, locale: locale, currency: currency }),
        isHidden('reconcile') ? null : h(ReconcileBar, {
          t: t,
          locale: locale,
          currency: currency,
          fxRate: fxRate,
          ledger: props.ledger,
          account: props.account,
        }),
        pair(
          isHidden('ledger') ? null : h(LedgerPanel, {
            t: t,
            locale: locale,
            currency: currency,
            ledger: props.ledger,
          }),
          isHidden('account') ? null : h(AccountPanel, {
            t: t,
            locale: locale,
            timer: props.timer,
            probe: props.probe,
            currency: currency,
            fxRate: fxRate,
            account: props.account,
          })),
        isHidden('fx') ? null : h(FxNote, { t: t, locale: locale, data: data }),
        isHidden('billHistory') ? null : h(BillHistoryPanel, {
          t: t,
          locale: locale,
          currency: currency,
          fxRate: fxRate,
          billHistory: props.billHistory,
        }),
        isHidden('charts') ? null : h('div', { className: 'um-grid2' },
          h(Card, { title: t('chart.tokens'), desc: t('chart.tokensDesc') },
            h(StackedBarChart, { t: t, locale: locale, buckets: series.buckets })),
          h(Card, { title: t('chart.composition') },
            h(CompositionChart, { t: t, kpi: data.kpi || {} }))),
        pair(
          isHidden('live') ? null : h(Card, { title: t('chart.live'), desc: t('chart.liveDesc') },
            h(LivePanel, { t: t, timer: props.timer, probe: props.probe, locale: locale })),
          isHidden('models') ? null : h(Card, { title: t('chart.models') },
            h(ModelsPanel, { t: t, models: data.models, currency: currency, locale: locale }))),
        isHidden('sessions') ? null : h(Card, { title: t('sessions.title') },
          h(SessionsTable, { t: t, sessions: data.sessions, currency: currency, locale: locale })),
        isHidden('performance') ? null : h(Card, { title: t('chart.performance') },
          h(PerformancePanel, { t: t, performance: data.performance, locale: locale })),
        h(SettingsSection, {
          t: t,
          pricing: data.pricing,
          blocks: blocks,
          onToggleBlock: props.onToggleBlock,
          onResetBlocks: props.onResetBlocks,
        }));
    }

    function Dashboard(props) {
      const t = props.t;
      const locale = props.locale;
      const localeSnapshot = useLocaleSnapshot(locale);
      const intlLocale = localeToIntl(localeSnapshot && localeSnapshot.active);
      const probe = useMemo(() => makeActivityProbe(props.layout), [props.layout]);
      const [range, setRange] = useState('today');
      const [currency, setCurrency] = useState('CNY');
      const [hiddenBlocks, setHiddenBlocks] = useState(() => readHiddenBlocks());
      const toggleBlock = useCallback((id) => {
        setHiddenBlocks((previous) => {
          const next = previous.indexOf(id) >= 0
            ? previous.filter((item) => item !== id)
            : previous.concat([id]);
          writeHiddenBlocks(next);
          return next;
        });
      }, []);
      const resetBlocks = useCallback(() => {
        writeHiddenBlocks([]);
        setHiddenBlocks([]);
      }, []);
      const overviewUrl = API_BASE + '/overview?range=' + encodeURIComponent(range) + '&currency=' + encodeURIComponent(currency);
      const overview = usePolledJson({
        url: overviewUrl,
        intervalMs: OVERVIEW_INTERVAL_MS,
        timer: props.timer,
        probe: probe,
      });
      const ledgerUrl = API_BASE + '/ledger?range=' + encodeURIComponent(range) + '&currency=' + encodeURIComponent(currency);
      const ledger = usePolledJson({
        url: ledgerUrl,
        intervalMs: LEDGER_INTERVAL_MS,
        timer: props.timer,
        probe: probe,
      });
      const account = usePolledJson({
        url: API_BASE + '/account',
        intervalMs: ACCOUNT_INTERVAL_MS,
        timer: props.timer,
        probe: probe,
      });
      const billRange = range === '7d' || range === '14d' || range === '30d' ? range : 'all';
      const billHistoryUrl = API_BASE + '/bill-history?range=' + encodeURIComponent(billRange);
      const billHistory = usePolledJson({
        url: billHistoryUrl,
        intervalMs: BILL_HISTORY_INTERVAL_MS,
        timer: props.timer,
        probe: probe,
      });
      const refreshAll = useCallback(() => {
        overview.refresh();
        ledger.refresh();
        account.refresh();
        billHistory.refresh();
      }, [overview.refresh, ledger.refresh, account.refresh, billHistory.refresh]);
      const data = overview.data;
      const effectiveCurrency = (data && data.kpi && data.kpi.currency) || currency;
      const hasData = Boolean(data);
      return h('div', { className: 'um-root' },
        h(StyleTag),
        h(Toolbar, {
          t: t,
          locale: intlLocale,
          range: range,
          currency: currency,
          loading: overview.loading,
          updatedAt: overview.fetchedAt || (data && data.generatedAt),
          onRange: setRange,
          onCurrency: setCurrency,
          onRefresh: refreshAll,
        }),
        h('div', { className: 'um-content' },
          data ? h(ScanBar, { t: t, scan: data.scan }) : null,
          overview.error ? h(ErrorBar, { t: t, error: overview.error, onRetry: overview.refresh }) : null,
          !hasData && overview.loading ? h(SkeletonPage, { t: t }) : null,
          !hasData && !overview.loading && !overview.error ? h(Card, null, h(EmptyState, { label: t('common.noData') })) : null,
          hasData
            ? h(DashboardBody, {
              t: t,
              data: data,
              currency: effectiveCurrency,
              locale: intlLocale,
              timer: props.timer,
              probe: probe,
              ledger: ledger,
              account: account,
              billHistory: billHistory,
              hidden: hiddenBlocks,
              onToggleBlock: toggleBlock,
              onResetBlocks: resetBlocks,
            })
            : null));
    }

    // ───────────────────────────── styles ─────────────────────────────
    const CSS = [
      '.um-root{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.um-root *,.um-root *::before,.um-root *::after{box-sizing:border-box}',
      '.um-content{display:flex;flex-direction:column;gap:12px;padding:0 20px 36px}',
      '.um-toolbar{position:sticky;top:0;z-index:6;display:flex;flex-direction:column;gap:8px;padding:14px 20px 10px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.um-toolbar-main{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 16px}',
      '.um-toolbar-titles{min-width:180px}',
      '.um-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}',
      '.um-subtitle{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.um-toolbar-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.um-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.um-seg-btn{appearance:none;border:0;border-radius:6px;padding:4px 9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.um-seg-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.um-seg-btn[data-active="true"]{background:color-mix(in oklab,var(--dsw-alias-brand-primary) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.um-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.um-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.um-btn:disabled{opacity:.55;cursor:default}',
      '.um-btn-primary{border-color:color-mix(in oklab,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}',
      '.um-btn:focus-visible,.um-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.um-updated{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.um-scan{display:flex;flex-direction:column;gap:5px;padding:8px 0 0;font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.um-progress{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.um-progress>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .4s ease}',
      '.um-error{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1));font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.um-kpi-row{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}',
      '.um-kpi{display:flex;flex-direction:column;gap:4px;padding:12px 14px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.um-kpi-title{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.um-kpi-value{margin-top:2px;font-size:22px;font-weight:600;line-height:1.2;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-kpi-hint{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um-kpi-foot{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um-kpi-trend{margin-top:auto;padding-top:6px}',
      '.um-sparkline{display:block;width:100%;overflow:visible}',
      '.um-sparkline-empty{width:100%;border-bottom:1px dashed var(--dsw-alias-border-l1)}',
      '.um-grid2{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:12px;align-items:start}',
      '.um-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.um-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:11px 14px 0}',
      '.um-card-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.um-card-desc{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.um-card-body{padding:10px 14px 14px;min-width:0}',
      '.um-chart{position:relative}',
      '.um-chart-svg{display:block;width:100%;height:auto;overflow:visible}',
      '.um-tooltip{position:absolute;top:0;transform:translateX(-50%);display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:11px;white-space:nowrap;pointer-events:none;z-index:4;box-shadow:0 6px 18px color-mix(in oklab,var(--dsw-alias-label-primary) 16%,transparent)}',
      '.um-tooltip-title{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.um-tooltip-row{display:flex;align-items:center;gap:6px}',
      '.um-tooltip-chip{width:8px;height:8px;border-radius:2px;flex:0 0 auto}',
      '.um-tooltip-label{color:var(--dsw-alias-label-caption)}',
      '.um-tooltip-value{margin-left:auto;padding-left:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.um-tooltip-total{border-top:1px solid var(--dsw-alias-border-l1);margin-top:2px;padding-top:3px;color:var(--dsw-alias-label-secondary)}',
      '.um-composition{display:flex;align-items:center;gap:16px;flex-wrap:wrap}',
      '.um-donut{flex:0 0 auto;max-width:100%}',
      '.um-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;min-width:0;flex:1 1 150px}',
      '.um-legend-item{display:flex;align-items:center;gap:6px;font-size:11px;min-width:0}',
      '.um-legend-chip{width:9px;height:9px;border-radius:2px;flex:0 0 auto}',
      '.um-legend-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um-legend-value{margin-left:auto;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-legend-percent{width:46px;text-align:right;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.um-models{display:flex;flex-direction:column;gap:12px}',
      '.um-live{display:flex;flex-direction:column;gap:12px}',
      '.um-live-gauges{display:flex;justify-content:space-around;gap:8px;flex-wrap:wrap}',
      '.um-gauge{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:88px}',
      '.um-gauge-ring{position:relative;width:84px;height:84px}',
      '.um-gauge-ring svg{display:block}',
      '.um-gauge-value{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.um-gauge-arc{transition:stroke-dasharray .45s ease}',
      '.um-gauge-label{font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.um-gauge-detail{font-size:10px;color:var(--dsw-alias-label-tertiary);text-align:center;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um-live-spark{display:flex;flex-direction:column;gap:3px}',
      '.um-live-spark-head{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.um-live-spark-head b{font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.um-live-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
      '.um-fact{padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.um-fact-label{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.um-fact-value{font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.um-table-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
      '.um-search-input{appearance:none;min-width:200px;flex:1 1 220px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.um-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.um-search-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.um-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.um-table-wrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.um-table{width:100%;border-collapse:collapse;font-size:11.5px;min-width:720px}',
      '.um-table th,.um-table td{padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;white-space:nowrap}',
      '.um-table tbody tr:last-child td{border-bottom:0}',
      '.um-table th{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-caption);font-weight:500}',
      '.um-table tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}',
      '.um-sort{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:3px}',
      '.um-sort[data-active="true"]{color:var(--dsw-alias-label-primary)}',
      '.um-sort:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:3px}',
      '.um-num{text-align:right;font-variant-numeric:tabular-nums}',
      '.um-session{display:flex;flex-direction:column;gap:1px;min-width:0;max-width:280px}',
      '.um-session-id{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-primary)}',
      '.um-session-path{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.um-badge{display:inline-flex;align-items:center;gap:4px;padding:0 5px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-success-primary);font-size:9.5px;line-height:15px}',
      '.um-live-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);animation:um-dot 1.6s ease-in-out infinite}',
      '.um-showmore{display:flex;justify-content:center;margin-top:10px}',
      '.um-empty{display:flex;align-items:center;justify-content:center;min-height:88px;padding:16px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.um-placeholder{display:flex;align-items:center;gap:8px;min-height:60px;padding:12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.um-skeleton-page{display:flex;flex-direction:column;gap:12px}',
      '.um-skeleton{background:linear-gradient(100deg,var(--dsw-alias-bg-layer-2) 20%,color-mix(in oklab,var(--dsw-alias-bg-layer-2) 55%,var(--dsw-alias-bg-layer-1)) 40%,var(--dsw-alias-bg-layer-2) 60%);background-size:220% 100%;animation:um-shimmer 1.5s linear infinite}',
      '.um-perf{display:flex;flex-direction:column;gap:12px}',
      '.um-perf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.um-subcard{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0;display:flex;flex-direction:column;gap:8px}',
      '.um-subcard-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.um-subcard-note{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.um-metric-bars{display:flex;flex-direction:column;gap:6px}',
      '.um-metric-row{display:flex;align-items:center;gap:8px;font-size:11px}',
      '.um-metric-label{width:58px;flex:0 0 auto;color:var(--dsw-alias-label-caption)}',
      '.um-metric-track{position:relative;flex:1 1 auto;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.um-metric-fill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary)}',
      '.um-metric-value{width:76px;flex:0 0 auto;text-align:right;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-share-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.um-share-seg{display:block;height:100%}',
      '.um-share-legend{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.um-share-legend>span{display:flex;align-items:center;gap:6px}',
      '.um-chip{width:8px;height:8px;border-radius:2px;flex:0 0 auto}',
      '.um-stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
      '.um-stat{min-width:0}',
      '.um-stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.um-stat-value{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-ledger{display:flex;flex-direction:column;gap:10px}',
      '.um-ledger-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
      '.um-installed{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.um-installed-hint{color:var(--dsw-alias-state-warn-primary)}',
      '.um-diag{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.um-table-compact{min-width:420px}',
      '.um-account{display:flex;flex-direction:column;gap:10px}',
      '.um-balance{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.um-balance-label{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.um-balance-value{font-size:24px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-balance-sub{font-size:10px;color:var(--dsw-alias-label-caption)}',
      '.um-spend-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.um-spend{min-width:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.um-spend-label{font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.um-spend-value{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-spend-note{margin-top:2px;font-size:10px;line-height:1.3;color:var(--dsw-alias-label-caption)}',
      '.um-note-warn{font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.um-link-row{display:flex;flex-wrap:wrap;gap:8px}',
      '.um-link-btn{display:inline-flex;align-items:center;text-decoration:none}',
      '.um-signin{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px}',
      '.um-signin-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.um-signin-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.um-account-source{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.um-note{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:6px}',
      '.um-bill{display:flex;flex-direction:column;gap:10px}',
      '.um-bill-meta{display:flex;flex-wrap:wrap;gap:3px 14px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.um-bill-fresh{margin-left:auto;color:var(--dsw-alias-label-caption)}',
      '.um-bill-chart{display:flex;flex-direction:column;gap:3px}',
      '.um-bill-svg{display:block;width:100%;height:84px}',
      '.um-bill-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.um-bill-totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
      '.um-bill-note{font-size:10.5px;color:var(--dsw-alias-state-warn-primary)}',
      '.um-block-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.um-block-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.um-blocks{display:flex;flex-wrap:wrap;gap:6px 16px}',
      '.um-block-opt{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.um-block-opt:hover{color:var(--dsw-alias-label-primary)}',
      '.um-block-opt input{accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer}',
      '.um-btn-ghost{padding:2px 8px;font-size:11px;background:transparent}',
      '.um-bill-scope{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.um-bill-unavailable{display:flex;flex-direction:column;gap:2px;font-size:11px}',
      '.um-fx{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.um-fx-title{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.um-fx-item{font-variant-numeric:tabular-nums}',
      '.um-fx-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.um-reconcile{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:11px}',
      '.um-reconcile-title{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.um-reconcile-item{display:inline-flex;align-items:baseline;gap:6px}',
      '.um-reconcile-label{color:var(--dsw-alias-label-caption)}',
      '.um-reconcile-value{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.um-reconcile-note{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
      '.um-deviation{padding:1px 7px;border-radius:999px;font-weight:600;font-variant-numeric:tabular-nums}',
      '@media (max-width:1100px){.um-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}.um-ledger-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:980px){.um-grid2{grid-template-columns:minmax(0,1fr)}.um-perf-grid{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width:640px){.um-kpi-row{grid-template-columns:minmax(0,1fr)}.um-live-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.um-bill-totals{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@keyframes um-shimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}',
      '@keyframes um-dot{0%,100%{opacity:.35}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.um-skeleton{animation:none}.um-live-dot{animation:none}.um-gauge-arc{transition:none}}',
    ].join('\n');

    function StyleTag() {
      return h('style', { 'data-usage-monitor-style': '1' }, CSS);
    }

    // ───────────────────────────── sidebar entry icon ─────────────────────────────
    function PanelIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { x: 2.5, y: 9, width: 2, height: 5, rx: 0.6, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 6, y: 6, width: 2, height: 8, rx: 0.6, fill: 'currentColor', opacity: 0.8 }),
        h('rect', { x: 9.5, y: 3, width: 2, height: 11, rx: 0.6, fill: 'currentColor' }),
        h('circle', { cx: 13.4, cy: 5.4, r: 1.1, fill: 'currentColor', opacity: 0.55 }));
    }

    // ───────────────────────────── plugin entry ─────────────────────────────
    function apply(ctx) {
      const slots = ctx.slots;
      const locale = ctx.locale;
      const layout = ctx.layout;
      const timer = ctx.timer;

      ctx.effect(() => {
        try {
          return locale.register(NS, { zh: ZH_DICT, en: EN_DICT });
        } catch (failure) {
          // A reload can find the dictionaries already registered; keep them.
          return () => {};
        }
      }, 'dsh-usage-monitor: locale dictionaries');

      const t = locale.bind(NS);

      // Releasing the panel keeps the shell on the conversation view when the
      // plugin unloads while its panel is the active main entry.
      ctx.effect(() => () => {
        try {
          const info = layout && layout.panelInfo && typeof layout.panelInfo.getSnapshot === 'function'
            ? layout.panelInfo.getSnapshot()
            : null;
          if (info && info.activePanelId === PANEL_ID && typeof layout.selectPanel === 'function') {
            layout.selectPanel(null);
          }
        } catch (failure) {
          // Disposal is best effort.
        }
      }, 'dsh-usage-monitor: release active panel');

      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 60,
        label: () => t('panel.title'),
        locale: NS,
      }, PanelIcon));

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, () => h(Dashboard, { t: t, locale: locale, layout: layout, timer: timer })));
    }

    const inject = ['slots', 'locale', 'layout', 'timer'];
    const name = 'usage-monitor';

    return { name: name, inject: inject, apply: apply };
  },
});
