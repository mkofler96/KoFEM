import { useModelStore, RESULT_TYPES } from '../../store/modelStore'
import styles from './ResultsPanel.module.css'

export function ResultsPanel() {
  const result = useModelStore(s => s.result)
  const resultType = useModelStore(s => s.resultType)
  const setResultType = useModelStore(s => s.setResultType)
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.title}>Results</div>
        <div className={styles.empty}>No results — run the solver first</div>
      </div>
    )
  }

  const d = result.displacements

  // Per-component min/max stats
  const stats = (() => {
    const n = nodes.length
    if (n === 0) return null

    let minMag = Infinity, maxMag = -Infinity
    let minUx = Infinity, maxUx = -Infinity
    let minUy = Infinity, maxUy = -Infinity
    let minUz = Infinity, maxUz = -Infinity

    for (let i = 0; i < n; i++) {
      const ux = d[i * 3] ?? 0
      const uy = d[i * 3 + 1] ?? 0
      const uz = d[i * 3 + 2] ?? 0
      const mag = Math.sqrt(ux * ux + uy * uy + uz * uz)
      if (mag < minMag) minMag = mag
      if (mag > maxMag) maxMag = mag
      if (ux < minUx) minUx = ux
      if (ux > maxUx) maxUx = ux
      if (uy < minUy) minUy = uy
      if (uy > maxUy) maxUy = uy
      if (uz < minUz) minUz = uz
      if (uz > maxUz) maxUz = uz
    }
    return { minMag, maxMag, minUx, maxUx, minUy, maxUy, minUz, maxUz }
  })()

  // Per-node von Mises (averaged from element values)
  const vmStats = (() => {
    if (!result.vonMises || elements.length === 0 || nodes.length === 0) return null
    const vm = result.vonMises
    let minVm = Infinity, maxVm = -Infinity

    // Build nodeIndex map: nodeId → flat index in nodes array
    const nodeIndex = new Map<number, number>()
    for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].id, i)
    const sums = new Float64Array(nodes.length)
    const counts = new Int32Array(nodes.length)
    for (let ei = 0; ei < elements.length; ei++) {
      const vmVal = vm[ei] ?? 0
      for (const nodeId of elements[ei].nodeIds) {
        const ni = nodeIndex.get(nodeId)
        if (ni !== undefined) {
          sums[ni as number] += vmVal
          counts[ni as number]++
        }
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const v = counts[i] > 0 ? sums[i] / counts[i] : 0
      if (v < minVm) minVm = v
      if (v > maxVm) maxVm = v
    }
    return { minVm, maxVm }
  })()

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Results</div>
      <select
        className={styles.select}
        value={resultType}
        onChange={e => setResultType(e.target.value as typeof RESULT_TYPES[number])}
      >
        {RESULT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>

      {stats && (resultType === 'Displacement (magnitude)') && (
        <>
          <div className={styles.stat}>Min |U|: {stats.minMag.toExponential(3)} m</div>
          <div className={styles.stat}>Max |U|: {stats.maxMag.toExponential(3)} m</div>
        </>
      )}
      {stats && resultType === 'Ux' && (
        <>
          <div className={styles.stat}>Min Ux: {stats.minUx.toExponential(3)} m</div>
          <div className={styles.stat}>Max Ux: {stats.maxUx.toExponential(3)} m</div>
        </>
      )}
      {stats && resultType === 'Uy' && (
        <>
          <div className={styles.stat}>Min Uy: {stats.minUy.toExponential(3)} m</div>
          <div className={styles.stat}>Max Uy: {stats.maxUy.toExponential(3)} m</div>
        </>
      )}
      {stats && resultType === 'Uz' && (
        <>
          <div className={styles.stat}>Min Uz: {stats.minUz.toExponential(3)} m</div>
          <div className={styles.stat}>Max Uz: {stats.maxUz.toExponential(3)} m</div>
        </>
      )}
      {resultType === 'Von Mises stress' && (
        vmStats
          ? <>
              <div className={styles.stat}>Min σ_vm: {vmStats.minVm.toExponential(3)} Pa</div>
              <div className={styles.stat}>Max σ_vm: {vmStats.maxVm.toExponential(3)} Pa</div>
            </>
          : <div className={styles.stat}>Von Mises data not available</div>
      )}
    </div>
  )
}
