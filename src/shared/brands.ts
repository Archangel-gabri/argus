// Опознание компании по тому, что владелец написал сам.
//
// Одна карта на все четыре зоны — хостеров, банки, биржи, подписки. Раньше похожих карт было
// три (домены хостеров, домены ИИ-провайдеров, опознание банка по названию), они жили в разных
// файлах и разъезжались: имя, добавленное в одну, в остальных не появлялось, и логотип пропадал
// ровно там, где его ждали. Здесь ключ один, а зоны только подставляют своё поле.
//
// Опознаём по НАПИСАНИЮ, а не по отдельному полю: владелец заводит запись словами («Хетцнер»,
// «Т-Банк», «Spotify»), и требовать от него выбирать компанию из списка ради того, что уже
// написано в названии, значит выдумывать работу. Неопознанное имя остаётся без знака — это
// безопасный исход, в отличие от попытки угадать (эвристика «одно слово → домен .com» уже
// приводила к тому, что приложение само ходило в сеть за логотипом несуществующей компании).

/** Ключ каталога логотипов. Совпадает с ключами BRAND_MARKS и PROVIDER_MARKS. */
export type BrandKey = string

interface BrandMatch {
  key: BrandKey
  /** Что ищем в написании. Латиница и кириллица — оба алфавита сразу. */
  test: RegExp
}

// Порядок важен там, где одно написание вложено в другое (проверяется тестом). Правила
// намеренно узкие: лучше не показать знак, чем показать чужой — «Яндекс Плюс» это не облако.
const MATCHES: BrandMatch[] = [
  // Хостеры и облака
  // Только облако: «Яндекс Плюс» в подписках и «Яндекс Пэй» в счетах — другие компании внутри
  // одной, и знак облака на них был бы неправдой. Отдельного знака «Яндекс» в каталоге нет,
  // поэтому им честнее остаться без логотипа.
  { key: 'yandex-cloud', test: /yandex\s*cloud|яндекс\s*облако|yandexcloud/i },
  { key: 'google-cloud', test: /google cloud|gcp/i },
  { key: 'hetzner', test: /hetzner|хетцнер/i },
  { key: 'ovh', test: /\bovh/i },
  { key: 'digitalocean', test: /digital\s?ocean/i },
  { key: 'vultr', test: /vultr/i },
  { key: 'linode', test: /linode|akamai/i },
  { key: 'contabo', test: /contabo/i },
  { key: 'scaleway', test: /scaleway/i },
  { key: 'netcup', test: /netcup/i },
  { key: 'cloudflare', test: /cloudflare/i },

  // Банки, биржи, кошельки, сети
  { key: 'paypal', test: /paypal/i },
  { key: 'okx', test: /\bokx\b/i },
  { key: 'binance', test: /binance|бинанс/i },
  { key: 'coinbase', test: /coinbase/i },
  { key: 'ethereum', test: /ethereum|\beth\b/i },
  { key: 'bitcoin', test: /bitcoin|\bbtc\b/i },
  { key: 'tether', test: /tether|usdt/i },

  // Подписки и сервисы
  { key: 'spotify', test: /spotify|спотифай/i },
  { key: 'netflix', test: /netflix/i },
  { key: 'youtube', test: /youtube|ютуб/i },
  { key: 'github', test: /github/i },
  { key: 'telegram', test: /telegram|телеграм/i },
  { key: 'notion', test: /notion/i },
  { key: 'figma', test: /figma/i },
  { key: 'jetbrains', test: /jetbrains|rider|pycharm|webstorm|intellij/i },
  { key: 'namecheap', test: /namecheap/i },
  { key: 'boosty', test: /boosty|бусти/i },
  { key: 'steam', test: /steam/i },
  { key: 'vk', test: /\bvk\b|вконтакте/i },

  // ИИ — знаки лежат в assets/providers/marks.ts, ключи те же
  { key: 'anthropic', test: /anthropic|claude/i },
  { key: 'openai', test: /openai|chatgpt|codex/i },
  { key: 'gemini', test: /gemini|bard/i },
  { key: 'deepseek', test: /deepseek/i },
  { key: 'groq', test: /groq/i },
  { key: 'mistral', test: /mistral/i },
  { key: 'perplexity', test: /perplexity/i },
  { key: 'openrouter', test: /openrouter/i },
  { key: 'huggingface', test: /hugging\s?face/i },
  { key: 'ollama', test: /ollama/i },
  { key: 'cursor', test: /cursor/i },
  { key: 'xai', test: /\bxai\b|grok/i }
]

/**
 * Найти бренд по написанию. Принимает любые куски текста, которые есть у записи, — название,
 * учреждение, провайдера: чем больше сказано, тем выше шанс опознать. `null` — не опознали, и
 * это нормальный исход, а не ошибка.
 */
export function brandOf(...parts: Array<string | null | undefined>): BrandKey | null {
  const haystack = parts.filter(Boolean).join(' ')
  if (!haystack.trim()) return null
  return MATCHES.find((m) => m.test.test(haystack))?.key ?? null
}
