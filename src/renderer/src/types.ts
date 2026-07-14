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
  AiAccount,
  AiAccountInput,
  AiCheck
} from '../../main/types'
export type { ParsedHost } from '../../main/sshconfig'
export type { SftpEntry } from '../../main/sftp'
export type { ForwardInfo } from '../../main/forward'
