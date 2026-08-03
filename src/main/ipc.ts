import { ipcMain, safeStorage, BrowserWindow, clipboard, dialog } from 'electron'
import { promises as fsp } from 'node:fs'
import * as vault from './vault'
import * as ssh from './ssh'
import * as sftp from './sftp'
import * as forward from './forward'
import { parseSshConfig, type ParsedHost } from './sshconfig'
import { discoverTailscale } from './discovery'
import { walletBalance } from './onchain'
import { checkAccount } from './ai'
import * as aiPrices from './ai-prices'
import { seedPricesIfEmpty } from './ai-prices'
import { seedAiAccess } from './ai-seed'
import { collectUsage } from './ai-usage'
import { parseDevice as ollamaParseDevice } from './ollama'
import * as pc from './pc'
import * as ports from './ports'
import * as watchdog from './watchdog'
import * as hardware from './hardware'
import * as screen from './screen'
import * as agent from './agent'
import { ipLookup } from './net'
import { fleetReach } from './liveness'
import { lockApplication } from './lockdown'
import type { DeviceInput, VaultState, AiAccessInput, AiAccessModel, PowerResult } from './types'
import { resolvePowerAction, describeRejectedAction } from './power-action'
import { disposeDevice } from './device-disposal'
import { revokePendingAccess } from './access-epoch'

import { trackedReach } from './reach-memory'
import { masterPasswordPolicyError } from '../shared/password-strength'
import { parseSubscriptionInput, parseWalletInput } from './finance-validation'

/** Inspect the OS keyring backend (Linux: kwallet/gnome-keyring/basic_text). */
function keyringInfo(): { backend: string; canRemember: boolean } {
  let backend = 'unknown'
  try {
    if (process.platform === 'linux' && 'getSelectedStorageBackend' in safeStorage) {
      backend = safeStorage.getSelectedStorageBackend()
    } else {
      backend = safeStorage.isEncryptionAvailable() ? 'os-keychain' : 'unavailable'
    }
  } catch {
    backend = 'unknown'
  }
  // basic_text = Electron's plaintext fallback (e.g. on bare Hyprland/Sway) — never trust it.
  return { backend, canRemember: backend !== 'basic_text' && backend !== 'unavailable' }
}

function state(): VaultState {
  const { backend, canRemember } = keyringInfo()
  return { status: vault.vaultStatus(), keyringBackend: backend, canRemember }
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Сколько раз подряд не удалось опросить устройство. Один промах ещё ничего не значит. */

/**
 * Что делается сразу после открытия хранилища.
 *
 * Каталог цен и реестр доступов нужны экрану AI с первой секунды, а собрать их можно только на
 * открытой базе. Обе операции срабатывают ровно один раз (при пустых таблицах) и молчат дальше.
 * Ошибка здесь не должна мешать войти в приложение: без цен показываются токены без денег.
 */
function afterUnlock(): void {
  try {
    seedPricesIfEmpty()
    seedAiAccess()
  } catch {
    /* каталог или файл засева испорчены — приложение работает и без них */
  }
}

export function registerIpc(): void {
  ipcMain.handle('vault:state', () => state())

  ipcMain.handle('vault:initialize', async (_e, password: unknown) => {
    try {
      const value = asString(password)
      const policyError = await masterPasswordPolicyError(value)
      if (policyError) return { ok: false, error: policyError, state: state() }
      await vault.initialize(value)
      afterUnlock()
      return { ok: true, state: state() }
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: state() }
    }
  })

  ipcMain.handle('vault:unlock', async (_e, password: unknown) => {
    try {
      await vault.unlock(asString(password))
      afterUnlock()
      return { ok: true, state: state() }
    } catch (err) {
      return { ok: false, error: (err as Error).message, state: state() }
    }
  })

  ipcMain.handle('vault:lock', () => {
    lockApplication()
    return state()
  })

  ipcMain.handle('vault:changePassword', async (_e, current: unknown, next: unknown) => {
    try {
      const nextValue = asString(next)
      const policyError = await masterPasswordPolicyError(nextValue)
      if (policyError) return { ok: false, error: policyError }
      await vault.changePassword(asString(current), nextValue)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Быстрая живость по всему парку: TCP-коннект вместо полного SSH-опроса (мс вместо секунд).
  // Зовётся сразу после входа, чтобы точки «онлайн» загорались мгновенно, а не через минуту.
  ipcMain.handle('devices:liveness', async () => (vault.isUnlocked() ? fleetReach() : {}))

  // Своя картинка устройства. Храним data-URL прямо в записи: файлов на диске не плодим,
  // портрет уезжает вместе с устройством при экспорте, а CSP уже разрешает data:.
  ipcMain.handle('devices:pickIcon', async (e) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Картинка устройства',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }]
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return { ok: false, error: 'отменено' }
    const file = res.filePaths[0]
    try {
      const buf = await fsp.readFile(file)
      // 3 МБ — предел здравого смысла для портрета: больше в базе держать незачем.
      if (buf.byteLength > 3 * 1024 * 1024)
        return { ok: false, error: 'файл больше 3 МБ — возьми картинку полегче' }
      const ext = (file.split('.').pop() || 'png').toLowerCase()
      const mime =
        ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('devices:list', () => {
    if (!vault.isUnlocked()) return []
    // Никаких сетевых действий при простом открытии парка. Публичный IP — часть приватной
    // топологии; во внешний geo-сервис он уходит только после явной кнопки пользователя.
    return vault.listDevices()
  })

  ipcMain.handle('devices:create', (_e, input: DeviceInput) => {
    try {
      const device = vault.createDevice(input)
      return { ok: true, device }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('devices:update', (_e, id: unknown, input: DeviceInput) => {
    try {
      const device = vault.updateDevice(asString(id), input)
      return { ok: true, device }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('devices:delete', async (_e, id: unknown, opts: unknown) => {
    try {
      const deviceId = asString(id)
      const force = !!(opts && typeof opts === 'object' && (opts as { force?: unknown }).force)

      // Двигаем поколение доступа ПЕРВЫМ действием. Операции, начатые до удаления, проверяют
      // билет перед регистрацией ресурса (forward.ts, ssh.ts, sftp.ts) — иначе проброс порта,
      // открывшийся сразу после удаления записи, становился невидимым и незакрываемым:
      // устройства уже нет, а localhost-слушатель живёт до перезапуска приложения.
      revokePendingAccess()

      // Установленный агент отзываем ДО удаления записи — иначе отзывать станет нечем.
      //
      // Агент это служба с автозапуском, которая слушает порт, отдаёт экран и ПРИНИМАЕТ ВВОД.
      // Раньше удаление устройства гасило только эфемерные ресурсы, а строка с токеном и
      // сертификатом исчезала вместе с SSH-доступом: на машине оставалась работающая служба,
      // снять которую из приложения было уже невозможно — только руками на самой машине.
      //
      // Отказ при этом НЕ блокирует удаление навсегда: машина может быть просто выключена, и
      // запретить удаление значило бы запереть человека. Поэтому первая попытка возвращает
      // отказ с признаком `canForce`, а решение — повторить или удалить с остатком — принимает
      // владелец, зная цену.
      if (!force && vault.getAgentToken(deviceId)) {
        const revoked = await agent.forgetAgent(deviceId)
        if (!revoked.ok)
          return {
            ok: false,
            canForce: true,
            error:
              `агент на машине не отозван: ${revoked.error ?? 'причина неизвестна'}. ` +
              'Если удалить сейчас, служба останется работать, и снять её можно будет только вручную.'
          }
      }
      // Отзываем ВСЕ живые возможности устройства до того, как запись исчезнет. Раньше здесь
      // гасились только проброс-туннели, а терминал, файловая сессия и трансляция продолжали
      // работать по уже открытым соединениям: устройства в списке нет, а доступ к машине есть,
      // и закрыть его нечем — закрывать не по чему.
      disposeDevice(deviceId, {
        closeShells: ssh.closeDevice,
        closeSftp: sftp.sftpCloseDevice,
        closeScreens: screen.closeDeviceScreens,
        closeForwards: (dev) => {
          const live = forward.listForwards(dev)
          for (const fwd of live) forward.closeForward(fwd.id)
          return live.length
        }
      })
      const removed = vault.deleteDevice(deviceId)
      return removed ? { ok: true } : { ok: false, error: 'Устройство не найдено' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // SSH terminal — creds are read from the vault inside ssh.* and never leave main.
  ipcMain.handle('ssh:open', (e, deviceId: unknown, cols: unknown, rows: unknown) =>
    ssh.openShell(e.sender, asString(deviceId), Number(cols) || 80, Number(rows) || 24)
  )
  ipcMain.on('ssh:input', (_e, sessionId: unknown, data: unknown) =>
    ssh.writeShell(asString(sessionId), asString(data))
  )
  ipcMain.on('ssh:resize', (_e, sessionId: unknown, cols: unknown, rows: unknown) =>
    ssh.resizeShell(asString(sessionId), Number(cols) || 80, Number(rows) || 24)
  )
  ipcMain.on('ssh:close', (_e, sessionId: unknown) => ssh.closeShell(asString(sessionId)))
  ipcMain.on('ssh:attach', (_e, sessionId: unknown) => ssh.attachShell(asString(sessionId)))
  ipcMain.handle('ssh:probe', async (_e, deviceId: unknown) => {
    const id = asString(deviceId)
    const r = await ssh.probe(id)
    // Успех — пишем полный снапшот. Провал — пишем ТОЛЬКО статус, без cpu/ram: график истории
    // получает честный пропуск (не ровные 0%), а кэш последнего состояния перестаёт врать.
    // Раньше провалы не писались вовсе, и выключенный сервер после перезагрузки списка
    // воскресал как «online» из устаревшего снимка.
    //
    // Но ОДНА осечка — это ещё не «выключен». Замерено на живом парке: канал до нод флапает
    // так, что на одном проходе падает одна нода, а через пять секунд она отвечает и падает
    // другая. Отметить такую машину выключенной означает соврать. Первый промах = «не знаю»
    // (снимок не трогаем, старый остаётся), выключенной считаем со второго подряд.
    // Тот же принцип уже работает у быстрой проверки живости — здесь он просто был не доделан.
    const status = trackedReach('probe', id, r.ok ? 'online' : 'offline')
    if (status === 'online') {
      if (vault.isUnlocked()) vault.recordSnapshot(id, r)
      return { ...r, status }
    }
    if (status === 'offline') {
      if (vault.isUnlocked()) vault.recordSnapshot(id, { status: 'offline' })
    }
    return { ...r, status }
  })
  ipcMain.handle('metrics:history', (_e, deviceId: unknown, limit: unknown) =>
    vault.isUnlocked() ? vault.getSnapshots(asString(deviceId), Number(limit) || 30) : []
  )
  // Полный live-снимок для вкладки «Метрики» (per-core/сеть/диск/темпы/GPU/топ). НЕ пишет
  // снапшот в историю (иначе 3-сек поллинг выест retention) — история копится ssh:probe/pc:metrics.
  ipcMain.handle('metrics:live', async (_e, deviceId: unknown) => {
    const id = asString(deviceId)
    const dev = vault.isUnlocked() ? vault.listDevices().find((d) => d.id === id) : undefined
    // Windows без второй ОС тоже обслуживается OS-aware веткой (см. store/devices.ts).
    if (dev && (dev.altOs.length > 0 || /win/i.test(dev.os))) {
      const r = await pc.metrics(id)
      if (r.metrics)
        return { ok: true, state: 'live' as const, family: r.family, os: r.current, metrics: r.metrics }
      return {
        ok: false,
        state: r.family === 'off' ? ('unreachable' as const) : ('unavailable' as const),
        family: r.family,
        os: r.current,
        metrics: null
      }
    }
    const r = await ssh.probe(id)
    return {
      ok: r.ok && Boolean(r.metrics),
      state: r.metrics ? ('live' as const) : r.ok ? ('unavailable' as const) : ('unreachable' as const),
      family: 'linux' as const,
      os: '',
      metrics: r.metrics ?? null
    }
  })
  ipcMain.handle('ssh:probeHost', (_e, opts: unknown) => {
    const o = (opts ?? {}) as Record<string, unknown>
    return ssh.probeHost({
      host: asString(o.host),
      port: Number(o.port) || 22,
      user: asString(o.user),
      password: asString(o.password),
      privateKey: asString(o.privateKey) || undefined,
      passphrase: asString(o.passphrase) || undefined
    })
  })
  ipcMain.handle('ssh:exec', (_e, deviceId: unknown, command: unknown) =>
    ssh.execOnce(asString(deviceId), asString(command))
  )
  // TOFU recovery: forget a pinned host key so the next connect re-pins it ("trust new key").
  ipcMain.handle('ssh:forgetHostKey', (_e, host: unknown, port: unknown) => {
    if (vault.isUnlocked()) vault.forgetHostKey(asString(host), Number(port) || 22)
    return { ok: true }
  })
  // То же самое, но адрес берётся у самого подключения — важно для многозагрузочных машин,
  // где живая ОС может сидеть на другом адресе и порту.
  ipcMain.handle('ssh:trustDeviceKey', (_e, deviceId: unknown) =>
    vault.isUnlocked()
      ? ssh.forgetDeviceHostKey(asString(deviceId))
      : Promise.resolve({ ok: false, error: 'хранилище закрыто' })
  )

  // Snippets (saved commands) — stored in the encrypted vault
  ipcMain.handle('snippets:list', () => (vault.isUnlocked() ? vault.listSnippets() : []))
  ipcMain.handle('snippets:create', (_e, name: unknown, command: unknown) =>
    vault.createSnippet(asString(name), asString(command))
  )
  ipcMain.handle('snippets:delete', (_e, id: unknown) => {
    vault.deleteSnippet(asString(id))
    return { ok: true }
  })

  // Subscriptions — stored in the encrypted vault
  ipcMain.handle('subs:list', () => (vault.isUnlocked() ? vault.listSubscriptions() : []))
  ipcMain.handle('subs:create', (_e, input: unknown) => vault.createSubscription(parseSubscriptionInput(input)))
  ipcMain.handle('subs:update', (_e, id: unknown, input: unknown) =>
    vault.updateSubscription(asString(id), parseSubscriptionInput(input))
  )
  ipcMain.handle('subs:delete', (_e, id: unknown) => {
    const removed = vault.deleteSubscription(asString(id))
    return removed ? { ok: true } : { ok: false, error: 'Подписка не найдена' }
  })

  // Crypto wallets — addresses in the vault, balances from public keyless endpoints
  ipcMain.handle('wallets:list', () => (vault.isUnlocked() ? vault.listWallets() : []))
  ipcMain.handle('wallets:create', (_e, input: unknown) => vault.createWallet(parseWalletInput(input)))
  ipcMain.handle('wallets:update', (_e, id: unknown, input: unknown) =>
    vault.updateWallet(asString(id), parseWalletInput(input))
  )
  ipcMain.handle('wallets:delete', (_e, id: unknown) => {
    const removed = vault.deleteWallet(asString(id))
    return removed ? { ok: true } : { ok: false, error: 'Кошелёк не найден' }
  })
  ipcMain.handle('wallets:balance', (_e, chain: unknown, address: unknown) => {
    const wallet = parseWalletInput({ chain, address })
    return walletBalance(wallet.chain, wallet.address)
  })

  // AI-доступы — ключи остаются в вольте; наружу идут только вердикты и обезличенные DTO
  ipcMain.handle('ai:list', () => (vault.isUnlocked() ? vault.listAiAccess() : []))
  ipcMain.handle('ai:create', (_e, input: unknown) => vault.createAiAccess(input as AiAccessInput))
  ipcMain.handle('ai:update', (_e, id: unknown, input: unknown) =>
    vault.updateAiAccess(asString(id), input as AiAccessInput)
  )
  ipcMain.handle('ai:delete', (_e, id: unknown) => {
    vault.deleteAiAccess(asString(id))
    return { ok: true }
  })
  ipcMain.handle('ai:check', async (_e, id: unknown) => {
    const accessId = asString(id)
    const acc = vault.listAiAccess().find((a) => a.id === accessId)
    const verdict = await checkAccount(acc?.provider ?? '', vault.getAiKey(accessId) ?? '')
    // Вердикт сохраняется, чтобы его увидел сторож (он сам в сеть не ходит) и чтобы на карточке
    // было видно, когда ключ последний раз отвечал.
    if (acc) vault.recordAiCheck(accessId, verdict)
    return verdict
  })
  ipcMain.handle('ai:checks', () => (vault.isUnlocked() ? vault.listAiChecks() : []))

  // Каталог цен: список для экрана, засев вшитого снапшота и живое обновление у OpenRouter.
  ipcMain.handle('ai:prices', (_e, provider: unknown) =>
    vault.isUnlocked() ? vault.listAiPrices(provider ? asString(provider) : undefined) : []
  )
  ipcMain.handle('ai:priceCount', () => (vault.isUnlocked() ? vault.aiPriceCount() : 0))
  ipcMain.handle('ai:refreshPrices', async (_e, accessId: unknown) => {
    if (!vault.isUnlocked()) return { ok: false, count: 0, error: 'Хранилище заперто' }
    // Ключ берётся в main и наружу не выходит: renderer передаёт только идентификатор доступа.
    const key = accessId ? vault.getAiKey(asString(accessId)) : null
    const seeded = aiPrices.reseedPrices()
    const live = await aiPrices.refreshOpenRouterPrices(key)
    return { ok: live.ok || seeded > 0, count: seeded + live.count, error: live.ok ? undefined : live.error }
  })

  // Модели конкретного доступа: что через него доступно и по какой цене.
  ipcMain.handle('ai:models', (_e, accessId: unknown) =>
    vault.isUnlocked() ? vault.listAccessModels(asString(accessId)) : []
  )
  ipcMain.handle('ai:setModel', (_e, model: unknown) => {
    vault.setAccessModel(model as AiAccessModel)
    return { ok: true }
  })
  ipcMain.handle('ai:deleteModel', (_e, accessId: unknown, model: unknown) => {
    vault.deleteAccessModel(asString(accessId), asString(model))
    return { ok: true }
  })

  // Расход: дневные итоги из базы и разбор новых хвостов логов по требованию.
  ipcMain.handle('ai:usage', (_e, since: unknown) => {
    if (!vault.isUnlocked()) return { days: [], blocks: [], collectedAt: null, scannedFiles: 0, skipped: 0 }
    return {
      days: vault.listUsageDays(since ? asString(since) : undefined),
      blocks: vault.listUsageBlocks(),
      collectedAt: vault.lastUsageScan(),
      scannedFiles: 0,
      skipped: 0
    }
  })
  ipcMain.handle('ai:collect', async () => {
    if (!vault.isUnlocked()) return { files: 0, records: 0, duplicates: 0, unpriced: [] }
    return await collectUsage()
  })

  // Локальный ИИ-ассистент: извлечение полей устройства из текста (Ollama, приватно)
  ipcMain.handle('assist:parseDevice', (_e, text: unknown) => ollamaParseDevice(asString(text)))

  // IP → страна/флаг/хостер (авто-подстановка при добавлении устройства)
  ipcMain.handle('net:ipLookup', (_e, ip: unknown) => ipLookup(asString(ip)))

  // Dual-boot ПК: текущая ОС + переключение загрузки + питание на живой ОС
  ipcMain.handle('pc:whichOs', (_e, id: unknown) => pc.whichOs(asString(id)))
  ipcMain.handle('pc:bootEntries', (_e, id: unknown) => pc.bootEntries(asString(id)))
  ipcMain.handle('pc:metrics', async (_e, id: unknown) => {
    const deviceId = asString(id)
    const r = await pc.metrics(deviceId)
    const status = trackedReach('pc', deviceId, r.family === 'off' ? 'offline' : 'online')
    // Пишем историю ПК в снапшоты (чтобы вкладка «Метрики» работала как у серверов).
    // Выключенный ПК записываем ТОЖЕ, только статусом: иначе кэш последнего состояния воскрешал
    // его как «online» после перезапуска приложения, а в истории не оставалось провала.
    if (vault.isUnlocked() && status !== 'unknown') {
      vault.recordSnapshot(
        deviceId,
        status === 'offline'
          ? { status: 'off' }
          : {
              cpu: r.cpu,
              ramUsed: r.ramUsed,
              ramTotal: r.ramTotal,
              disk: r.disk,
              status: r.family
            }
      )
    }
    return { ...r, status }
  })
  ipcMain.handle('pc:boot', (_e, id: unknown, target: unknown) => pc.boot(asString(id), asString(target)))
  ipcMain.handle('pc:power', (_e, id: unknown, action: unknown) => {
    // Раньше здесь стояло `a === 'poweroff' || a === 'suspend' ? a : 'reboot'`: любое
    // неузнанное значение уводило живую машину в перезагрузку. Действие необратимое,
    // поэтому неизвестное — отказ, а не догадка.
    const a = resolvePowerAction(action)
    if (!a)
      return {
        ok: false,
        os: '',
        phase: 'rejected',
        error: `неизвестное действие питания: ${describeRejectedAction(action)}`
      } satisfies PowerResult
    return pc.power(asString(id), a)
  })
  ipcMain.handle('pc:wake', (_e, id: unknown) => pc.wake(asString(id)))
  ipcMain.handle('pc:powerDiag', (_e, id: unknown) => pc.powerDiag(asString(id)))

  // SFTP file browser
  ipcMain.handle('sftp:open', (_e, deviceId: unknown) => sftp.sftpOpen(asString(deviceId)))
  ipcMain.handle('sftp:list', (_e, sessionId: unknown, path: unknown) =>
    sftp.sftpList(asString(sessionId), asString(path))
  )
  ipcMain.handle('sftp:download', (e, sessionId: unknown, path: unknown) =>
    sftp.sftpDownload(asString(sessionId), asString(path), BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.handle('sftp:upload', (e, sessionId: unknown, remoteDir: unknown) =>
    sftp.sftpUpload(asString(sessionId), asString(remoteDir), BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.handle('sftp:delete', (_e, sessionId: unknown, path: unknown, isDir: unknown) =>
    sftp.sftpDelete(asString(sessionId), asString(path), Boolean(isDir))
  )
  ipcMain.on('sftp:close', (_e, sessionId: unknown) => sftp.sftpClose(asString(sessionId)))

  // Local port forwarding
  ipcMain.handle('forward:open', (_e, deviceId: unknown, lp: unknown, rh: unknown, rp: unknown) =>
    forward.openLocalForward(asString(deviceId), Number(lp) || 0, asString(rh) || '127.0.0.1', Number(rp) || 0)
  )
  ipcMain.handle('forward:list', (_e, deviceId: unknown) => forward.listForwards(deviceId ? asString(deviceId) : undefined))
  ipcMain.on('forward:close', (_e, id: unknown) => forward.closeForward(asString(id)))

  // Список слушающих портов сервера (для вкладки «Порты» + one-click туннель)
  ipcMain.handle('ports:list', (_e, deviceId: unknown) => ports.listListening(asString(deviceId)))

  // Тревоги сторожа. Уведомление системы легко пропустить или закрыть не глядя, поэтому то же
  // самое должно быть видно и в самом приложении.
  ipcMain.handle('alerts:list', () => watchdog.currentAlerts())

  // Сводка комплектующих: из кэша (быстро) + пересбор по кнопке
  ipcMain.handle('hw:get', (_e, deviceId: unknown) => hardware.getHardware(asString(deviceId)))
  ipcMain.handle('hw:refresh', (_e, deviceId: unknown) => hardware.refreshHardware(asString(deviceId)))

  // Скринеринг (Этап 4): проба готовности ПК + запуск сеанса в ОТДЕЛЬНОМ окне.
  // Пароль принимает только screen:open (главное окно) — окну экрана он не отдаётся никогда.
  ipcMain.handle('screen:preflight', (_e, deviceId: unknown) => screen.screenPreflight(asString(deviceId)))
  ipcMain.handle('screen:open', (_e, deviceId: unknown, opts: unknown) => {
    const o = (opts ?? {}) as Record<string, unknown>
    return screen.screenOpen(asString(deviceId), { password: asString(o.password), remember: !!o.remember })
  })
  // Забыть сохранённый пароль трансляции. Само значение в renderer не уходит ни при каких условиях.
  ipcMain.handle('screen:forgetPassword', (_e, deviceId: unknown) => {
    vault.setScreenPassword(asString(deviceId), null)
    return { ok: true }
  })

  // Собственный агент трансляции: статус, установка, удаление.
  ipcMain.handle('agent:status', (_e, deviceId: unknown) => agent.agentStatus(asString(deviceId)))
  ipcMain.handle('agent:provision', (_e, deviceId: unknown) => agent.provisionAgent(asString(deviceId)))
  ipcMain.handle('agent:forget', (_e, deviceId: unknown) => agent.forgetAgent(asString(deviceId)))
  ipcMain.handle('screen:claim', (e, handle: unknown) =>
    screen.screenClaim(asString(handle), BrowserWindow.fromWebContents(e.sender)?.id ?? null)
  )
  // Рабочий стол отрисовался — только теперь введённый пароль доказал свою верность.
  ipcMain.handle('screen:confirmPassword', (e, handle: unknown) =>
    screen.screenConfirmPassword(asString(handle), BrowserWindow.fromWebContents(e.sender)?.id ?? null)
  )

  // Управление собственным окном (окну экрана нужны полный экран / свернуть / закрыть,
  // потому что в полноэкранном титлбар ОС исчезает). Действует только на окно-отправитель.
  const senderWin = (e: { sender: Electron.WebContents }): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle('window:setFullScreen', (e, on: unknown) => {
    const w = senderWin(e)
    w?.setFullScreen(!!on)
    return !!w?.isFullScreen()
  })
  ipcMain.handle('window:isFullScreen', (e) => !!senderWin(e)?.isFullScreen())
  ipcMain.on('window:minimize', (e) => senderWin(e)?.minimize())
  ipcMain.on('window:close', (e) => senderWin(e)?.close())

  // Буфер обмена — через main, а не navigator.clipboard: тот в Electron требует фокуса
  // и жеста пользователя, а вставка из удалённого ПК прилетает асинхронно.
  ipcMain.handle('clip:read', () => clipboard.readText())
  ipcMain.on('clip:write', (_e, text: unknown) => clipboard.writeText(asString(text)))

  // ~/.ssh/config import + Tailscale discovery
  ipcMain.handle('sshconfig:parse', () => parseSshConfig())
  ipcMain.handle('discovery:tailscale', () => discoverTailscale())
  ipcMain.handle('sshconfig:import', (_e, hosts: unknown) => {
    if (!Array.isArray(hosts)) return { ok: false, added: 0 }
    let added = 0
    for (const h of hosts as ParsedHost[]) {
      try {
        vault.createDevice({
          name: String(h.name || h.host || 'host'),
          provider: 'SSH',
          ip: String(h.host || ''),
          port: Number(h.port) || 22,
          user: String(h.user || 'root'),
          os: '',
          country: '',
          consoleUrl: ''
        })
        added++
      } catch {
        /* skip bad entry */
      }
    }
    return { ok: true, added }
  })
}
