import { useModelStore } from './store/modelStore'
import { WelcomeScreen } from './components/welcome/WelcomeScreen'
import { TopBar } from './components/topbar/TopBar'
import { LeftPanel } from './components/panel/LeftPanel'
import { Viewport } from './components/viewport/Viewport'
import { StatusBar } from './components/statusbar/StatusBar'
import styles from './App.module.css'

export default function App() {
  const hasStarted = useModelStore(s => s.hasStarted)
  if (!hasStarted) return <WelcomeScreen />

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
