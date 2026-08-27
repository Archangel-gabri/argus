import type { Status } from '../types'

export interface SnapshotInput {
  cpu?: number
  ramUsed?: number
  ramTotal?: number
  disk?: number
  status?: string
}

export const METRIC_SNAPSHOT_INSERT =
  'INSERT INTO metric_snapshots (device_id, ts, cpu, ram_used, ram_total, disk, status) VALUES (?, ?, ?, ?, ?, ?, ?)'

/** Единый порядок bind-параметров: disk нельзя снова потерять между probe и SQLite. */
export function snapshotValues(
  deviceId: string,
  ts: number,
  m: SnapshotInput
): [string, number, number | null, number | null, number | null, number | null, string] {
  return [
    deviceId,
    ts,
    m.cpu ?? null,
    m.ramUsed ?? null,
    m.ramTotal ?? null,
    m.disk ?? null,
    m.status ?? 'unknown'
  ]
}

// PC пишет семейство ОС в историю; renderer-статус остаётся отдельным и трёхзначным.
export function snapshotStatus(status: string): Status | null {
  if (status === 'off') return 'offline'
  if (status === 'windows' || status === 'linux') return 'online'
  return status ? (status as Status) : null
}
