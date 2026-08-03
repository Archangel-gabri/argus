// Shared, secret-free types re-exported from the main process (type-only — erased at build).
export type {
  DeviceDTO,
  DeviceInput,
  VaultState,
  VaultStatus,
  Status,
  Currency,
  AuthType,
  DeviceKind,
  AltBoot,
  Snippet,
  Subscription,
  SubscriptionInput,
  Wallet,
  WalletInput,
  WalletBalance,
  MetricSnapshot,
  AiAccess,
  AiAccessInput,
  AiAccessModel,
  AiCheck,
  AiKind,
  AiLimits,
  AiPayment,
  AiPrice,
  AiStatus,
  AiUsageDay,
  AiUsageSummary,
  PowerResult,
  PowerDiag,
  LiveMetrics,
  GpuInfo,
  MountInfo,
  ProcInfo,
  HardwareInfo,
  DiskInfo,
  ScreenPreflight
} from '../../main/types'
// Значение (не только тип): единый список валют для дропдаунов.
export { CURRENCY_CODES } from '../../main/types'
export type { ParsedHost } from '../../main/sshconfig'
export type { SftpEntry } from '../../main/sftp'
export type { ForwardInfo } from '../../main/forward'
export type { ListeningPort } from '../../main/ports'
