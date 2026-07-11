// Изо-портреты сущностей (REDESIGN-2026-07 §2.3). kind → портрет; серверы — по роли.
import master from '@/assets/illustrations/server-master.png'
import cascade from '@/assets/illustrations/server-cascade.png'
import exitNode from '@/assets/illustrations/server-exit.png'
import generic from '@/assets/illustrations/server-generic.png'
import pc from '@/assets/illustrations/device-pc.png'
import phone from '@/assets/illustrations/device-phone.png'
import watch from '@/assets/illustrations/device-watch.png'
import buds from '@/assets/illustrations/device-buds.png'
import router from '@/assets/illustrations/device-router.png'
import type { DeviceKind } from '@/types'

const BY_ROLE: Array<[RegExp, string]> = [
  [/master/i, master],
  [/cascade|relay/i, cascade],
  [/exit/i, exitNode]
]

const BY_KIND: Partial<Record<DeviceKind, string>> = {
  pc,
  phone,
  watch,
  buds,
  router
}

export function deviceIllustration(kind: DeviceKind, role: string | null): string {
  if (kind !== 'server') return BY_KIND[kind] ?? generic
  if (role) {
    for (const [re, img] of BY_ROLE) if (re.test(role)) return img
  }
  return generic
}
