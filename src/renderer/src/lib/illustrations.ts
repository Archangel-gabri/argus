// Изо-портреты сущностей (REDESIGN-2026-07 §2.3). Роль → портрет; фолбэк — generic.
import master from '@/assets/illustrations/server-master.png'
import cascade from '@/assets/illustrations/server-cascade.png'
import exitNode from '@/assets/illustrations/server-exit.png'
import generic from '@/assets/illustrations/server-generic.png'

const BY_ROLE: Array<[RegExp, string]> = [
  [/master/i, master],
  [/cascade|relay/i, cascade],
  [/exit/i, exitNode]
]

export function deviceIllustration(role: string | null): string {
  if (role) {
    for (const [re, img] of BY_ROLE) if (re.test(role)) return img
  }
  return generic
}
