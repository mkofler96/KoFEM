import styles from './PropertiesPanel.module.css'

export function PropertiesPanel() {
  return (
    <div className={styles.panel}>
      <div className={styles.title}>Properties</div>
      <div className={styles.empty}>Select an entity to edit properties</div>
    </div>
  )
}
