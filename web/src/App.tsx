import { Viewport } from './components/viewport/Viewport'
import { Sidebar } from './components/sidebar/Sidebar'
import { PropertiesPanel } from './components/properties/PropertiesPanel'
import { Toolbar } from './components/toolbar/Toolbar'
import { ResultsPanel } from './components/results/ResultsPanel'
import { FacePickPanel } from './components/bc/FacePickPanel'
import styles from './App.module.css'

export default function App() {
  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.logo}>KoFEM</span>
        <Toolbar />
      </header>
      <aside className={styles.sidebar}>
        <Sidebar />
      </aside>
      <main className={styles.viewport}>
        <Viewport />
      </main>
      <aside className={styles.properties}>
        <FacePickPanel />
        <PropertiesPanel />
        <ResultsPanel />
      </aside>
    </div>
  )
}
