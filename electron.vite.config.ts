import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Окно экрана имеет отдельный минимальный bridge. Общий preload давал ему весь API
    // основного окна (vault/SSH/SFTP/провижининг), хотя по контракту оно должно знать только
    // параметры своего потока, действия собственного окна и буфер обмена.
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          screen: resolve('src/preload/screen.ts')
        }
      }
    }
  },
  renderer: {
    server: { port: 5273, strictPort: true },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    // Два окна = две точки входа: index (приложение) и screen (окно «экран ПК»).
    // Окно экрана монтирует только плеер — ни vault, ни store, ни drawer в нём не поднимаются.
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          screen: resolve('src/renderer/screen.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
