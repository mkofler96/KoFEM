import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TopBar } from './components/topbar/TopBar'
import { LeftPanel } from './components/panel/LeftPanel'
import { Viewport } from './components/viewport/Viewport'
import { StatusBar } from './components/statusbar/StatusBar'
import styles from './App.module.css'

function Workspace() {
  return (
    <div className={styles.layout}>
      <TopBar />
      <LeftPanel />
      <main className={styles.viewport}>
        <Viewport />
      </main>
      <StatusBar />
    </div>
  )
}

// The solver app is mounted at /app/ (see app/index.html + vite.config.ts).
// The marketing landing at "/" is a separate static HTML page.
export default function App() {
  return (
    <BrowserRouter basename="/app">
      <Routes>
        <Route path="/" element={<Workspace />} />
      </Routes>
    </BrowserRouter>
  )
}
