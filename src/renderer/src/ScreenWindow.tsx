// Окно «экран ПК» — самостоятельный плеер RDP-сеанса. Отдельное окно выбрано осознанно:
// «свернуть»/«закрыть»/«во весь экран» становятся РОДНЫМИ действиями ОС, экран перестаёт быть
// заложником модального drawer'а (можно смотреть на ПК и параллельно работать в Argus), а
// разрешение сеанса едет за размером окна через display-update, а не растягивается в мыло.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Maximize2, Minimize2, Minus, X, KeyRound, RefreshCw, AlertTriangle } from 'lucide-react'
import Guacamole from 'guacamole-common-js'
import { cn } from '@/lib/cn'
import { guacErr, isAuthFailure, type GuacStatus } from '@/lib/guac'
import { AgentClient } from '@/lib/agentClient'

const api = typeof window !== 'undefined' ? window.api : undefined

type Phase = 'claiming' | 'connecting' | 'connected' | 'reconnecting' | 'error'

const MAX_RETRIES = 4
const TOOLBAR_REVEAL_PX = 64

// X11 keysym'ы для Ctrl+Alt+Del: настоящую комбинацию перехватывает хост-ОС, поэтому только кнопкой.
const KEY_CTRL_L = 0xffe3
const KEY_ALT_L = 0xffe9
const KEY_DELETE = 0xffff

function ToolbarButton({
  onClick,
  title,
  children
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      // tabIndex -1: фокус не должен уходить с экрана — иначе Tab перестанет попадать в Windows.
      tabIndex={-1}
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded-md p-1.5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
    >
      {children}
    </button>
  )
}

export function ScreenWindow({ handle }: { handle: string }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('claiming')
  const [err, setErr] = useState<string | null>(null)
  const [fs, setFs] = useState(false)
  const [nearTop, setNearTop] = useState(false)

  // mountRef — ЛИСТ: React никогда не рендерит сюда детей, canvas монтируется руками.
  // (Смешивать одно с другим нельзя: React потом падает на removeChild отсутствующего узла.)
  const mountRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kbRef = useRef<any>(null)
  const scaleRef = useRef(1)
  const sessionRef = useRef<{ mode: 'agent' | 'rdp'; wsPort: number; token: string; url?: string } | null>(null)
  const agentRef = useRef<AgentClient | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const attemptRef = useRef(0)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Поколение соединения. teardown его увеличивает — и все обработчики прошлого клиента
  // (включая state 5 от нашего же disconnect) становятся немыми. Иначе умирающее соединение
  // перебивает настоящую ошибку общим «соединение разорвано» и запускает лишний реконнект.
  const genRef = useRef(0)
  const lastClipRef = useRef('')

  const viewport = (): { w: number; h: number } => ({
    w: Math.max(640, Math.round(window.innerWidth)),
    h: Math.max(400, Math.round(window.innerHeight))
  })

  const teardown = useCallback((): void => {
    genRef.current += 1
    agentRef.current?.close()
    agentRef.current = null
    if (retryRef.current) {
      clearTimeout(retryRef.current)
      retryRef.current = null
    }
    try {
      kbRef.current?.reset?.()
      clientRef.current?.disconnect?.()
    } catch {
      /* ignore */
    }
    clientRef.current = null
    kbRef.current = null
    scaleRef.current = 1
    mountRef.current?.replaceChildren()
  }, [])

  /** Отправить локальный буфер в сеанс (зовём по фокусу окна — событий смены буфера в ОС нет). */
  const pushClipboard = useCallback(async (): Promise<void> => {
    const client = clientRef.current
    if (!api || !client) return
    const text = await api.clip.read()
    if (!text || text === lastClipRef.current) return
    lastClipRef.current = text
    try {
      const stream = client.createClipboardStream('text/plain')
      const writer = new Guacamole.StringWriter(stream)
      writer.sendText(text)
      writer.sendEnd()
    } catch {
      /* ignore */
    }
  }, [])

  /** Путь через собственный агент: H.264 напрямую в WebCodecs, без пароля учётной записи ОС. */
  const connectAgent = useCallback((): void => {
    const s = sessionRef.current
    const mount = mountRef.current
    if (!s || !s.url || !mount) return
    teardown()
    const gen = genRef.current
    setPhase((p) => (p === 'reconnecting' ? p : 'connecting'))

    const canvas = document.createElement('canvas')
    canvas.className = 'h-full w-full object-contain'
    canvas.tabIndex = 0
    mount.replaceChildren(canvas)

    const client = new AgentClient(s.url, s.token, canvas, {
      onHello: (h) => {
        if (genRef.current !== gen) return
        attemptRef.current = 0
        setErr(null)
        setPhase('connected')
        setInfo(`агент ${h.version} · ${h.source}/${h.encoder} · ${h.fps} к/с`)
        canvas.focus()
      },
      onError: (m) => {
        if (genRef.current !== gen) return
        teardown()
        setErr(m)
        setPhase('error')
      },
      onClose: () => {
        if (genRef.current !== gen) return
        dropRetry('соединение с агентом разорвано', () => connectAgent())
      }
    })
    agentRef.current = client
    client.connect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teardown])

  /** Общая политика повторов: обрыв — переподключаемся, отказ авторизации — нет. */
  const dropRetry = useCallback(
    (msg: string, again: () => void): void => {
      teardown()
      if (attemptRef.current >= MAX_RETRIES) {
        setErr(msg)
        setPhase('error')
        return
      }
      attemptRef.current += 1
      const delay = Math.min(8000, 1000 * 2 ** (attemptRef.current - 1))
      setErr(`${msg} Переподключаюсь (попытка ${attemptRef.current} из ${MAX_RETRIES})…`)
      setPhase('reconnecting')
      retryRef.current = setTimeout(again, delay)
    },
    [teardown]
  )

  const connect = useCallback((): void => {
    const s = sessionRef.current
    const mount = mountRef.current
    if (!s || !mount) return
    if (s.mode === 'agent') {
      connectAgent()
      return
    }
    teardown()
    const gen = genRef.current // всё ниже принадлежит ЭТОМУ поколению соединения
    setErr(null)
    setPhase((p) => (p === 'reconnecting' ? p : 'connecting'))

    const tunnel = new Guacamole.WebSocketTunnel(`ws://127.0.0.1:${s.wsPort}/`)
    const client = new Guacamole.Client(tunnel)
    clientRef.current = client
    const disp = client.getDisplay()
    mount.replaceChildren(disp.getElement())

    const drop = (status?: GuacStatus): void => {
      if (genRef.current !== gen) return // соединение уже похоронено — молчим
      const msg = guacErr(status)
      teardown()
      // При неверном пароле переподключаться бессмысленно и вредно — просто показываем ошибку.
      if (isAuthFailure(status) || attemptRef.current >= MAX_RETRIES) {
        setErr(msg)
        setPhase('error')
        return
      }
      attemptRef.current += 1
      const delay = Math.min(8000, 1000 * 2 ** (attemptRef.current - 1))
      setErr(`${msg} Переподключаюсь (попытка ${attemptRef.current} из ${MAX_RETRIES})…`)
      setPhase('reconnecting')
      retryRef.current = setTimeout(connect, delay)
    }

    // Client не пробрасывает ошибки туннеля наружу — вешаем сами, иначе обрыв WS = вечный спиннер.
    tunnel.onerror = drop
    client.onerror = drop
    client.onstatechange = (st: number): void => {
      if (genRef.current !== gen) return
      if (st === 3) {
        attemptRef.current = 0
        setErr(null)
        setPhase('connected')
        const { w, h } = viewport()
        try {
          client.sendSize(w, h) // разрешение сеанса = размер окна → картинка 1:1, без мыла
          disp.scale(1)
        } catch {
          /* ignore */
        }
        scaleRef.current = 1
        void pushClipboard()
      }
      if (st === 5) drop({ message: 'соединение разорвано' })
    }

    // Буфер обмена с ПК → в системный буфер ноута (через main: navigator.clipboard в Electron
    // требует фокуса и жеста, а вставка с той стороны прилетает асинхронно).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.onclipboard = (stream: any, mimetype: string): void => {
      if (!mimetype.startsWith('text/')) return
      const reader = new Guacamole.StringReader(stream)
      let data = ''
      reader.ontext = (t: string): void => {
        data += t
      }
      reader.onend = (): void => {
        if (!data || genRef.current !== gen) return
        lastClipRef.current = data
        api?.clip.write(data)
      }
    }

    client.connect(`token=${encodeURIComponent(s.token)}`)
    void gen

    // Мышь по элементу дисплея; координаты в CSS-пикселях, про scale() библиотека не знает.
    const mouse = new Guacamole.Mouse(disp.getElement())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (state: any): void => {
      const k = scaleRef.current || 1
      client.sendMouseState({ ...state, x: state.x / k, y: state.y / k })
    }
    mouse.onmousedown = send
    mouse.onmouseup = send
    mouse.onmousemove = send

    // Клавиатура — на document: окно целиком принадлежит сеансу, ловим всё независимо от фокуса.
    const keyboard = new Guacamole.Keyboard(document)
    keyboard.onkeydown = (sym: number): void => client.sendKeyEvent(1, sym)
    keyboard.onkeyup = (sym: number): void => client.sendKeyEvent(0, sym)
    kbRef.current = keyboard
  }, [teardown, pushClipboard])

  // Забрать параметры сеанса у main и подключиться.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!api) {
        setErr('мост в основной процесс недоступен — окно открыто не из Argus')
        setPhase('error')
        return
      }
      if (!handle) {
        setErr('окно открыто без идентификатора сеанса')
        setPhase('error')
        return
      }
      const r = await api.screen.claim(handle)
      if (cancelled) return
      if (!r.ok || !r.token) {
        setErr(r.error ?? 'не удалось получить сеанс')
        setPhase('error')
        return
      }
      sessionRef.current = {
        mode: r.mode ?? 'rdp',
        wsPort: r.wsPort ?? 0,
        token: r.token,
        url: r.url
      }
      connect()
    })()
    return () => {
      cancelled = true
      teardown()
    }
  }, [handle, connect, teardown])

  // Ресайз окна → новое разрешение RDP (display-update включён на стороне сеанса).
  // Заодно пересинхронизируем флаг полноэкранного: его могли снять жестом оконного менеджера.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        void api?.win.isFullScreen().then(setFs)
        const client = clientRef.current
        if (!client) return
        const { w, h } = viewport()
        try {
          client.sendSize(w, h)
          client.getDisplay().scale(1)
          scaleRef.current = 1
        } catch {
          /* ignore */
        }
      }, 200)
    }
    window.addEventListener('resize', onResize)
    void api?.win.isFullScreen().then(setFs)
    return () => {
      if (t) clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Локальный буфер уезжает в сеанс по возврату фокуса в окно.
  useEffect(() => {
    const onFocus = (): void => void pushClipboard()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [pushClipboard])

  // В полноэкранном тулбар прячется и проявляется у верхней кромки, иначе перекрывает экран ПК.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => setNearTop(e.clientY <= TOOLBAR_REVEAL_PX)
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  const toggleFullScreen = async (): Promise<void> => {
    if (!api) return
    setFs(await api.win.setFullScreen(!fs))
  }

  const sendCtrlAltDel = (): void => {
    if (agentRef.current) {
      agentRef.current.sendCtrlAltDel()
      return
    }
    const client = clientRef.current
    if (!client) return
    for (const k of [KEY_CTRL_L, KEY_ALT_L, KEY_DELETE]) client.sendKeyEvent(1, k)
    for (const k of [KEY_DELETE, KEY_ALT_L, KEY_CTRL_L]) client.sendKeyEvent(0, k)
  }

  const retryNow = (): void => {
    attemptRef.current = 0
    connect()
  }

  const busy = phase === 'claiming' || phase === 'connecting' || phase === 'reconnecting'
  const toolbarShown = !fs || nearTop

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg">
      {/* Лист под canvas guacamole — React сюда детей не рендерит. */}
      <div ref={mountRef} className="absolute inset-0 flex items-center justify-center" />

      {/* Плавающий тулбар: в обычном режиме виден всегда, в полноэкранном — у верхней кромки. */}
      <div
        className={cn(
          'absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border/80 bg-surface/95 px-2 py-1.5 shadow-2xl backdrop-blur transition-all',
          toolbarShown ? 'opacity-100' : 'pointer-events-none -translate-y-16 opacity-0'
        )}
      >
        {info && (
          <span className="mr-1 max-w-[280px] truncate pl-1 text-[11px] text-slate-500" title={info}>
            {info}
          </span>
        )}
        <ToolbarButton onClick={() => void toggleFullScreen()} title={fs ? 'Из полноэкранного' : 'Во весь экран'}>
          {fs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </ToolbarButton>
        <ToolbarButton onClick={() => api?.win.minimize()} title="Свернуть в панель задач">
          <Minus className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton onClick={sendCtrlAltDel} title="Отправить Ctrl+Alt+Del">
          <KeyRound className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton onClick={retryNow} title="Переподключить">
          <RefreshCw className="h-4 w-4" />
        </ToolbarButton>
        <div className="mx-0.5 h-5 w-px bg-border" />
        <button
          tabIndex={-1}
          onClick={() => api?.win.close()}
          title="Завершить сеанс и закрыть окно"
          aria-label="Завершить сеанс и закрыть окно"
          className="rounded-md p-1.5 text-rose-300 transition-colors hover:bg-rose-500/15 hover:text-rose-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Состояние поверх экрана: подключение, переподключение, ошибка. */}
      {phase !== 'connected' && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg/80 px-8 text-center">
          {busy ? (
            <>
              <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
              <span className="text-sm text-slate-400">
                {phase === 'reconnecting' ? 'Переподключаюсь…' : 'Подключаюсь к экрану…'}
              </span>
            </>
          ) : (
            <AlertTriangle className="h-8 w-8 text-rose-400" />
          )}
          {err && <span className="max-w-lg text-xs leading-relaxed text-rose-300">{err}</span>}
          {phase === 'error' && (
            <button
              tabIndex={-1}
              onClick={retryNow}
              className="pointer-events-auto mt-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-bold text-bg hover:bg-accent-hover"
            >
              Попробовать снова
            </button>
          )}
        </div>
      )}
    </div>
  )
}
