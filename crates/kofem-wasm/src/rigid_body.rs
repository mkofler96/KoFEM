// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Browser binding for the rigid-body check that runs before a solve
//! (`kofem_fem::rigid_body`, KOF-388).

use kofem_fem::{free_rigid_motions, FreeMotion, RigidBodyModel, RigidLink};
use wasm_bindgen::prelude::*;

use crate::to_js;

/// The loose components of a model, in CSR form: component k has the labels
/// `labels[labelOffsets[k] .. labelOffsets[k + 1]]`, the free translation
/// directions `translations` (x,y,z each) from `translationOffsets[k]` to
/// `translationOffsets[k + 1]` (counted in directions), and the free rotation
/// axes likewise in `rotationAxes` / `rotationOffsets`. A direction along a
/// coordinate axis is exactly that unit axis.
#[wasm_bindgen]
pub struct FreeMotions {
    label_offsets: Vec<u32>,
    labels: Vec<u32>,
    translation_offsets: Vec<u32>,
    translations: Vec<f64>,
    rotation_offsets: Vec<u32>,
    rotation_axes: Vec<f64>,
}

fn offsets(
    motions: &[FreeMotion],
    count: impl Fn(&FreeMotion) -> usize,
) -> Result<Vec<u32>, JsError> {
    let mut offsets = vec![0_u32];
    let mut total = 0_usize;
    for motion in motions {
        total += count(motion);
        offsets.push(u32::try_from(total).map_err(|_| {
            JsError::new(&format!(
                "{total} free-motion entries do not fit a 32-bit offset"
            ))
        })?);
    }
    Ok(offsets)
}

impl FreeMotions {
    fn new(motions: &[FreeMotion]) -> Result<Self, JsError> {
        Ok(Self {
            label_offsets: offsets(motions, |motion| motion.labels.len())?,
            labels: motions
                .iter()
                .flat_map(|motion| motion.labels.iter().copied())
                .collect(),
            translation_offsets: offsets(motions, |motion| motion.translations.len())?,
            translations: motions
                .iter()
                .flat_map(|motion| motion.translations.iter().flatten().copied())
                .collect(),
            rotation_offsets: offsets(motions, |motion| motion.rotation_axes.len())?,
            rotation_axes: motions
                .iter()
                .flat_map(|motion| motion.rotation_axes.iter().flatten().copied())
                .collect(),
        })
    }
}

#[wasm_bindgen]
impl FreeMotions {
    /// Loose components; 0 when every body is held.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn count(&self) -> usize {
        self.label_offsets.len() - 1
    }

    #[wasm_bindgen(getter, js_name = labelOffsets)]
    #[must_use]
    pub fn label_offsets(&self) -> Vec<u32> {
        self.label_offsets.clone()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn labels(&self) -> Vec<u32> {
        self.labels.clone()
    }

    #[wasm_bindgen(getter, js_name = translationOffsets)]
    #[must_use]
    pub fn translation_offsets(&self) -> Vec<u32> {
        self.translation_offsets.clone()
    }

    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn translations(&self) -> Vec<f64> {
        self.translations.clone()
    }

    #[wasm_bindgen(getter, js_name = rotationOffsets)]
    #[must_use]
    pub fn rotation_offsets(&self) -> Vec<u32> {
        self.rotation_offsets.clone()
    }

    #[wasm_bindgen(getter, js_name = rotationAxes)]
    #[must_use]
    pub fn rotation_axes(&self) -> Vec<f64> {
        self.rotation_axes.clone()
    }
}

fn split(values: &[u32], offsets: &[u32], what: &str) -> Result<Vec<Vec<u32>>, JsError> {
    let malformed = || JsError::new(&format!("{what}: offsets do not describe the node array"));
    if offsets.first() != Some(&0)
        || offsets.last().map(|&last| last as usize) != Some(values.len())
    {
        return Err(malformed());
    }
    offsets
        .windows(2)
        .map(|pair| {
            values
                .get(pair[0] as usize..pair[1] as usize)
                .map(<[u32]>::to_vec)
                .ok_or_else(malformed)
        })
        .collect()
}

/// Which bodies a model's supports, ties and couplings leave free to move.
/// Elements are node lists in CSR form (`elementOffsets` into `elementNodes`),
/// each with a label (its body). `rotationalNodes` carry rotation DOFs (shell
/// nodes, reference points). Link k makes the nodes
/// `secondaryNodes[secondaryOffsets[k] ..]` move with the components of
/// `primaryNodes[primaryOffsets[k] ..]` on the DOFs of bit mask `masks[k]`.
/// `fixedDofs` are the supported DOFs, `6·node + dof`.
///
/// # Errors
/// Inconsistent arrays: malformed offsets, a mask count that is not the link
/// count, or what `kofem_fem::free_rigid_motions` refuses.
#[wasm_bindgen(js_name = freeRigidMotions)]
#[expect(
    clippy::too_many_arguments,
    reason = "typed arrays cross the WASM boundary one argument each"
)]
pub fn free_rigid_motions_js(
    positions: &[f64],
    element_offsets: &[u32],
    element_nodes: &[u32],
    element_labels: &[u32],
    rotational_nodes: &[u32],
    primary_offsets: &[u32],
    primary_nodes: &[u32],
    secondary_offsets: &[u32],
    secondary_nodes: &[u32],
    masks: &[u8],
    fixed_dofs: &[u32],
) -> Result<FreeMotions, JsError> {
    let primaries = split(primary_nodes, primary_offsets, "link primaries")?;
    let secondaries = split(secondary_nodes, secondary_offsets, "link secondaries")?;
    if primaries.len() != masks.len() || secondaries.len() != masks.len() {
        return Err(JsError::new(&format!(
            "{} primary and {} secondary node lists for {} link masks",
            primaries.len(),
            secondaries.len(),
            masks.len()
        )));
    }
    let links: Vec<RigidLink> = primaries
        .into_iter()
        .zip(secondaries)
        .zip(masks)
        .map(|((primary, secondary), &dof_mask)| RigidLink {
            primary,
            secondary,
            dof_mask,
        })
        .collect();
    let motions = free_rigid_motions(&RigidBodyModel {
        positions,
        element_offsets,
        element_nodes,
        element_labels,
        rotational_nodes,
        links: &links,
        fixed_dofs,
    })
    .map_err(|error| to_js(&error))?;
    FreeMotions::new(&motions)
}
