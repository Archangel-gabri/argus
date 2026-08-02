import { contextBridge, ipcRenderer } from 'electron'

// Минимальная поверхность окна трансляции. Здесь намеренно НЕТ vault/devices/ssh/sftp/agent:
// компрометация canvas-окна не должна превращаться в доступ ко всему командному центру.
const api = {
  screen: {
    claim: (handle: string) => ipcRenderer.invoke('screen:claim', handle),
    // Подтверждение, что сеанс дошёл до рабочего стола: до него пароль не сохраняется.
    confirmPassword: (handle: string) => ipcRenderer.invoke('screen:confirmPassword', handle)
  },
  win: {
    setFullScreen: (on: boolean) => ipcRenderer.invoke('window:setFullScreen', on),
    isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close')
  },
  clip: {
    read: () => ipcRenderer.invoke('clip:read'),
    write: (text: string) => ipcRenderer.send('clip:write', text)
  }
}

contextBridge.exposeInMainWorld('api', api)
