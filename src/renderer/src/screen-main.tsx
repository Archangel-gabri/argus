// Точка входа окна «экран ПК». Отдельный корень: ни vault, ни store, ни drawer здесь не живут —
// окну нужны только адрес локального моста и токен, которые оно забирает по своему handle.
import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import './assets/main.css'
import { ScreenWindow } from './ScreenWindow'

// handle сеанса приезжает хэшем: screen.html#<uuid>
const handle = decodeURIComponent(window.location.hash.replace(/^#/, ''))

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ScreenWindow handle={handle} />
  </React.StrictMode>
)
