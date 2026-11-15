# KoFEM topology-optimization benchmark results

Each case is optimized by the app's Rust optimizer (the SIMP minimum-compliance
loop + MMA optimizer, KOF-230/231) and its converged compliance, volume
fraction and layout are checked against a documented tolerance band.
Regenerate with:

```bash
cd web && bun ../examples/validation/topopt/run.mjs --report
```

## MBB beam (half-model)

36×12 half-beam, volfrac 0.5, p 3 — Sigmund/Andreassen

- **iterations:** 50 (converged: true)
- **compliance:** 1802.4 → 413.1 (ratio 0.229)
- **volume fraction:** 0.5000 (target 0.5)
- **density:** 134 solid, 134 void, std 0.408

```
  #########################:
  ##########################:
  ######::::::::##############
    :###            :####::####
     :###          :####:   :###
      :###:       :####:     :###:
       :###:     :###:        :###:
        :####  :####:          :###:
        ::####:####              ####:
  ###############:               :####
  ###############:::::::::::::::::####
  ####################################
```

- ✅ converged within the iteration budget
- ✅ volume fraction within 1 % of 0.5
- ✅ compliance in band [351, 475]
- ✅ compliance ratio < 0.3
- ✅ ended at its stiffest design (final = min compliance)
- ✅ material concentrated to solid and void
- ✅ topology emerged (density std > 0.15)

## 3D cantilever (tip load)

10×5×5 box, volfrac 0.4, p 3 — fixed root, tip load

- **iterations:** 45 (converged: true)
- **compliance:** 616.6 → 188.5 (ratio 0.306)
- **volume fraction:** 0.4000 (target 0.4)
- **density:** 14 solid, 46 void, std 0.264
- **z-mirror max |Δρ|:** 4.90e-9

```
  #######:
  ########::
    ::#:####
  ##########
  ##########
```

- ✅ converged within the iteration budget
- ✅ volume fraction within 1 % of 0.4
- ✅ compliance in band [160, 217]
- ✅ compliance ratio < 0.4
- ✅ ended at its stiffest design (final = min compliance)
- ✅ material concentrated to solid and void
- ✅ topology emerged (density std > 0.15)
- ✅ design symmetric about z-midplane (max |Δρ| < 1e-3)

## Cantilever mesh-independence

10×5×5 vs 20×10×10, same r_min 0.4

- **coarse:** 250 elems, 45 it, c = 188.5, vol 0.4000
- **fine:** 2000 elems, 69 it, c = 190.5, vol 0.4000
- **compliance difference:** 1.07 %
- **density correlation:** 0.9940
- **solid-region IoU @0.5:** 0.9278

- ✅ both resolutions converged
- ✅ compliance agrees within 5 %
- ✅ density correlation > 0.9
- ✅ solid-region IoU > 0.85
