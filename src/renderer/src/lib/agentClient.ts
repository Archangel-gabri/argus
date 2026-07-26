// Клиент собственного агента: принимает H.264 и рисует его через WebCodecs.
//
// Почему не <video>: обычный video-элемент требует контейнер (fMP4/HLS) и вносит буферизацию
// в сотни миллисекунд. VideoDecoder принимает голые кадры и отдаёт их сразу — задержка
// определяется сетью и кодировщиком, а не плеером.

export interface AgentHello {
  type: 'hello'
  version: string
  os: string
  encoder: string
  source: string
  width: number
  height: number
  fps: number
  codec: string
}

export interface AgentClientHandlers {
  onHello?: (h: AgentHello) => void
  onFrame?: () => void
  onError?: (message: string) => void
  onClose?: () => void
}

const BTN = { 0: 1, 1: 4, 2: 2 } as const // DOM button → маска агента (лево/средняя/право)

export class AgentClient {
  private ws: WebSocket | null = null
  private decoder: VideoDecoder | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private gotKey = false
  private ts = 0
  private closed = false
  private detach: Array<() => void> = []

  constructor(
    private url: string,
    private token: string,
    private canvas: HTMLCanvasElement,
    private h: AgentClientHandlers = {}
  ) {}

  connect(): void {
    if (typeof VideoDecoder === 'undefined') {
      this.h.onError?.('WebCodecs недоступен в этой сборке — агентский поток не декодировать')
      return
    }
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
    // Токен передаём подпротоколом, а НЕ строкой запроса: URL оседает в логах любого
    // промежуточного узла, и секрет из него утекает вместе с ними.
    const ws = new WebSocket(this.url, [`argus.token.${this.token}`])
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onmessage = (ev): void => {
      if (typeof ev.data === 'string') {
        this.onText(ev.data)
        return
      }
      this.onBinary(new Uint8Array(ev.data as ArrayBuffer))
    }
    ws.onerror = (): void => this.h.onError?.('не удалось соединиться с агентом')
    ws.onclose = (): void => {
      if (!this.closed) this.h.onClose?.()
    }
    ws.onopen = (): void => this.bindInput()
  }

  private onText(raw: string): void {
    let msg: { type?: string; error?: string; detail?: string; codec?: string }
    try {
      msg = JSON.parse(raw) as { type?: string; error?: string; detail?: string; codec?: string }
    } catch {
      return
    }
    if (msg.type === 'fatal') {
      this.h.onError?.(msg.detail ? `${msg.error}: ${msg.detail}` : msg.error || 'ошибка агента')
      return
    }
    if (msg.type === 'hello') {
      const hello = msg as unknown as AgentHello
      this.h.onHello?.(hello)
      this.setupDecoder(hello.codec || 'avc1.42E01F')
    }
  }

  private setupDecoder(codec: string): void {
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.draw(frame),
        error: (e) => this.h.onError?.(`декодер: ${e.message}`)
      })
      // optimizeForLatency: декодер не копит кадры «на всякий случай» — это и есть низкая задержка.
      this.decoder.configure({ codec, optimizeForLatency: true })
    } catch (e) {
      this.h.onError?.(`не удалось настроить декодер: ${(e as Error).message}`)
    }
  }

  private onBinary(buf: Uint8Array): void {
    if (!this.decoder || buf.length < 2) return
    const isKey = buf[0] === 1
    // До первого ключевого кадра декодировать нечего — иначе посыплются ошибки на весь лог.
    if (!this.gotKey && !isKey) return
    this.gotKey = true
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: (this.ts += 1000000 / 60),
          data: buf.subarray(1)
        })
      )
    } catch (e) {
      this.h.onError?.(`кадр не принят декодером: ${(e as Error).message}`)
    }
  }

  private draw(frame: VideoFrame): void {
    const c = this.canvas
    if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
      c.width = frame.displayWidth
      c.height = frame.displayHeight
    }
    this.ctx?.drawImage(frame, 0, 0)
    frame.close()
    this.h.onFrame?.()
  }

  // ── ввод ─────────────────────────────────────────────────────────────────────────────────────

  private send(o: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
  }

  /** Координаты нормализуем по видимому прямоугольнику холста: агент сам переведёт их в пиксели
   *  своего экрана, поэтому масштаб окна и letterbox прицел не сбивают. */
  private norm(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    return {
      x: r.width ? (e.clientX - r.left) / r.width : 0,
      y: r.height ? (e.clientY - r.top) / r.height : 0
    }
  }

  private bindInput(): void {
    const c = this.canvas
    const mouse = (e: MouseEvent): void => {
      const { x, y } = this.norm(e)
      this.send({ type: 'mouse', x, y, buttons: domButtons(e.buttons) })
    }
    const wheel = (e: WheelEvent): void => {
      e.preventDefault()
      this.send({ type: 'wheel', delta: e.deltaY > 0 ? -1 : 1 })
    }
    const key = (down: boolean) => (e: KeyboardEvent): void => {
      e.preventDefault()
      this.send({ type: 'key', code: e.code, down })
    }
    const ctxMenu = (e: Event): void => e.preventDefault() // правый клик должен уходить в ОС

    const kd = key(true)
    const ku = key(false)
    c.addEventListener('mousemove', mouse)
    c.addEventListener('mousedown', mouse)
    c.addEventListener('mouseup', mouse)
    c.addEventListener('wheel', wheel, { passive: false })
    c.addEventListener('contextmenu', ctxMenu)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)

    this.detach.push(() => {
      c.removeEventListener('mousemove', mouse)
      c.removeEventListener('mousedown', mouse)
      c.removeEventListener('mouseup', mouse)
      c.removeEventListener('wheel', wheel)
      c.removeEventListener('contextmenu', ctxMenu)
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
    })
  }

  /** Ctrl+Alt+Del: настоящую комбинацию перехватывает хост-ОС, поэтому только программно. */
  sendCtrlAltDel(): void {
    for (const code of ['ControlLeft', 'AltLeft', 'Delete']) this.send({ type: 'key', code, down: true })
    for (const code of ['Delete', 'AltLeft', 'ControlLeft']) this.send({ type: 'key', code, down: false })
  }

  close(): void {
    this.closed = true
    this.detach.forEach((f) => f())
    this.detach = []
    try {
      this.decoder?.close()
    } catch {
      /* уже закрыт */
    }
    this.decoder = null
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}

/** DOM MouseEvent.buttons (бит 1 — правая, бит 2 — средняя) → маска агента. */
function domButtons(b: number): number {
  let out = 0
  if (b & 1) out |= BTN[0]
  if (b & 2) out |= BTN[2]
  if (b & 4) out |= BTN[1]
  return out
}
