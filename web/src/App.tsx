import React from 'react'
import { Viewport } from './components/viewport/Viewport'
import { ModelTree } from './components/tree/ModelTree'
import { PropertiesPanel } from './components/properties/PropertiesPanel'
import { Toolbar } from './components/toolbar/Toolbar'
import { ResultsPanel } from './components/results/ResultsPanel'
import styles from './App.module.css'

export default function App() {
  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.logo}>KoFEM</span>
        <Toolbar />
      </header>
      <aside className={styles.sidebar}>
        <ModelTree />
      </aside>
      <main className={styles.viewport}>
        <Viewport />
      </main>
      <aside className={styles.properties}>
        <PropertiesPanel />
        <ResultsPanel />
      </aside>
    </div>
  )
}
