// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useModelStore } from '../../store/modelStore'

// [1,1,1] normalized — standard isometric direction
const ISO_DIR = new THREE.Vector3(1, 1, 1).normalize()

export function FitCamera() {
  const { camera, controls } = useThree()
  const fitViewTrigger = useModelStore(s => s.fitViewTrigger)

  useEffect(() => {
    // Controls may not be registered yet on the initial mount — skip and wait
    // for the effect to re-fire once OrbitControls registers via makeDefault.
    if (!controls) return

    const { nodes, stepSurface } = useModelStore.getState()

    const pts: [number, number, number][] = []
    for (const n of nodes) pts.push([n.x, n.y, n.z])
    if (stepSurface) {
      for (const p of stepSurface.points) pts.push(p)
    }
    if (pts.length === 0) return

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity
    for (const [x, y, z] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
    }

    const center = new THREE.Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    )
    const diagonal = Math.sqrt(
      (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2,
    )
    const radius = Math.max(diagonal / 2, 1e-6)

    const fovRad = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180
    const distance = radius / Math.tan(fovRad / 2)

    camera.position.copy(center).addScaledVector(ISO_DIR, distance)
    const cam = camera as THREE.PerspectiveCamera
    cam.near = Math.max(distance * 0.001, 1e-4)
    cam.far = distance * 100
    cam.updateProjectionMatrix()

    const oc = controls as unknown as { target: THREE.Vector3; update(): void }
    oc.target.copy(center)
    oc.update()
  }, [fitViewTrigger, controls]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
