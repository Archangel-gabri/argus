// Bundled hoster logos (downloaded once at build time → no third-party calls at runtime).
// Unknown providers fall back to the coloured monogram in ServerCard.
import hetzner from '@/assets/logos/hetzner.png'
import yandex from '@/assets/logos/yandex.png'
import flokinet from '@/assets/logos/flokinet.png'
import extravm from '@/assets/logos/extravm.png'
import ovh from '@/assets/logos/ovh.png'

export const PROVIDER_LOGO: Record<string, string> = {
  Hetzner: hetzner,
  'Yandex Cloud': yandex,
  FlokiNET: flokinet,
  ExtraVM: extravm,
  OVH: ovh
}

export const providerLogo = (p: string): string | undefined => PROVIDER_LOGO[p]
