import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { AccountActionInput, ActionResult, BacktestInput, BacktestResult, BadRequestResponse, BrokerAccount, BrokerConnectInput, ConflictResponse, DashboardSnapshot, DisconnectResult, EngineRunInput, EngineState, EquityPoint, GetBrokerBalanceParams, GetBrokerMarketDataParams, GetBrokerPositionsParams, GetDashboardParams, GetEngineStatesParams, GetEquityHistoryParams, GetJournalParams, HealthStatus, JournalEntry, MarketDataHealth, Position, RiskSettings, RiskSettingsInput, ServerErrorResponse, TradeExecuteInput, TradeExecution, UpstreamErrorResponse } from './api.schemas';
import { customFetch } from '../custom-fetch';
import type { ErrorType, BodyType } from '../custom-fetch';
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
export declare const getHealthCheckUrl: () => string;
/**
 * Returns server health status
 * @summary Health check
 */
export declare const healthCheck: (options?: Parameters<typeof customFetch>[1]) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/health"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetDashboardUrl: (params: GetDashboardParams) => string;
/**
 * @summary Read the live dashboard snapshot
 */
export declare const getDashboard: (params: GetDashboardParams, options?: Parameters<typeof customFetch>[1]) => Promise<DashboardSnapshot>;
export declare const getGetDashboardQueryKey: (params?: GetDashboardParams) => readonly ["/api/dashboard", ...GetDashboardParams[]];
export declare const getGetDashboardQueryOptions: <TData = Awaited<ReturnType<typeof getDashboard>>, TError = ErrorType<BadRequestResponse | ServerErrorResponse>>(params: GetDashboardParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDashboard>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getDashboard>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetDashboardQueryResult = NonNullable<Awaited<ReturnType<typeof getDashboard>>>;
export type GetDashboardQueryError = ErrorType<BadRequestResponse | ServerErrorResponse>;
/**
 * @summary Read the live dashboard snapshot
 */
export declare function useGetDashboard<TData = Awaited<ReturnType<typeof getDashboard>>, TError = ErrorType<BadRequestResponse | ServerErrorResponse>>(params: GetDashboardParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDashboard>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getConnectBrokerUrl: () => string;
/**
 * @summary Provision and connect a live MetaApi account
 */
export declare const connectBroker: (brokerConnectInput: BrokerConnectInput, options?: Parameters<typeof customFetch>[1]) => Promise<BrokerAccount>;
export declare const getConnectBrokerMutationOptions: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof connectBroker>>, TError, {
        data: BodyType<BrokerConnectInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof connectBroker>>, TError, {
    data: BodyType<BrokerConnectInput>;
}, TContext>;
export type ConnectBrokerMutationResult = NonNullable<Awaited<ReturnType<typeof connectBroker>>>;
export type ConnectBrokerMutationBody = BodyType<BrokerConnectInput>;
export type ConnectBrokerMutationError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
* @summary Provision and connect a live MetaApi account
*/
export declare const useConnectBroker: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof connectBroker>>, TError, {
        data: BodyType<BrokerConnectInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof connectBroker>>, TError, {
    data: BodyType<BrokerConnectInput>;
}, TContext>;
export declare const getGetBrokerBalanceUrl: (params: GetBrokerBalanceParams) => string;
/**
 * @summary Read live account information and open positions
 */
export declare const getBrokerBalance: (params: GetBrokerBalanceParams, options?: Parameters<typeof customFetch>[1]) => Promise<BrokerAccount>;
export declare const getGetBrokerBalanceQueryKey: (params?: GetBrokerBalanceParams) => readonly ["/api/broker/balance", ...GetBrokerBalanceParams[]];
export declare const getGetBrokerBalanceQueryOptions: <TData = Awaited<ReturnType<typeof getBrokerBalance>>, TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>>(params: GetBrokerBalanceParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBrokerBalance>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBrokerBalance>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBrokerBalanceQueryResult = NonNullable<Awaited<ReturnType<typeof getBrokerBalance>>>;
export type GetBrokerBalanceQueryError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
 * @summary Read live account information and open positions
 */
export declare function useGetBrokerBalance<TData = Awaited<ReturnType<typeof getBrokerBalance>>, TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>>(params: GetBrokerBalanceParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBrokerBalance>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBrokerPositionsUrl: (params: GetBrokerPositionsParams) => string;
/**
 * @summary Read live broker positions
 */
export declare const getBrokerPositions: (params: GetBrokerPositionsParams, options?: Parameters<typeof customFetch>[1]) => Promise<Position[]>;
export declare const getGetBrokerPositionsQueryKey: (params?: GetBrokerPositionsParams) => readonly ["/api/broker/positions", ...GetBrokerPositionsParams[]];
export declare const getGetBrokerPositionsQueryOptions: <TData = Awaited<ReturnType<typeof getBrokerPositions>>, TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>>(params: GetBrokerPositionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBrokerPositions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBrokerPositions>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBrokerPositionsQueryResult = NonNullable<Awaited<ReturnType<typeof getBrokerPositions>>>;
export type GetBrokerPositionsQueryError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
 * @summary Read live broker positions
 */
export declare function useGetBrokerPositions<TData = Awaited<ReturnType<typeof getBrokerPositions>>, TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>>(params: GetBrokerPositionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBrokerPositions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetBrokerMarketDataUrl: (params: GetBrokerMarketDataParams) => string;
/**
 * @summary Read live quote and broker symbol health
 */
export declare const getBrokerMarketData: (params: GetBrokerMarketDataParams, options?: Parameters<typeof customFetch>[1]) => Promise<MarketDataHealth>;
export declare const getGetBrokerMarketDataQueryKey: (params?: GetBrokerMarketDataParams) => readonly ["/api/broker/market-data", ...GetBrokerMarketDataParams[]];
export declare const getGetBrokerMarketDataQueryOptions: <TData = Awaited<ReturnType<typeof getBrokerMarketData>>, TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>>(params: GetBrokerMarketDataParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBrokerMarketData>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBrokerMarketData>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBrokerMarketDataQueryResult = NonNullable<Awaited<ReturnType<typeof getBrokerMarketData>>>;
export type GetBrokerMarketDataQueryError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
 * @summary Read live quote and broker symbol health
 */
export declare function useGetBrokerMarketData<TData = Awaited<ReturnType<typeof getBrokerMarketData>>, TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>>(params: GetBrokerMarketDataParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBrokerMarketData>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCloseAllPositionsUrl: () => string;
/**
 * @summary Close every open position for an account
 */
export declare const closeAllPositions: (accountActionInput: AccountActionInput, options?: Parameters<typeof customFetch>[1]) => Promise<ActionResult>;
export declare const getCloseAllPositionsMutationOptions: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof closeAllPositions>>, TError, {
        data: BodyType<AccountActionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof closeAllPositions>>, TError, {
    data: BodyType<AccountActionInput>;
}, TContext>;
export type CloseAllPositionsMutationResult = NonNullable<Awaited<ReturnType<typeof closeAllPositions>>>;
export type CloseAllPositionsMutationBody = BodyType<AccountActionInput>;
export type CloseAllPositionsMutationError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
* @summary Close every open position for an account
*/
export declare const useCloseAllPositions: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof closeAllPositions>>, TError, {
        data: BodyType<AccountActionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof closeAllPositions>>, TError, {
    data: BodyType<AccountActionInput>;
}, TContext>;
export declare const getDisconnectBrokerUrl: () => string;
/**
 * @summary Undeploy a MetaApi broker account
 */
export declare const disconnectBroker: (accountActionInput: AccountActionInput, options?: Parameters<typeof customFetch>[1]) => Promise<DisconnectResult>;
export declare const getDisconnectBrokerMutationOptions: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof disconnectBroker>>, TError, {
        data: BodyType<AccountActionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof disconnectBroker>>, TError, {
    data: BodyType<AccountActionInput>;
}, TContext>;
export type DisconnectBrokerMutationResult = NonNullable<Awaited<ReturnType<typeof disconnectBroker>>>;
export type DisconnectBrokerMutationBody = BodyType<AccountActionInput>;
export type DisconnectBrokerMutationError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
* @summary Undeploy a MetaApi broker account
*/
export declare const useDisconnectBroker: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof disconnectBroker>>, TError, {
        data: BodyType<AccountActionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof disconnectBroker>>, TError, {
    data: BodyType<AccountActionInput>;
}, TContext>;
export declare const getGetEngineStatesUrl: (params: GetEngineStatesParams) => string;
/**
 * @summary Read per-symbol strategy states
 */
export declare const getEngineStates: (params: GetEngineStatesParams, options?: Parameters<typeof customFetch>[1]) => Promise<EngineState[]>;
export declare const getGetEngineStatesQueryKey: (params?: GetEngineStatesParams) => readonly ["/api/engine/states", ...GetEngineStatesParams[]];
export declare const getGetEngineStatesQueryOptions: <TData = Awaited<ReturnType<typeof getEngineStates>>, TError = ErrorType<BadRequestResponse>>(params: GetEngineStatesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getEngineStates>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getEngineStates>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetEngineStatesQueryResult = NonNullable<Awaited<ReturnType<typeof getEngineStates>>>;
export type GetEngineStatesQueryError = ErrorType<BadRequestResponse>;
/**
 * @summary Read per-symbol strategy states
 */
export declare function useGetEngineStates<TData = Awaited<ReturnType<typeof getEngineStates>>, TError = ErrorType<BadRequestResponse>>(params: GetEngineStatesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getEngineStates>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getRunEngineUrl: () => string;
/**
 * @summary Analyze live candles and update strategy state
 */
export declare const runEngine: (engineRunInput: EngineRunInput, options?: Parameters<typeof customFetch>[1]) => Promise<EngineState[]>;
export declare const getRunEngineMutationOptions: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runEngine>>, TError, {
        data: BodyType<EngineRunInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof runEngine>>, TError, {
    data: BodyType<EngineRunInput>;
}, TContext>;
export type RunEngineMutationResult = NonNullable<Awaited<ReturnType<typeof runEngine>>>;
export type RunEngineMutationBody = BodyType<EngineRunInput>;
export type RunEngineMutationError = ErrorType<BadRequestResponse | UpstreamErrorResponse>;
/**
* @summary Analyze live candles and update strategy state
*/
export declare const useRunEngine: <TError = ErrorType<BadRequestResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runEngine>>, TError, {
        data: BodyType<EngineRunInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof runEngine>>, TError, {
    data: BodyType<EngineRunInput>;
}, TContext>;
export declare const getRunBacktestUrl: () => string;
/**
 * @summary Replay real broker candles with explicit trading costs
 */
export declare const runBacktest: (backtestInput: BacktestInput, options?: Parameters<typeof customFetch>[1]) => Promise<BacktestResult>;
export declare const getRunBacktestMutationOptions: <TError = ErrorType<BadRequestResponse | ConflictResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runBacktest>>, TError, {
        data: BodyType<BacktestInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof runBacktest>>, TError, {
    data: BodyType<BacktestInput>;
}, TContext>;
export type RunBacktestMutationResult = NonNullable<Awaited<ReturnType<typeof runBacktest>>>;
export type RunBacktestMutationBody = BodyType<BacktestInput>;
export type RunBacktestMutationError = ErrorType<BadRequestResponse | ConflictResponse | UpstreamErrorResponse>;
/**
* @summary Replay real broker candles with explicit trading costs
*/
export declare const useRunBacktest: <TError = ErrorType<BadRequestResponse | ConflictResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runBacktest>>, TError, {
        data: BodyType<BacktestInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof runBacktest>>, TError, {
    data: BodyType<BacktestInput>;
}, TContext>;
export declare const getExecuteTradeUrl: () => string;
/**
 * @summary Execute a protected live MetaApi order
 */
export declare const executeTrade: (tradeExecuteInput: TradeExecuteInput, options?: Parameters<typeof customFetch>[1]) => Promise<TradeExecution>;
export declare const getExecuteTradeMutationOptions: <TError = ErrorType<BadRequestResponse | ConflictResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof executeTrade>>, TError, {
        data: BodyType<TradeExecuteInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof executeTrade>>, TError, {
    data: BodyType<TradeExecuteInput>;
}, TContext>;
export type ExecuteTradeMutationResult = NonNullable<Awaited<ReturnType<typeof executeTrade>>>;
export type ExecuteTradeMutationBody = BodyType<TradeExecuteInput>;
export type ExecuteTradeMutationError = ErrorType<BadRequestResponse | ConflictResponse | UpstreamErrorResponse>;
/**
* @summary Execute a protected live MetaApi order
*/
export declare const useExecuteTrade: <TError = ErrorType<BadRequestResponse | ConflictResponse | UpstreamErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof executeTrade>>, TError, {
        data: BodyType<TradeExecuteInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof executeTrade>>, TError, {
    data: BodyType<TradeExecuteInput>;
}, TContext>;
export declare const getGetJournalUrl: (params: GetJournalParams) => string;
/**
 * @summary Read journal entries
 */
export declare const getJournal: (params: GetJournalParams, options?: Parameters<typeof customFetch>[1]) => Promise<JournalEntry[]>;
export declare const getGetJournalQueryKey: (params?: GetJournalParams) => readonly ["/api/journal", ...GetJournalParams[]];
export declare const getGetJournalQueryOptions: <TData = Awaited<ReturnType<typeof getJournal>>, TError = ErrorType<BadRequestResponse>>(params: GetJournalParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getJournal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getJournal>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetJournalQueryResult = NonNullable<Awaited<ReturnType<typeof getJournal>>>;
export type GetJournalQueryError = ErrorType<BadRequestResponse>;
/**
 * @summary Read journal entries
 */
export declare function useGetJournal<TData = Awaited<ReturnType<typeof getJournal>>, TError = ErrorType<BadRequestResponse>>(params: GetJournalParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getJournal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetEquityHistoryUrl: (params: GetEquityHistoryParams) => string;
/**
 * @summary Read equity history
 */
export declare const getEquityHistory: (params: GetEquityHistoryParams, options?: Parameters<typeof customFetch>[1]) => Promise<EquityPoint[]>;
export declare const getGetEquityHistoryQueryKey: (params?: GetEquityHistoryParams) => readonly ["/api/equity-history", ...GetEquityHistoryParams[]];
export declare const getGetEquityHistoryQueryOptions: <TData = Awaited<ReturnType<typeof getEquityHistory>>, TError = ErrorType<BadRequestResponse>>(params: GetEquityHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getEquityHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getEquityHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetEquityHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof getEquityHistory>>>;
export type GetEquityHistoryQueryError = ErrorType<BadRequestResponse>;
/**
 * @summary Read equity history
 */
export declare function useGetEquityHistory<TData = Awaited<ReturnType<typeof getEquityHistory>>, TError = ErrorType<BadRequestResponse>>(params: GetEquityHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getEquityHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetRiskSettingsUrl: (accountId: string) => string;
/**
 * @summary Read risk limits
 */
export declare const getRiskSettings: (accountId: string, options?: Parameters<typeof customFetch>[1]) => Promise<RiskSettings>;
export declare const getGetRiskSettingsQueryKey: (accountId: string) => readonly [`/api/risk-settings/${string}`];
export declare const getGetRiskSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getRiskSettings>>, TError = ErrorType<BadRequestResponse>>(accountId: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getRiskSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getRiskSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetRiskSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getRiskSettings>>>;
export type GetRiskSettingsQueryError = ErrorType<BadRequestResponse>;
/**
 * @summary Read risk limits
 */
export declare function useGetRiskSettings<TData = Awaited<ReturnType<typeof getRiskSettings>>, TError = ErrorType<BadRequestResponse>>(accountId: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getRiskSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateRiskSettingsUrl: (accountId: string) => string;
/**
 * @summary Update risk limits
 */
export declare const updateRiskSettings: (accountId: string, riskSettingsInput: RiskSettingsInput, options?: Parameters<typeof customFetch>[1]) => Promise<RiskSettings>;
export declare const getUpdateRiskSettingsMutationOptions: <TError = ErrorType<BadRequestResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateRiskSettings>>, TError, {
        accountId: string;
        data: BodyType<RiskSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateRiskSettings>>, TError, {
    accountId: string;
    data: BodyType<RiskSettingsInput>;
}, TContext>;
export type UpdateRiskSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateRiskSettings>>>;
export type UpdateRiskSettingsMutationBody = BodyType<RiskSettingsInput>;
export type UpdateRiskSettingsMutationError = ErrorType<BadRequestResponse>;
/**
* @summary Update risk limits
*/
export declare const useUpdateRiskSettings: <TError = ErrorType<BadRequestResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateRiskSettings>>, TError, {
        accountId: string;
        data: BodyType<RiskSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateRiskSettings>>, TError, {
    accountId: string;
    data: BodyType<RiskSettingsInput>;
}, TContext>;
export {};
//# sourceMappingURL=api.d.ts.map