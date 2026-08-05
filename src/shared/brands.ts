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
  // Облако — отдельно от остального Яндекса: у него свой знак, и ставить его «Яндекс Плюсу»
  // было бы неправдой. Общий знак Яндекса теперь в каталоге есть (см. ниже), поэтому соседние
  // продукты получают ЕГО, а не облачный, — правило узкого написания решает, кто из двух.
  { key: 'yandex-cloud', test: /yandex\s*cloud|яндекс\s*облако|yandexcloud/i },
  { key: 'google-cloud', test: /google cloud|gcp/i },
  { key: 'aws', test: /\baws\b|amazon\s*web\s*services/i },
  { key: 'oracle', test: /oracle|оракл/i },
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
  { key: 'ozon', test: /\bozon\b|озон/i },
  { key: 'megafon', test: /megafon|мегафон/i },
  // Общий Яндекс идёт ПОСЛЕ облака: узкое написание должно побеждать, иначе «Яндекс Облако»
  // получит корпоративный знак вместо облачного. Порядок здесь проверяется тестом.
  { key: 'yandex', test: /yandex|яндекс/i },

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

/**
 * Буквы для записи без логотипа.
 *
 * Знак есть не у всех: у половины подписок и у российских банков свободного вектора не
 * существует вовсе. Ставить им одинаковый значок — значит вернуть тот же безликий список, из-за
 * которого логотипы и понадобились. Две буквы названия различают строки не хуже.
 *
 * Общие слова в начале пропускаются: «VPS Германия» и «VPS Финляндия» дали бы одинаковое «VP»,
 * а это ровно те две строки, которые владельцу и надо различать.
 */
const GENERIC = /^(vps|vds|сервер|облако|хостинг|подписка|тариф|счёт|счет|карта|банк|the)$/i

export function initialsOf(name: string): string {
  const words = (name.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !GENERIC.test(w))
  const first = words[0]
  if (!first) return '?'
  // По первой букве двух слов — только если второе слово тоже имя собственное («Deep Code» →
  // «DC»). Иначе берём две буквы первого: «Финляндия узел» дало бы «ФУ» — сочетание, которое
  // в списке читается совсем не как сокращение.
  const second = words[1]
  const compound = second && second[0] === second[0].toUpperCase() && second[0] !== second[0].toLowerCase()
  return (compound ? first[0] + second[0] : first.slice(0, 2)).toUpperCase()
}

/**
 * Сайт компании по её написанию.
 *
 * Нужен для значка: своего вектора у российских банков и части бирж нет, а взять ярлык у самого
 * сайта можно. Владелец при этом ничего не вводит — он уже написал «Bybit» в названии счёта, и
 * требовать после этого ещё и домен значит выдумывать работу.
 *
 * Список короткий намеренно: сюда попадает только то, что владелец действительно завёл. Гадать
 * домен из названия нельзя — «Ромашка» → romashka.com уводит запрос к посторонним людям.
 */
const SITES: Array<{ test: RegExp; domain: string }> = [
  { test: /т-?банк|тинькофф|tinkoff|tbank/i, domain: 'tbank.ru' },
  { test: /сбер|sberbank/i, domain: 'sberbank.ru' },
  { test: /альфа-?банк|alfabank/i, domain: 'alfabank.ru' },
  { test: /втб\b|vtb/i, domain: 'vtb.ru' },
  { test: /озон\s*банк|ozon\s*bank/i, domain: 'ozon.ru' },
  { test: /юmoney|юмани|yoomoney/i, domain: 'yoomoney.ru' },
  { test: /qiwi|киви/i, domain: 'qiwi.com' },
  { test: /bybit|байбит/i, domain: 'bybit.com' },
  { test: /kraken/i, domain: 'kraken.com' },
  { test: /bitget/i, domain: 'bitget.com' },
  { test: /gate\.io/i, domain: 'gate.io' },
  { test: /kucoin/i, domain: 'kucoin.com' },
  { test: /мтс\s*банк/i, domain: 'mtsbank.ru' },
  { test: /райффайзен|raiffeisen/i, domain: 'raiffeisen.ru' },
  { test: /газпромбанк|gazprombank/i, domain: 'gazprombank.ru' },
  { test: /wildberries|вайлдберриз/i, domain: 'wildberries.ru' },
  { test: /firstbyte/i, domain: 'firstbyte.ru' },
  { test: /extravm/i, domain: 'extravm.com' },
  { test: /flokinet/i, domain: 'flokinet.is' }
]

/** Домен компании, если он известен. `null` — не знаем, и гадать не будем. */
export function siteOf(...parts: Array<string | null | undefined>): string | null {
  const haystack = parts.filter(Boolean).join(' ')
  if (!haystack.trim()) return null
  return SITES.find((s) => s.test.test(haystack))?.domain ?? null
}
