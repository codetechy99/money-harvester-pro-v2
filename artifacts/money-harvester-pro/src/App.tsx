import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Crosshair,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LineChart,
  Loader2,
  Menu,
  Play,
  Power,
  RefreshCw,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  getGetBrokerBalanceQueryKey,
  getGetBrokerMarketDataQueryKey,
  getGetDashboardQueryKey,
  getGetEngineStatesQueryKey,
  getGetEquityHistoryQueryKey,
  getGetJournalQueryKey,
  getGetRiskSettingsQueryKey,
  getHealthCheckQueryKey,
  useCloseAllPositions,
  useConnectBroker,
  useDisconnectBroker,
  useExecuteTrade,
  useGetBrokerBalance,
  useGetBrokerMarketData,
  useGetDashboard,
  useGetEngineStates,
  useGetEquityHistory,
  useGetJournal,
  useGetRiskSettings,
  useHealthCheck,
  useRunEngine,
  useUpdateRiskSettings,
  type BrokerAccount,
  type EngineState,
  type EquityPoint,
  type JournalEntry,
  type MarketDataHealth,
  type RiskSettingsInput,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const ACCOUNT_KEY = 'money-harvester-account-id';

function accountIdFromStorage() {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(ACCOUNT_KEY) ?? '';
}

function formatMoney(value: number | null | undefined, currency?: string | null) {
  if (value === null || value === undefined || Number.isNaN(value) || !currency) return '— unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatDate(value: string | null | undefined, includeTime = true) {
  if (!value) return '— unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', includeTime ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { month: 'short', day: '2-digit', year: 'numeric' }).format(date);
}

function getErrorMessage(error: unknown) {
  if (!error) return 'The request could not be completed.';
  const candidate = error as { message?: string; response?: { data?: { error?: string } } };
  return candidate.response?.data?.error ?? candidate.message ?? 'The request could not be completed.';
}

function StatusDot({ tone = 'green' }: { tone?: 'green' | 'amber' | 'red' | 'slate' }) {
  return <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />;
}

function Unavailable({ label = 'Unavailable' }: { label?: string }) {
  return <span className="unavailable" title="This value was not returned by the connected broker">{label}</span>;
}

function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3" data-testid="loading-skeleton">
      {Array.from({ length: count }).map((_, index) => <div className="skeleton-row" key={index} />)}
    </div>
  );
}

function EmptyState({ icon: Icon, title, copy, action }: { icon: typeof Activity; title: string; copy: string; action?: ReactNode }) {
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-icon"><Icon size={20} /></div>
      <h3>{title}</h3>
      <p>{copy}</p>
      {action}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" data-testid="error-state">
      <TriangleAlert size={18} />
      <div><strong>Data request failed</strong><span>{message}</span></div>
      {onRetry && <button className="button button-quiet" onClick={onRetry} data-testid="button-retry"><RefreshCw size={14} /> Retry</button>}
    </div>
  );
}

function Metric({ label, value, detail, tone = 'neutral', icon: Icon }: { label: string; value: ReactNode; detail?: ReactNode; tone?: 'neutral' | 'positive' | 'negative' | 'amber'; icon: typeof Activity }) {
  return (
    <div className="metric-card" data-testid={`metric-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="metric-top"><span>{label}</span><Icon size={16} /></div>
      <strong className={`metric-value metric-${tone}`}>{value}</strong>
      {detail && <span className="metric-detail">{detail}</span>}
    </div>
  );
}

function SectionHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="section-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{action}</div>;
}

function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } });
  const accountId = accountIdFromStorage();
  const healthTone = health.isError ? 'red' : health.isLoading ? 'amber' : 'green';

  const nav = [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/journal', label: 'Trade journal', icon: BookOpen },
    { href: '/settings', label: 'Control settings', icon: SlidersHorizontal },
  ];

  return (
    <div className="app-frame">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <img className="brand-mark-brandmark" src="/favicon.jpg" alt="Money Harvester Pro logo" />
          <div><strong>Money Harvester</strong><span>PRO / CONTROL ROOM</span></div>
          <button className="mobile-close" onClick={() => setMobileOpen(false)} data-testid="button-close-menu"><X size={17} /></button>
        </div>
        <div className="connection-rail">
          <span className="eyebrow">Broker link</span>
          <div className="connection-row"><StatusDot tone={accountId ? 'green' : 'slate'} /><span>{accountId ? 'Account selected' : 'No account'}</span><Wifi size={13} /></div>
          <code>{accountId || 'Connect MetaApi to begin'}</code>
        </div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <span className="eyebrow nav-label">Workspace</span>
          {nav.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`nav-link ${location === href ? 'nav-link-active' : ''}`} onClick={() => setMobileOpen(false)} data-testid={`link-${label.toLowerCase().replace(/\s+/g, '-')}`}>
              <Icon size={17} /><span>{label}</span>{location === href && <ChevronRight size={14} className="nav-caret" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="health-line"><StatusDot tone={healthTone} /><span>API {health.isError ? 'unreachable' : health.isLoading ? 'checking' : 'operational'}</span></div>
          <span className="mono muted-text">v1.0.0 / live mode</span>
          <span className="mono muted-text brand-credit">Built by Toxic Tech · Advanced by VYLUX TECH</span>
        </div>
      </aside>
      {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-dismiss-menu" />}
      <main className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)} data-testid="button-open-menu"><Menu size={19} /></button>
          <div className="topbar-context"><span className="topbar-kicker">Live brokerage workspace</span><span className="topbar-separator">/</span><span>{location === '/' ? 'Overview' : location === '/journal' ? 'Trade journal' : 'Control settings'}</span></div>
          <div className="topbar-actions"><span className={`live-indicator ${accountId ? '' : 'live-indicator-muted'}`}><StatusDot tone={accountId ? 'green' : 'slate'} /> {accountId ? 'Live data' : 'No broker link'}</span><span className="topbar-time mono">{new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}</span></div>
        </header>
        {children}
      </main>
    </div>
  );
}

function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="page-header"><div><span className="eyebrow">MONEY HARVESTER PRO</span><h1>{title}</h1><p>{description}</p></div><div className="page-header-actions">{children}</div></div>;
}

function AccountMissing({ destination = '/settings' }: { destination?: string }) {
  return (
    <div className="account-missing" data-testid="empty-missing-account">
      <div className="missing-orbit"><Crosshair size={27} /></div>
      <div><span className="eyebrow">No live account selected</span><h2>Connect a MetaApi account before trading</h2><p>Money Harvester never estimates account values. Once credentials are accepted by the server, broker data will appear here.</p></div>
      <Link href={destination} className="button button-primary" data-testid="link-connect-account"><KeyRound size={15} /> Open broker setup</Link>
    </div>
  );
}

function LiveToolbar({ accountId, onRefresh, onEmergency, busy, feedback }: { accountId: string; onRefresh: () => void; onEmergency: () => void; busy: boolean; feedback?: { type: 'success' | 'error'; text: string } }) {
  return (
    <div className="live-toolbar">
      <div className="toolbar-account"><StatusDot tone={accountId ? 'green' : 'slate'} /><span>{accountId ? 'Broker stream armed' : 'Waiting for broker link'}</span>{accountId && <code>{accountId}</code>}</div>
      <div className="toolbar-actions">
        {feedback && <span className={`feedback feedback-${feedback.type}`} data-testid="status-action-feedback">{feedback.type === 'success' ? <Check size={14} /> : <TriangleAlert size={14} />}{feedback.text}</span>}
        <button className="button button-quiet" onClick={onRefresh} disabled={busy} data-testid="button-refresh-dashboard"><RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Refreshing' : 'Refresh'}</button>
        <button className="button button-danger" onClick={onEmergency} disabled={busy || !accountId} data-testid="button-emergency-stop"><Power size={14} /> Emergency stop</button>
      </div>
    </div>
  );
}

function EquityChart({ points, compact = false, currency }: { points: EquityPoint[]; compact?: boolean; currency?: string | null }) {
  if (!points?.length) return <div className="chart-empty"><LineChart size={18} /><span>Equity history unavailable</span></div>;
  const width = 720;
  const height = compact ? 150 : 260;
  const values = points.flatMap((point) => [point.balance, point.equity]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (index: number) => (index / Math.max(points.length - 1, 1)) * width;
  const y = (value: number) => height - ((value - min) / range) * (height - 20) - 10;
  const path = (key: 'balance' | 'equity') => points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point[key]).toFixed(1)}`).join(' ');
  return (
    <div className={`equity-chart ${compact ? 'equity-chart-compact' : ''}`} data-testid="chart-equity">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Equity and balance history">
        <line className="chart-grid" x1="0" x2={width} y1={height * .25} y2={height * .25} />
        <line className="chart-grid" x1="0" x2={width} y1={height * .5} y2={height * .5} />
        <line className="chart-grid" x1="0" x2={width} y1={height * .75} y2={height * .75} />
        <path className="chart-line chart-line-balance" d={path('balance')} />
        <path className="chart-line chart-line-equity" d={path('equity')} />
      </svg>
      {!compact && <div className="chart-legend"><span><i className="legend-line legend-equity" /> Equity</span><span><i className="legend-line legend-balance" /> Balance</span><span className="mono chart-range">{formatMoney(min, currency)} — {formatMoney(max, currency)}</span></div>}
    </div>
  );
}

function PositionRow({ position, currency }: { position: BrokerAccount['positions'][number]; currency?: string | null }) {
  const profit = position.profit;
  return (
    <div className="position-row" data-testid={`row-position-${position.id ?? position.symbol}`}>
      <div className="symbol-cell"><span className={`direction-chip ${position.type?.toLowerCase().includes('sell') ? 'direction-sell' : 'direction-buy'}`}>{position.type || '—'}</span><strong>{position.symbol}</strong></div>
      <span className="mono">{formatNumber(position.volume, 2)}</span>
      <span className="mono">{formatNumber(position.openPrice, 5)}</span>
      <span className="mono">{position.currentPrice == null ? <Unavailable /> : formatNumber(position.currentPrice, 5)}</span>
      <span className="mono">{position.stopLoss == null ? <Unavailable /> : formatNumber(position.stopLoss, 5)}</span>
      <span className={`mono pnl ${profit != null && profit >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{profit == null ? <Unavailable /> : formatMoney(profit, currency)}</span>
    </div>
  );
}

function StateCard({ state, onRun }: { state: EngineState; onRun?: () => void }) {
  const stateTone = state.currentState?.toLowerCase().includes('trade') || state.currentState?.toLowerCase().includes('ready') ? 'positive' : state.currentState?.toLowerCase().includes('block') ? 'negative' : 'neutral';
  return (
    <div className="state-card" data-testid={`card-state-${state.symbol}`}>
      <div className="state-card-head"><div><strong>{state.symbol}</strong><span className="mono state-updated">{formatDate(state.lastUpdated)}</span></div><span className={`state-badge state-${stateTone}`}>{state.currentState || 'Unavailable'}</span></div>
      <div className="state-grid"><div><span>HTF bias</span><strong>{state.htfBias || <Unavailable />}</strong></div><div><span>Trend</span><strong>{state.trend || <Unavailable />}</strong></div><div><span>POI</span><strong>{state.poiType || <Unavailable />}</strong></div><div><span>Conflict</span><strong className={state.htfConflict ? 'text-amber' : 'text-green'}>{state.htfConflict ? 'Yes' : 'No'}</strong></div></div>
      {state.diagnostics?.length > 0 && <div className="state-diagnostics"><AlertTriangle size={13} />{state.diagnostics[0]}</div>}
      {onRun && <button className="state-run" onClick={onRun} data-testid={`button-run-engine-${state.symbol}`}><Play size={12} /> Analyze now</button>}
    </div>
  );
}

function MarketDataCard({ accountId, symbol }: { accountId: string; symbol: string }) {
  const query = useGetBrokerMarketData(
    { accountId, symbol },
    {
      query: {
        queryKey: getGetBrokerMarketDataQueryKey({ accountId, symbol }),
        refetchInterval: 10000,
      },
    },
  );
  const data = query.data as MarketDataHealth | undefined;
  const tone = data?.status === 'LIVE' ? 'live' : data?.status === 'STALE' ? 'stale' : 'error';
  return (
    <div className={`market-health-card market-health-${tone}`} data-testid={`card-market-health-${symbol}`}>
      <div className="market-health-head"><strong>{symbol}</strong><span><StatusDot tone={data?.status === 'LIVE' ? 'green' : data?.status === 'STALE' ? 'amber' : 'red'} />{data?.status ?? (query.isLoading ? 'CHECKING' : 'ERROR')}</span></div>
      {query.isError ? <p>{getErrorMessage(query.error)}</p> : <><div className="market-health-symbol"><span>{data?.realSymbol ?? <Unavailable />}</span><em>{data?.dataSource ?? 'No source'}</em></div><div className="market-health-values"><div><span>Bid / Ask</span><strong>{data?.bid == null || data?.ask == null ? <Unavailable /> : `${formatNumber(data.bid, 5)} / ${formatNumber(data.ask, 5)}`}</strong></div><div><span>Spread</span><strong>{data?.spreadPoints == null ? <Unavailable /> : `${formatNumber(data.spreadPoints, 1)} pts`}</strong></div><div><span>Last tick</span><strong>{data?.lastTick ? formatDate(data.lastTick) : <Unavailable />}</strong></div><div><span>Age</span><strong>{data?.dataAgeSeconds == null ? <Unavailable /> : `${formatNumber(data.dataAgeSeconds, 0)}s`}</strong></div></div></>}
    </div>
  );
}

function OverviewPage() {
  const queryClient = useQueryClient();
  const accountId = accountIdFromStorage();
  const params = { accountId: accountId || 'unconfigured' };
  const dashboard = useGetDashboard(params, { query: { enabled: Boolean(accountId), queryKey: getGetDashboardQueryKey(params), refetchInterval: 20000 } });
  const directBalance = useGetBrokerBalance(params, { query: { enabled: Boolean(accountId), queryKey: getGetBrokerBalanceQueryKey(params), refetchInterval: 20000 } });
  const directStates = useGetEngineStates(params, { query: { enabled: Boolean(accountId), queryKey: getGetEngineStatesQueryKey(params), refetchInterval: 30000 } });
  const closeAll = useCloseAllPositions();
  const runEngine = useRunEngine();
  const executeTrade = useExecuteTrade();
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string }>();
  const [tradeOpen, setTradeOpen] = useState(false);
  const [tradeForm, setTradeForm] = useState({ symbol: '', realSymbol: '', direction: 'BUY' as 'BUY' | 'SELL', lot: '', sl: '', tp: '' });
  const snapshot = dashboard.data;
  const account = directBalance.data ?? snapshot?.account ?? undefined;
  const states = directStates.data ?? snapshot?.states ?? [];
  const currency = account?.currency;
  const refresh = (clearFeedback = true) => {
    if (clearFeedback) setFeedback(undefined);
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey(params) });
    queryClient.invalidateQueries({ queryKey: getGetBrokerBalanceQueryKey(params) });
    queryClient.invalidateQueries({ queryKey: getGetEngineStatesQueryKey(params) });
  };
  const emergency = () => {
    if (!accountId) return;
    setFeedback(undefined);
    closeAll.mutate({ data: { accountId } }, {
      onSuccess: (result) => { setFeedback({ type: 'success', text: result.message || `${result.count} position(s) closed` }); refresh(false); },
      onError: (error) => setFeedback({ type: 'error', text: getErrorMessage(error) }),
    });
  };
  const run = (symbols = states.map((state) => state.symbol).filter(Boolean)) => {
    if (!accountId || !symbols.length) return;
    runEngine.mutate({ data: { accountId, symbols } }, {
      onSuccess: () => { setFeedback({ type: 'success', text: 'Engine analysis completed' }); queryClient.invalidateQueries({ queryKey: getGetEngineStatesQueryKey(params) }); },
      onError: (error) => setFeedback({ type: 'error', text: getErrorMessage(error) }),
    });
  };
  const submitTrade = (event: FormEvent) => {
    event.preventDefault();
    if (!accountId) return;
    executeTrade.mutate({ data: { accountId, symbol: tradeForm.symbol, realSymbol: tradeForm.realSymbol || tradeForm.symbol, direction: tradeForm.direction, lot: Number(tradeForm.lot), sl: Number(tradeForm.sl), tp: Number(tradeForm.tp) } }, {
      onSuccess: (result) => { setFeedback({ type: 'success', text: `Order ${result.orderId || 'accepted'} · ${result.status}` }); setTradeOpen(false); refresh(); },
      onError: (error) => setFeedback({ type: 'error', text: getErrorMessage(error) }),
    });
  };
  const positions = account?.positions ?? [];
  const isLoading = Boolean(accountId) && dashboard.isLoading;
  useEffect(() => { document.title = 'Overview · Money Harvester Pro'; }, []);

  return (
    <div className="page-wrap">
      <PageHeader title="Trading overview" description="A broker-sourced read on account health, exposure, and market structure.">
        <button className="button button-primary" onClick={() => setTradeOpen(true)} disabled={!accountId} data-testid="button-open-trade-ticket"><Zap size={15} /> New protected order</button>
      </PageHeader>
      <LiveToolbar accountId={accountId} onRefresh={refresh} onEmergency={emergency} busy={dashboard.isFetching || closeAll.isPending} feedback={feedback} />
      {dashboard.isError && <ErrorState message={getErrorMessage(dashboard.error)} onRetry={refresh} />}
      {!accountId ? <AccountMissing /> : isLoading ? <div className="panel"><SkeletonRows count={5} /></div> : !snapshot?.account && !account ? <AccountMissing /> : (
        <>
          <div className="metrics-grid">
            <Metric label="Equity" value={formatMoney(account?.equity, currency)} detail={account?.connected ? 'Live broker value' : 'Connection not confirmed'} tone="positive" icon={TrendingUp} />
            <Metric label="Balance" value={formatMoney(account?.balance, currency)} detail={account?.currency || <Unavailable label="Currency unavailable" />} icon={BarChart3} />
            <Metric label="Session P&L" value={formatMoney(snapshot?.dailyPnl, currency)} detail={snapshot?.dailyPnlPercent == null ? <Unavailable label="Percent unavailable" /> : `${snapshot.dailyPnlPercent >= 0 ? '+' : ''}${formatNumber(snapshot.dailyPnlPercent)}% today`} tone={snapshot?.dailyPnl != null && snapshot.dailyPnl >= 0 ? 'positive' : 'negative'} icon={snapshot?.dailyPnl != null && snapshot.dailyPnl >= 0 ? ArrowUpRight : ArrowDownRight} />
            <Metric label="Margin level" value={account?.marginLevel == null ? <Unavailable /> : `${formatNumber(account.marginLevel)}%`} detail={account?.margin == null ? <Unavailable label="Margin unavailable" /> : `${formatMoney(account.margin, currency)} used`} tone={account?.marginLevel != null && account.marginLevel < 150 ? 'amber' : 'neutral'} icon={Gauge} />
            <Metric label="Win rate" value={snapshot?.winRate == null ? <Unavailable /> : `${formatNumber(snapshot.winRate)}%`} detail="Closed journal sample" icon={Target} />
            <Metric label="Profit factor" value={snapshot?.profitFactor == null ? <Unavailable /> : formatNumber(snapshot.profitFactor)} detail="Journal-derived" icon={Activity} />
          </div>
          <section className="panel market-health-panel"><SectionHeader eyebrow="Live feed integrity" title="Broker market data" action={<span className="muted-text">10s refresh · stale data blocks trading</span>} /><div className="market-health-grid">{['EURUSD', 'GBPUSD', 'XAUUSD', 'NAS100', 'US30'].map((symbol) => <MarketDataCard key={symbol} accountId={accountId} symbol={symbol} />)}</div></section>
          <div className="dashboard-grid">
            <section className="panel panel-wide"><SectionHeader eyebrow="Account monitor" title="Open positions" action={<span className="count-pill">{positions.length} open</span>} />{positions.length ? <div className="position-table"><div className="position-heading"><span>Instrument</span><span>Lots</span><span>Open</span><span>Mark</span><span>Stop</span><span>P&L</span></div>{positions.map((position) => <PositionRow key={position.id ?? `${position.symbol}-${position.time}`} position={position} currency={currency} />)}</div> : <EmptyState icon={Crosshair} title="No open positions" copy="The broker returned an empty position book. New trades remain protected by the server risk gates." action={<button className="button button-quiet" onClick={() => setTradeOpen(true)} disabled={!accountId} data-testid="button-empty-new-order">Open order ticket</button>} />}</section>
            <section className="panel"><SectionHeader eyebrow="Risk posture" title="Account guardrails" action={<Link href="/settings" className="text-link" data-testid="link-risk-settings">Edit limits <ChevronRight size={13} /></Link>} /><div className="risk-stack"><div className="risk-row"><span><ShieldAlert size={15} /> Risk / trade</span><strong>{snapshot?.risk?.riskPerTrade == null ? <Unavailable /> : `${formatNumber(snapshot.risk.riskPerTrade)}%`}</strong></div><div className="risk-row"><span><TrendingDown size={15} /> Daily loss cap</span><strong>{snapshot?.risk?.dailyLoss == null ? <Unavailable /> : `${formatNumber(snapshot.risk.dailyLoss)}%`}</strong></div><div className="risk-row"><span><Clock3 size={15} /> News blackout</span><strong>{snapshot?.risk?.newsMinutes == null ? <Unavailable /> : `${snapshot.risk.newsMinutes} min`}</strong></div><div className="risk-meter"><div><span>Position book</span><span className="mono">{positions.length ? 'ACTIVE' : 'FLAT'}</span></div><div className="meter-track"><span style={{ width: positions.length ? '100%' : '0%' }} /></div><small>Only broker-confirmed positions contribute.</small></div></div></section>
          </div>
          <div className="dashboard-grid">
            <section className="panel panel-wide"><SectionHeader eyebrow="Strategy telemetry" title="Market structure states" action={<button className="text-button" onClick={() => run()} disabled={runEngine.isPending || !states.length} data-testid="button-run-all-engine"><RefreshCw size={13} className={runEngine.isPending ? 'spin' : ''} /> {runEngine.isPending ? 'Analyzing' : 'Analyze all'}</button>} />{states.length ? <div className="state-grid-list">{states.map((state) => <StateCard key={state.id ?? state.symbol} state={state} onRun={() => run([state.symbol])} />)}</div> : <EmptyState icon={Activity} title="Market state unavailable" copy="No symbol states were returned by the strategy engine." />}</section>
            <section className="panel diagnostics-panel"><SectionHeader eyebrow="System notes" title="Diagnostics" /><div className="diagnostic-list">{(snapshot?.diagnostics ?? []).length ? snapshot?.diagnostics.map((diagnostic, index) => <div className="diagnostic-item" key={`${diagnostic}-${index}`}><StatusDot tone={diagnostic.toLowerCase().includes('error') || diagnostic.toLowerCase().includes('fail') ? 'red' : 'amber'} /><span>{diagnostic}</span></div>) : <div className="diagnostic-item diagnostic-ok"><Check size={14} /><span>No diagnostics returned</span></div>}</div><div className="account-facts"><div><span>Account</span><code>{account?.accountId || accountId}</code></div><div><span>Broker / server</span><strong>{account?.brokerName || <Unavailable />} <em>/</em> {account?.server || <Unavailable />}</strong></div><div><span>Leverage</span><strong>{account?.leverageDisplay || (account?.leverage ? `1:${account.leverage}` : <Unavailable />)}</strong></div></div></section>
          </div>
          <div className="dashboard-grid">
            <section className="panel panel-wide"><SectionHeader eyebrow="Performance curve" title="Equity history" action={<Link href="/journal" className="text-link" data-testid="link-full-equity-history">Full history <ChevronRight size={13} /></Link>} /><EquityChart points={snapshot?.equityHistory ?? []} currency={currency} /></section>
            <section className="panel"><SectionHeader eyebrow="Recent activity" title="Journal" action={<Link href="/journal" className="text-link" data-testid="link-full-journal">View all <ChevronRight size={13} /></Link>} /><JournalMini entries={snapshot?.journal ?? []} currency={currency} /></section>
          </div>
        </>
      )}
      {tradeOpen && <div className="modal-scrim"><form className="modal-card" onSubmit={submitTrade}><div className="modal-head"><div><span className="eyebrow">Protected execution</span><h2>New order ticket</h2></div><button type="button" className="icon-button" onClick={() => setTradeOpen(false)} data-testid="button-close-order-ticket"><X size={17} /></button></div><p className="modal-warning"><ShieldAlert size={15} /> Server risk gates are evaluated before MetaApi execution. Do not rely on this ticket as a risk calculation.</p><div className="form-grid"><label>Display symbol<input required value={tradeForm.symbol} onChange={(event) => setTradeForm({ ...tradeForm, symbol: event.target.value.toUpperCase() })} placeholder="EURUSD" data-testid="input-trade-symbol" /></label><label>Broker symbol<input value={tradeForm.realSymbol} onChange={(event) => setTradeForm({ ...tradeForm, realSymbol: event.target.value.toUpperCase() })} placeholder="Optional override" data-testid="input-trade-real-symbol" /></label><label>Direction<select value={tradeForm.direction} onChange={(event) => setTradeForm({ ...tradeForm, direction: event.target.value as 'BUY' | 'SELL' })} data-testid="select-trade-direction"><option value="BUY">BUY</option><option value="SELL">SELL</option></select></label><label>Lot size<input required type="number" min="0.01" step="0.01" value={tradeForm.lot} onChange={(event) => setTradeForm({ ...tradeForm, lot: event.target.value })} placeholder="0.10" data-testid="input-trade-lot" /></label><label>Stop loss<input required type="number" step="any" value={tradeForm.sl} onChange={(event) => setTradeForm({ ...tradeForm, sl: event.target.value })} placeholder="1.08200" data-testid="input-trade-sl" /></label><label>Take profit<input required type="number" step="any" value={tradeForm.tp} onChange={(event) => setTradeForm({ ...tradeForm, tp: event.target.value })} placeholder="1.09100" data-testid="input-trade-tp" /></label></div><div className="modal-actions"><button type="button" className="button button-quiet" onClick={() => setTradeOpen(false)} data-testid="button-cancel-order">Cancel</button><button type="submit" className="button button-primary" disabled={executeTrade.isPending} data-testid="button-submit-order">{executeTrade.isPending ? <><Loader2 size={14} className="spin" /> Sending</> : <><Zap size={14} /> Send protected order</>}</button></div>{executeTrade.isError && <div className="inline-error">{getErrorMessage(executeTrade.error)}</div>}</form></div>}
    </div>
  );
}

function JournalMini({ entries, currency }: { entries: JournalEntry[]; currency?: string | null }) {
  if (!entries.length) return <EmptyState icon={BookOpen} title="Journal is empty" copy="Closed and pending trades will appear after the broker confirms them." />;
  return <div className="journal-mini-list">{entries.slice(0, 5).map((entry) => <div className="journal-mini-row" key={entry.id} data-testid={`row-journal-mini-${entry.id}`}><div><strong>{entry.symbol}</strong><span>{entry.direction} · {entry.status}</span></div><strong className={`pnl ${entry.pnl != null && entry.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{entry.pnl == null ? <Unavailable /> : formatMoney(entry.pnl, currency)}</strong></div>)}</div>;
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const accountId = accountIdFromStorage();
  const risk = useGetRiskSettings(accountId || 'unconfigured', { query: { enabled: Boolean(accountId), queryKey: getGetRiskSettingsQueryKey(accountId || 'unconfigured') } });
  const broker = useGetBrokerBalance({ accountId: accountId || 'unconfigured' }, { query: { enabled: Boolean(accountId), queryKey: getGetBrokerBalanceQueryKey({ accountId: accountId || 'unconfigured' }), refetchInterval: 20000 } });
  const connectBroker = useConnectBroker();
  const disconnectBroker = useDisconnectBroker();
  const updateRisk = useUpdateRiskSettings();
  const closeAll = useCloseAllPositions();
  const [form, setForm] = useState({ login: '', password: '', server: '', brokerName: '' });
  const [riskForm, setRiskForm] = useState({ riskPerTrade: '', dailyLoss: '', weeklyLoss: '', spreadMultiplier: '', newsMinutes: '' });
  const [fridayProtect, setFridayProtect] = useState(true);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string }>();
  const [disconnectPrompt, setDisconnectPrompt] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  useEffect(() => {
    if (risk.data) setRiskForm({ riskPerTrade: String(risk.data.riskPerTrade), dailyLoss: String(risk.data.dailyLoss), weeklyLoss: String(risk.data.weeklyLoss), spreadMultiplier: String(risk.data.spreadMultiplier), newsMinutes: String(risk.data.newsMinutes) });
  }, [risk.data]);
  useEffect(() => { document.title = 'Control settings · Money Harvester Pro'; }, []);
  const connect = (event: FormEvent) => {
    event.preventDefault();
    setNotice(undefined);
    connectBroker.mutate({ data: form }, {
      onSuccess: (account) => {
        window.localStorage.setItem(ACCOUNT_KEY, account.accountId);
        setNotice({ type: 'success', text: `Server confirmed ${account.accountId}. Broker connection is live.` });
        queryClient.invalidateQueries();
      },
      onError: (error) => {
        const message = getErrorMessage(error);
        setNotice({ type: 'error', text: message.includes('METAAPI_TOKEN') ? 'Add METAAPI_TOKEN in Secrets before connecting a live account.' : message });
      },
    });
  };
  const saveRisk = (event: FormEvent) => {
    event.preventDefault();
    if (!accountId) return;
    const data: RiskSettingsInput = { riskPerTrade: Number(riskForm.riskPerTrade), dailyLoss: Number(riskForm.dailyLoss), weeklyLoss: Number(riskForm.weeklyLoss), spreadMultiplier: Number(riskForm.spreadMultiplier), newsMinutes: Number(riskForm.newsMinutes) };
    setNotice(undefined);
    updateRisk.mutate({ accountId, data }, { onSuccess: () => { setNotice({ type: 'success', text: 'Risk limits saved on the server.' }); queryClient.invalidateQueries({ queryKey: getGetRiskSettingsQueryKey(accountId) }); }, onError: (error) => setNotice({ type: 'error', text: getErrorMessage(error) }) });
  };
  const emergency = () => {
    if (!accountId) return;
    closeAll.mutate({ data: { accountId } }, { onSuccess: (result) => { setDisconnectPrompt(false); setNotice({ type: 'success', text: result.message || `${result.count} positions closed.` }); }, onError: (error) => setNotice({ type: 'error', text: getErrorMessage(error) }) });
  };
  const disconnect = () => {
    if (!accountId) return;
    disconnectBroker.mutate({ data: { accountId } }, {
      onSuccess: (result) => {
        window.localStorage.removeItem(ACCOUNT_KEY);
        setDisconnectOpen(false);
        setNotice({ type: 'success', text: result.message || 'MetaApi account undeployed.' });
        queryClient.clear();
        window.location.reload();
      },
      onError: (error) => setNotice({ type: 'error', text: getErrorMessage(error) }),
    });
  };
  const updateField = (key: keyof typeof riskForm, value: string) => setRiskForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="page-wrap">
      <PageHeader title="Control settings" description="Set the rules before the market gets loud. Values are saved to the connected account."><span className="settings-lock"><KeyRound size={14} /> Server-enforced controls</span></PageHeader>
      {notice && <div className={`notice-banner notice-${notice.type}`} data-testid="status-settings-feedback">{notice.type === 'success' ? <Check size={15} /> : <TriangleAlert size={15} />}<span>{notice.text}</span><button onClick={() => setNotice(undefined)} data-testid="button-dismiss-settings-notice"><X size={14} /></button></div>}
      <div className="settings-layout">
        <div className="settings-main">
          <section className="panel settings-panel"><SectionHeader eyebrow="01 / Risk envelope" title="Position risk limits" action={accountId ? <span className="server-badge"><StatusDot /> synced to server</span> : <span className="server-badge server-badge-muted">no account selected</span>} />{!accountId ? <AccountMissing destination="/settings" /> : risk.isLoading ? <SkeletonRows count={4} /> : risk.isError ? <ErrorState message={getErrorMessage(risk.error)} onRetry={() => risk.refetch()} /> : <form onSubmit={saveRisk}><div className="settings-fields"><SettingField label="Risk per trade" hint="Maximum account risk on one order" value={riskForm.riskPerTrade} suffix="%" onChange={(value) => updateField('riskPerTrade', value)} testId="input-risk-per-trade" /><SettingField label="Daily loss limit" hint="Trading gate after realized drawdown" value={riskForm.dailyLoss} suffix="%" onChange={(value) => updateField('dailyLoss', value)} testId="input-daily-loss" /><SettingField label="Weekly loss limit" hint="Hard stop for the current trading week" value={riskForm.weeklyLoss} suffix="%" onChange={(value) => updateField('weeklyLoss', value)} testId="input-weekly-loss" /><SettingField label="Spread multiplier" hint="Reject when spread exceeds this multiple" value={riskForm.spreadMultiplier} suffix="×" onChange={(value) => updateField('spreadMultiplier', value)} testId="input-spread-multiplier" /><SettingField label="News blackout" hint="Minutes before and after high-impact news" value={riskForm.newsMinutes} suffix="min" onChange={(value) => updateField('newsMinutes', value)} testId="input-news-minutes" /></div><div className="form-footer"><span className="muted-text"><CircleHelp size={14} /> Server validates permitted ranges.</span><button type="submit" className="button button-primary" disabled={updateRisk.isPending} data-testid="button-save-risk-settings">{updateRisk.isPending ? <><Loader2 size={14} className="spin" /> Saving</> : <><Check size={14} /> Save limits</>}</button></div></form>}</section>
          <section className="panel settings-panel"><SectionHeader eyebrow="02 / Market protections" title="Trade conditions" /><div className="toggle-list"><ToggleRow label="Friday protection" description="Block new entries during the late-Friday liquidity window." checked={fridayProtect} onChange={() => setFridayProtect(!fridayProtect)} testId="button-toggle-friday-protection" /><ToggleRow label="News protection" description={accountId ? 'Server gate uses the blackout minutes above.' : 'Connect an account to configure server protection.'} checked={Boolean(accountId && risk.data?.newsMinutes)} onChange={() => undefined} disabled testId="button-toggle-news-protection" /><ToggleRow label="Spread protection" description={accountId ? 'Server gate uses the multiplier above.' : 'Connect an account to configure server protection.'} checked={Boolean(accountId && risk.data?.spreadMultiplier)} onChange={() => undefined} disabled testId="button-toggle-spread-protection" /></div><div className="settings-note"><AlertTriangle size={14} /><span>Friday protection is a local UI preference until a dedicated server field is available. It does not claim to change broker behavior.</span></div></section>
        </div>
        <div className="settings-side">
          <section className="panel settings-panel"><SectionHeader eyebrow="03 / Broker connection" title="MetaApi account" /><div className="broker-options">{['Weltrade', 'Exness', 'Headway'].map((name) => <button type="button" className={`broker-option ${form.brokerName === name ? 'broker-option-active' : ''}`} key={name} onClick={() => setForm({ ...form, brokerName: name })} data-testid={`button-broker-${name.toLowerCase()}`}><strong>{name}</strong><span>Min lot <b>0.01</b></span><span>Leverage <b>From broker account</b></span></button>)}</div>{accountId && <><div className="connected-account"><div className="connected-avatar"><Wifi size={16} /></div><div><strong>{accountId}</strong><span>Selected live account</span></div><StatusDot /></div><div className="broker-facts"><div><span>Balance</span><strong>{formatMoney(broker.data?.balance, broker.data?.currency)}</strong></div><div><span>Equity</span><strong>{formatMoney(broker.data?.equity, broker.data?.currency)}</strong></div><div><span>Leverage</span><strong>{broker.data?.leverageDisplay || <Unavailable />}</strong></div><div><span>Currency</span><strong>{broker.data?.currency || <Unavailable />}</strong></div><div><span>Margin</span><strong>{broker.data?.margin == null ? <Unavailable /> : formatMoney(broker.data.margin, broker.data.currency)}</strong></div></div></>}<form onSubmit={connect} className="broker-form"><label>Broker name<input required value={form.brokerName} onChange={(event) => setForm({ ...form, brokerName: event.target.value })} placeholder="Select a broker above" data-testid="input-broker-name" /></label><label>Server<input required value={form.server} onChange={(event) => setForm({ ...form, server: event.target.value })} placeholder="Exness-Real" data-testid="input-broker-server" /></label><label>Login<input required autoComplete="username" value={form.login} onChange={(event) => setForm({ ...form, login: event.target.value })} placeholder="Account login" data-testid="input-broker-login" /></label><label>Password<input required type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Broker password" data-testid="input-broker-password" /></label><button type="submit" className="button button-primary button-full" disabled={connectBroker.isPending} data-testid="button-connect-broker">{connectBroker.isPending ? <><Loader2 size={14} className="spin" /> Deploying bridge...</> : <><Wifi size={14} /> Verify &amp; connect</>}</button></form><p className="secret-note"><KeyRound size={14} /><span>Credentials are submitted to the server. MetaApi access requires the exact <code>Add METAAPI_TOKEN in Secrets</code> configuration.</span></p></section>
          <section className="panel danger-panel"><SectionHeader eyebrow="04 / Emergency controls" title="Flatten account" /><p>Close every open position through the broker connection. This is irreversible and server-confirmed.</p>{disconnectPrompt ? <div className="confirm-box"><strong>Confirm close-all?</strong><span>All open positions for {accountId || 'the selected account'} will be sent for closure.</span><div><button className="button button-quiet" onClick={() => setDisconnectPrompt(false)} data-testid="button-cancel-emergency">Cancel</button><button className="button button-danger" onClick={emergency} disabled={!accountId || closeAll.isPending} data-testid="button-confirm-emergency">{closeAll.isPending ? 'Sending' : 'Confirm flatten'}</button></div></div> : <button className="button button-danger button-full" disabled={!accountId} onClick={() => setDisconnectPrompt(true)} data-testid="button-open-emergency-confirm"><Power size={14} /> Close all positions</button>}<span className="danger-foot"><ShieldAlert size={13} /> Requires a connected account</span></section>
        </div>
      </div>
    </div>
  );
}

function SettingField({ label, hint, value, suffix, onChange, testId }: { label: string; hint: string; value: string; suffix: string; onChange: (value: string) => void; testId: string }) {
  return <label className="setting-field"><span><strong>{label}</strong><small>{hint}</small></span><div className="input-with-suffix"><input type="number" min="0" step="0.1" value={value} onChange={(event) => onChange(event.target.value)} data-testid={testId} /><em>{suffix}</em></div></label>;
}

function ToggleRow({ label, description, checked, onChange, disabled, testId }: { label: string; description: string; checked: boolean; onChange: () => void; disabled?: boolean; testId: string }) {
  return <div className={`toggle-row ${disabled ? 'toggle-disabled' : ''}`}><div><strong>{label}</strong><span>{description}</span></div><button className={`toggle ${checked ? 'toggle-on' : ''}`} onClick={onChange} disabled={disabled} aria-pressed={checked} data-testid={testId}><span /></button></div>;
}

function JournalPage() {
  const accountId = accountIdFromStorage();
  const params = { accountId: accountId || 'unconfigured' };
  const journal = useGetJournal(params, { query: { enabled: Boolean(accountId), queryKey: getGetJournalQueryKey(params), refetchInterval: 20000 } });
  const equity = useGetEquityHistory(params, { query: { enabled: Boolean(accountId), queryKey: getGetEquityHistoryQueryKey(params), refetchInterval: 20000 } });
  const [filter, setFilter] = useState('');
  const entries = useMemo(() => (journal.data ?? []).filter((entry) => !filter || entry.symbol.toLowerCase().includes(filter.toLowerCase()) || entry.status.toLowerCase().includes(filter.toLowerCase())), [journal.data, filter]);
  useEffect(() => { document.title = 'Trade journal · Money Harvester Pro'; }, []);
  return (
    <div className="page-wrap">
      <PageHeader title="Trade journal" description="The execution record, kept close to the equity curve."><div className="journal-search"><Activity size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter symbol or status" data-testid="input-journal-filter" /></div></PageHeader>
      {!accountId ? <AccountMissing /> : (journal.isError || equity.isError) ? <ErrorState message={getErrorMessage(journal.error || equity.error)} onRetry={() => { journal.refetch(); equity.refetch(); }} /> : <><section className="panel"><SectionHeader eyebrow="Performance curve" title="Equity history" action={<span className="chart-as-of mono">{equity.data?.length ? `${equity.data.length} broker points` : 'No broker points'}</span>} />{equity.isLoading ? <SkeletonRows count={3} /> : <EquityChart points={equity.data ?? []} />}</section><section className="panel journal-table-panel"><SectionHeader eyebrow="Execution record" title="All trades" action={<span className="count-pill">{entries.length} records</span>} />{journal.isLoading ? <SkeletonRows count={6} /> : entries.length ? <div className="journal-table"><div className="journal-heading"><span>Trade</span><span>Direction</span><span>Entry / SL / TP</span><span>Size</span><span>R multiple</span><span>P&L</span><span>Status</span></div>{entries.map((entry) => <JournalRow key={entry.id} entry={entry} />)}</div> : <EmptyState icon={BookOpen} title={filter ? 'No matching trades' : 'No journal entries'} copy={filter ? 'Try a different symbol or status filter.' : 'When executions are recorded by the server, they will appear here.'} />}</section></>}
    </div>
  );
}

function JournalRow({ entry, currency }: { entry: JournalEntry; currency?: string | null }) {
  return <div className="journal-row" data-testid={`row-journal-${entry.id}`}><div className="journal-trade"><strong>{entry.symbol}</strong><span>{entry.realSymbol || 'Broker symbol unavailable'} · {formatDate(entry.createdAt)}</span></div><span className={`direction-text ${entry.direction?.toLowerCase().includes('sell') ? 'text-red' : 'text-green'}`}>{entry.direction}</span><span className="mono trade-levels">{entry.entry == null ? '—' : formatNumber(entry.entry, 5)} <i>/</i> {entry.sl == null ? '—' : formatNumber(entry.sl, 5)} <i>/</i> {entry.tp == null ? '—' : formatNumber(entry.tp, 5)}</span><span className="mono">{entry.lot == null ? <Unavailable /> : formatNumber(entry.lot, 2)}</span><span className={`mono ${entry.rMultiple != null && entry.rMultiple >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{entry.rMultiple == null ? <Unavailable /> : `${entry.rMultiple >= 0 ? '+' : ''}${formatNumber(entry.rMultiple)}R`}</span><strong className={`mono ${entry.pnl != null && entry.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{entry.pnl == null ? <Unavailable /> : formatMoney(entry.pnl, currency)}</strong><span className="journal-status">{entry.status}</span></div>;
}

function Router() {
  return <ErrorBoundary><AppShell><Switch><Route path="/" component={OverviewPage} /><Route path="/settings" component={SettingsPage} /><Route path="/journal" component={JournalPage} /><Route component={NotFound} /></Switch></AppShell></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;