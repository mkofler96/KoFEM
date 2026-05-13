//! Abaqus INP file parser.
//!
//! Reads the subset of the Abaqus INP keyword format needed for linear-static
//! FEM: nodes, elements, node/element sets, materials, sections, boundary
//! conditions and concentrated loads.
//!
//! References (Abaqus Analysis User's Guide, 3.2.1 – 3.2.2):
//!   - Higher-order elements are down-converted to their linear corner-node
//!     equivalents (C3D10→CTETRA, C3D20→CHEXA, CPS6/CPE6→CTRIA3).
//!   - DOF numbering: Abaqus 1-based → KoFEM 0-based (subtract 1).

extern crate alloc;

use alloc::borrow::ToOwned;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

// ── Output types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct InpNode {
    pub id: usize,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct InpElement {
    pub id: usize,
    #[cfg_attr(feature = "serde", serde(rename = "type"))]
    pub kind: String,
    #[cfg_attr(feature = "serde", serde(rename = "nodeIds"))]
    pub node_ids: Vec<usize>,
    #[cfg_attr(feature = "serde", serde(rename = "propertyId"))]
    pub property_id: usize,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct InpMaterial {
    pub id: usize,
    pub name: String,
    pub young: f64,
    pub poisson: f64,
    pub density: f64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct InpProperty {
    pub id: usize,
    #[cfg_attr(feature = "serde", serde(rename = "type"))]
    pub kind: String,
    #[cfg_attr(feature = "serde", serde(rename = "materialId"))]
    pub material_id: usize,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub thickness: Option<f64>,
    #[cfg_attr(feature = "serde", serde(rename = "planeFormulation"))]
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub plane_formulation: Option<String>,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct InpConstraint {
    #[cfg_attr(feature = "serde", serde(rename = "nodeId"))]
    pub node_id: usize,
    pub dof: u8,
    #[cfg_attr(feature = "serde", serde(rename = "prescribedValue", default))]
    pub prescribed_value: f64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct InpLoad {
    #[cfg_attr(feature = "serde", serde(rename = "nodeId"))]
    pub node_id: usize,
    pub dof: u8,
    pub value: f64,
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ParsedInp {
    #[cfg_attr(feature = "serde", serde(rename = "modelName"))]
    pub model_name: String,
    pub nodes: Vec<InpNode>,
    pub elements: Vec<InpElement>,
    pub materials: Vec<InpMaterial>,
    pub properties: Vec<InpProperty>,
    pub constraints: Vec<InpConstraint>,
    pub loads: Vec<InpLoad>,
}

// ── Internal types ────────────────────────────────────────────────────────────

struct ElemMapping {
    kind: &'static str,
    hint: &'static str, // "solid" | "plane_stress" | "plane_strain" | "shell" | "beam"
    /// Number of corner nodes expected by the linear KoFEM element.
    corner_nodes: usize,
    /// Indices to pick from the parsed node list (None = first corner_nodes).
    corner_indices: Option<&'static [usize]>,
}

struct MatDef {
    name: String,
    young: f64,
    poisson: f64,
    density: f64,
}

struct SectionDef {
    elset: String,
    mat_name: String,
    hint: &'static str,
    thickness: Option<f64>,
}

// ── Element type mapping ──────────────────────────────────────────────────────

fn map_abaqus_elem(t: &str) -> Option<ElemMapping> {
    match t.to_uppercase().as_str() {
        // 3-D solid — linear
        "C3D4" | "C3D4H" => Some(ElemMapping {
            kind: "CTETRA",
            hint: "solid",
            corner_nodes: 4,
            corner_indices: None,
        }),
        "C3D8" | "C3D8R" | "C3D8I" | "C3D8H" => Some(ElemMapping {
            kind: "CHEXA",
            hint: "solid",
            corner_nodes: 8,
            corner_indices: None,
        }),
        "C3D6" | "C3D6H" => Some(ElemMapping {
            kind: "CPENTA",
            hint: "solid",
            corner_nodes: 6,
            corner_indices: None,
        }),
        "C3D5" => Some(ElemMapping {
            kind: "CPYRAM",
            hint: "solid",
            corner_nodes: 5,
            corner_indices: None,
        }),
        // 3-D solid — quadratic: keep corner nodes only (first corner_nodes in Abaqus ordering)
        "C3D10" | "C3D10H" | "C3D10M" => Some(ElemMapping {
            kind: "CTETRA",
            hint: "solid",
            corner_nodes: 4,
            corner_indices: None,
        }),
        "C3D20" | "C3D20R" | "C3D20RH" => Some(ElemMapping {
            kind: "CHEXA",
            hint: "solid",
            corner_nodes: 8,
            corner_indices: None,
        }),
        // 2-D plane stress — linear and quadratic (first 3/4 nodes are corners)
        "CPS3" | "CPS6" => Some(ElemMapping {
            kind: "CTRIA3",
            hint: "plane_stress",
            corner_nodes: 3,
            corner_indices: None,
        }),
        "CPS4" | "CPS4R" => Some(ElemMapping {
            kind: "CQUAD4",
            hint: "plane_stress",
            corner_nodes: 4,
            corner_indices: None,
        }),
        // 2-D plane strain
        "CPE3" | "CPE3H" | "CPE6" | "CPE6H" => Some(ElemMapping {
            kind: "CTRIA3",
            hint: "plane_strain",
            corner_nodes: 3,
            corner_indices: None,
        }),
        "CPE4" | "CPE4R" | "CPE4H" => Some(ElemMapping {
            kind: "CQUAD4",
            hint: "plane_strain",
            corner_nodes: 4,
            corner_indices: None,
        }),
        // Shell
        "S3" | "S3R" | "STRI3" => Some(ElemMapping {
            kind: "CTRIA3",
            hint: "shell",
            corner_nodes: 3,
            corner_indices: None,
        }),
        "S4" | "S4R" | "S4R5" => Some(ElemMapping {
            kind: "CQUAD4",
            hint: "shell",
            corner_nodes: 4,
            corner_indices: None,
        }),
        // Beam: B31 = linear (2 nodes), B32 = quadratic (endpoints at 0 and 2)
        "B31" | "B31R" => Some(ElemMapping {
            kind: "CBAR",
            hint: "beam",
            corner_nodes: 2,
            corner_indices: None,
        }),
        "B32" | "B32R" => Some(ElemMapping {
            kind: "CBAR",
            hint: "beam",
            corner_nodes: 2,
            corner_indices: Some(&[0, 2]),
        }),
        "B33" | "B33R" => Some(ElemMapping {
            kind: "CBAR",
            hint: "beam",
            corner_nodes: 2,
            corner_indices: Some(&[0, 3]),
        }),
        _ => None,
    }
}

// ── Keyword parsing ───────────────────────────────────────────────────────────

struct KwLine {
    kw: String,
    params: BTreeMap<String, String>,
}

fn parse_keyword(line: &str) -> KwLine {
    let inner = &line[1..]; // strip leading '*'
    let mut parts = inner.splitn(2, ',');
    let kw = parts.next().unwrap_or("").trim().to_uppercase();
    let rest = parts.next().unwrap_or("");

    let mut params = BTreeMap::new();
    for token in rest.split(',') {
        let mut kv = token.splitn(2, '=');
        let k = kv.next().unwrap_or("").trim().to_uppercase();
        let v = kv.next().unwrap_or("").trim().to_owned();
        if !k.is_empty() {
            params.insert(k, v);
        }
    }
    KwLine { kw, params }
}

/// DOF names for built-in boundary types; returned as 0-based KoFEM indices.
fn builtin_dofs(s: &str) -> Option<Vec<u8>> {
    match s.to_uppercase().as_str() {
        "ENCASTRE" => Some(vec![0, 1, 2, 3, 4, 5]),
        "PINNED" => Some(vec![0, 1, 2]),
        "XSYMM" => Some(vec![0, 4, 5]),
        "YSYMM" => Some(vec![1, 3, 5]),
        "ZSYMM" => Some(vec![2, 3, 4]),
        _ => None,
    }
}

fn parse_f64(s: &str) -> Option<f64> {
    // Accept Abaqus-style 1.5E+10, 1.5e10, 1.5D+10 (D is Fortran notation)
    s.trim().replace('D', "E").replace('d', "e").parse().ok()
}

fn parse_usize(s: &str) -> Option<usize> {
    s.trim().parse().ok()
}

fn resolve_nodes(token: &str, node_sets: &BTreeMap<String, Vec<usize>>) -> Vec<usize> {
    if let Some(id) = parse_usize(token) {
        vec![id]
    } else {
        node_sets
            .get(&token.trim().to_uppercase())
            .cloned()
            .unwrap_or_default()
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Parse an Abaqus INP file text into a [`ParsedInp`].
pub fn parse_inp(text: &str) -> Result<ParsedInp, String> {
    let lines: Vec<&str> = text.lines().collect();
    let n = lines.len();

    let mut nodes: Vec<InpNode> = Vec::new();
    let mut elements: Vec<InpElement> = Vec::new();
    let mut node_sets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut elem_sets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut elem_hints: BTreeMap<usize, &'static str> = BTreeMap::new();
    let mut mat_defs: BTreeMap<String, MatDef> = BTreeMap::new(); // uppercase key → def
    let mut section_defs: Vec<SectionDef> = Vec::new();
    let mut constraints: Vec<InpConstraint> = Vec::new();
    let mut loads: Vec<InpLoad> = Vec::new();

    let mut model_name = "Abaqus Model".to_owned();
    let mut kw = String::new();
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    let mut current_mat: Option<String> = None;
    let mut pending_section: Option<SectionDef> = None;
    let mut section_data_read = false;

    let mut i = 0;
    while i < n {
        let line = lines[i].trim();
        i += 1;

        if line.is_empty() || line.starts_with("**") {
            continue;
        }

        // ── Keyword line ─────────────────────────────────────────────────────
        if line.starts_with('*') {
            // Flush pending section that had no data line
            if let Some(sec) = pending_section.take() {
                if !section_data_read {
                    section_defs.push(sec);
                }
            }
            section_data_read = false;

            let kl = parse_keyword(line);
            kw = kl.kw;
            params = kl.params;
            pending_section = None;

            match kw.as_str() {
                "HEADING" => {
                    if i < n && !lines[i].trim_start().starts_with('*') {
                        let h = lines[i].trim();
                        if !h.is_empty() {
                            model_name = h.to_owned();
                        }
                        i += 1;
                    }
                }
                "MATERIAL" => {
                    let name = params
                        .get("NAME")
                        .cloned()
                        .unwrap_or_else(|| "Material".to_owned());
                    let upper = name.to_uppercase();
                    current_mat = Some(upper.clone());
                    mat_defs.entry(upper).or_insert_with(|| MatDef {
                        name,
                        young: 0.0,
                        poisson: 0.0,
                        density: 0.0,
                    });
                }
                "SOLID SECTION" | "MEMBRANE SECTION" => {
                    let elset = params
                        .get("ELSET")
                        .cloned()
                        .unwrap_or_default()
                        .to_uppercase();
                    let mat_name = params
                        .get("MATERIAL")
                        .cloned()
                        .unwrap_or_default()
                        .to_uppercase();
                    pending_section = Some(SectionDef {
                        elset,
                        mat_name,
                        hint: "solid",
                        thickness: None,
                    });
                }
                "SHELL SECTION" => {
                    let elset = params
                        .get("ELSET")
                        .cloned()
                        .unwrap_or_default()
                        .to_uppercase();
                    let mat_name = params
                        .get("MATERIAL")
                        .cloned()
                        .unwrap_or_default()
                        .to_uppercase();
                    pending_section = Some(SectionDef {
                        elset,
                        mat_name,
                        hint: "shell",
                        thickness: None,
                    });
                }
                "BEAM SECTION" | "BEAM GENERAL SECTION" => {
                    let elset = params
                        .get("ELSET")
                        .cloned()
                        .unwrap_or_default()
                        .to_uppercase();
                    let mat_name = params
                        .get("MATERIAL")
                        .cloned()
                        .unwrap_or_default()
                        .to_uppercase();
                    pending_section = Some(SectionDef {
                        elset,
                        mat_name,
                        hint: "beam",
                        thickness: None,
                    });
                }
                _ => {}
            }
            continue;
        }

        // ── Data line ─────────────────────────────────────────────────────────

        // Pending section: first data line may carry thickness
        if let Some(ref mut sec) = pending_section {
            if !section_data_read {
                section_data_read = true;
                let first = line.split(',').next().unwrap_or("").trim();
                if let Some(t) = parse_f64(first) {
                    if t > 0.0 {
                        sec.thickness = Some(t);
                    }
                }
                section_defs.push(pending_section.take().unwrap());
                continue;
            }
        }

        let parts: Vec<&str> = line.split(',').map(str::trim).collect();

        match kw.as_str() {
            "NODE" => {
                if parts.len() >= 3 {
                    if let Some(id) = parse_usize(parts[0]) {
                        let x = parse_f64(parts[1]).unwrap_or(0.0);
                        let y = parse_f64(parts[2]).unwrap_or(0.0);
                        let z = if parts.len() >= 4 {
                            parse_f64(parts[3]).unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        nodes.push(InpNode { id, x, y, z });
                    }
                }
            }

            "ELEMENT" => {
                // Elements may span multiple lines (trailing comma = continuation)
                let mut data = line.to_owned();
                while data.ends_with(',') && i < n {
                    let next = lines[i].trim();
                    if next.starts_with('*') || next.starts_with("**") || next.is_empty() {
                        break;
                    }
                    data.push_str(next);
                    i += 1;
                }

                let ps: Vec<&str> = data
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                if ps.len() >= 2 {
                    let type_str = params.get("TYPE").map(String::as_str).unwrap_or("");
                    if let Some(mapping) = map_abaqus_elem(type_str) {
                        if let Some(id) = parse_usize(ps[0]) {
                            let all_nodes: Vec<usize> =
                                ps[1..].iter().filter_map(|s| parse_usize(s)).collect();

                            let node_ids = if let Some(idxs) = mapping.corner_indices {
                                idxs.iter()
                                    .filter_map(|&ci| all_nodes.get(ci).copied())
                                    .collect()
                            } else {
                                all_nodes.into_iter().take(mapping.corner_nodes).collect()
                            };

                            elements.push(InpElement {
                                id,
                                kind: mapping.kind.to_owned(),
                                node_ids,
                                property_id: 0, // assigned later
                            });
                            elem_hints.insert(id, mapping.hint);

                            // Register element in the ELSET from keyword param
                            if let Some(elset) = params.get("ELSET") {
                                let key = elset.to_uppercase();
                                elem_sets.entry(key).or_default().push(id);
                            }
                        }
                    }
                }
            }

            "NSET" => {
                let name = params
                    .get("NSET")
                    .cloned()
                    .unwrap_or_default()
                    .to_uppercase();
                if name.is_empty() {
                    continue;
                }
                let has_generate = params.contains_key("GENERATE");
                let nums: Vec<usize> = parts.iter().filter_map(|s| parse_usize(s)).collect();
                // Collect named-set references before borrowing mutably
                let named_refs: Vec<usize> = if !has_generate {
                    parts
                        .iter()
                        .filter(|p| parse_usize(p).is_none())
                        .flat_map(|p| {
                            node_sets
                                .get(&p.to_uppercase())
                                .cloned()
                                .unwrap_or_default()
                        })
                        .collect()
                } else {
                    vec![]
                };
                let set = node_sets.entry(name).or_default();
                if has_generate && nums.len() >= 2 {
                    let start = nums[0];
                    let end = nums[1];
                    let step = if nums.len() >= 3 && nums[2] > 0 {
                        nums[2]
                    } else {
                        1
                    };
                    let mut n = start;
                    while n <= end {
                        set.push(n);
                        n += step;
                    }
                } else {
                    for &id in &nums {
                        set.push(id);
                    }
                    set.extend(named_refs);
                }
            }

            "ELSET" => {
                let name = params
                    .get("ELSET")
                    .cloned()
                    .unwrap_or_default()
                    .to_uppercase();
                if name.is_empty() {
                    continue;
                }
                let set = elem_sets.entry(name).or_default();
                let has_generate = params.contains_key("GENERATE");
                let nums: Vec<usize> = parts.iter().filter_map(|s| parse_usize(s)).collect();
                if has_generate && nums.len() >= 2 {
                    let start = nums[0];
                    let end = nums[1];
                    let step = if nums.len() >= 3 && nums[2] > 0 {
                        nums[2]
                    } else {
                        1
                    };
                    let mut n = start;
                    while n <= end {
                        set.push(n);
                        n += step;
                    }
                } else {
                    for id in nums {
                        set.push(id);
                    }
                }
            }

            "ELASTIC" => {
                if let Some(ref mat_upper) = current_mat {
                    if let Some(mat) = mat_defs.get_mut(mat_upper) {
                        if parts.len() >= 2 {
                            mat.young = parse_f64(parts[0]).unwrap_or(0.0);
                            mat.poisson = parse_f64(parts[1]).unwrap_or(0.0);
                        }
                    }
                }
            }

            "DENSITY" => {
                if let Some(ref mat_upper) = current_mat {
                    if let Some(mat) = mat_defs.get_mut(mat_upper) {
                        mat.density = parse_f64(parts[0]).unwrap_or(0.0);
                    }
                }
            }

            "BOUNDARY" => {
                if parts.is_empty() {
                    continue;
                }
                let token = parts[0];
                let second = parts.get(1).copied().unwrap_or("").to_uppercase();

                if let Some(dofs) = builtin_dofs(&second) {
                    for node_id in resolve_nodes(token, &node_sets) {
                        for dof in &dofs {
                            constraints.push(InpConstraint {
                                node_id,
                                dof: *dof,
                                prescribed_value: 0.0,
                            });
                        }
                    }
                } else if parts.len() >= 3 {
                    let dof_start = parse_usize(parts[1]).unwrap_or(1).saturating_sub(1) as u8;
                    let dof_end = parse_usize(parts[2]).unwrap_or(1).saturating_sub(1) as u8;
                    let value = parts.get(3).and_then(|s| parse_f64(s)).unwrap_or(0.0);
                    for node_id in resolve_nodes(token, &node_sets) {
                        for dof in dof_start..=dof_end {
                            if dof <= 5 {
                                constraints.push(InpConstraint {
                                    node_id,
                                    dof,
                                    prescribed_value: value,
                                });
                            }
                        }
                    }
                }
            }

            "CLOAD" => {
                if parts.len() >= 3 {
                    let token = parts[0];
                    let dof = parse_usize(parts[1]).unwrap_or(1).saturating_sub(1) as u8;
                    let value = parse_f64(parts[2]).unwrap_or(0.0);
                    for node_id in resolve_nodes(token, &node_sets) {
                        if dof <= 5 {
                            loads.push(InpLoad {
                                node_id,
                                dof,
                                value,
                            });
                        }
                    }
                }
            }

            _ => {}
        }
    }

    // Flush any pending section with no data line
    if let Some(sec) = pending_section.take() {
        if !section_data_read {
            section_defs.push(sec);
        }
    }

    // ── Build materials ───────────────────────────────────────────────────────
    let mut materials: Vec<InpMaterial> = Vec::new();
    let mut mat_name_to_id: BTreeMap<String, usize> = BTreeMap::new();
    let mut mat_id = 1usize;
    for (upper, def) in &mat_defs {
        materials.push(InpMaterial {
            id: mat_id,
            name: def.name.clone(),
            young: def.young,
            poisson: def.poisson,
            density: def.density,
        });
        mat_name_to_id.insert(upper.clone(), mat_id);
        mat_id += 1;
    }

    // ── Build properties from section defs ────────────────────────────────────
    let mut properties: Vec<InpProperty> = Vec::new();
    let mut elset_to_prop_id: BTreeMap<String, usize> = BTreeMap::new();
    let mut prop_id = 1usize;

    for sec in &section_defs {
        let Some(&mid) = mat_name_to_id.get(&sec.mat_name) else {
            log::warn!(
                "INP: section references unknown material '{}' — skipping",
                sec.mat_name
            );
            continue;
        };

        // Refine hint from actual element types in this elset
        let hint = elem_sets
            .get(&sec.elset)
            .and_then(|ids| ids.first().and_then(|id| elem_hints.get(id).copied()))
            .unwrap_or(sec.hint);

        let (kind, plane_formulation) = match hint {
            "plane_stress" => ("PLPLANE", Some("PlaneStress".to_owned())),
            "plane_strain" => ("PLPLANE", Some("PlaneStrain".to_owned())),
            "shell" => ("PSHELL", None),
            "beam" => ("PBAR", None),
            _ => ("PSOLID", None),
        };

        elset_to_prop_id.insert(sec.elset.clone(), prop_id);
        properties.push(InpProperty {
            id: prop_id,
            kind: kind.to_owned(),
            material_id: mid,
            thickness: sec.thickness,
            plane_formulation,
        });
        prop_id += 1;
    }

    // Fall-back property when no sections were defined
    if properties.is_empty() && !materials.is_empty() {
        properties.push(InpProperty {
            id: 1,
            kind: "PSOLID".to_owned(),
            material_id: materials[0].id,
            thickness: None,
            plane_formulation: None,
        });
        for key in elem_sets.keys() {
            elset_to_prop_id.insert(key.clone(), 1);
        }
    }

    // ── Assign property IDs to elements (O(E + total_set_size)) ──────────────
    let mut elem_to_prop: BTreeMap<usize, usize> = BTreeMap::new();
    for (elset_name, pid) in &elset_to_prop_id {
        for &eid in elem_sets.get(elset_name).unwrap_or(&vec![]) {
            elem_to_prop.insert(eid, *pid);
        }
    }
    let fallback_pid = properties.first().map_or(1, |p| p.id);
    for el in &mut elements {
        el.property_id = *elem_to_prop.get(&el.id).unwrap_or(&fallback_pid);
    }

    Ok(ParsedInp {
        model_name,
        nodes,
        elements,
        materials,
        properties,
        constraints,
        loads,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SINGLE_HEX: &str = r#"
*Heading
Single CHEXA8 patch test
*Node
1, 0.0, 0.0, 0.0
2, 1.0, 0.0, 0.0
3, 1.0, 1.0, 0.0
4, 0.0, 1.0, 0.0
5, 0.0, 0.0, 1.0
6, 1.0, 0.0, 1.0
7, 1.0, 1.0, 1.0
8, 0.0, 1.0, 1.0
*Element, type=C3D8R, elset=All
1, 1, 2, 3, 4, 5, 6, 7, 8
*Nset, Nset=Fixed
1, 2, 3, 4
*Material, name=Steel
*Elastic
210000000000., 0.3
*Density
7850.,
*Solid Section, elset=All, material=Steel
,
*Boundary
Fixed, 1, 3
*Step
*Static
*Cload
5, 2, -2500.
6, 2, -2500.
7, 2, -2500.
8, 2, -2500.
*End Step
"#;

    #[test]
    fn parses_model_name() {
        let m = parse_inp(SINGLE_HEX).unwrap();
        assert_eq!(m.model_name, "Single CHEXA8 patch test");
    }

    #[test]
    fn parses_nodes() {
        let m = parse_inp(SINGLE_HEX).unwrap();
        assert_eq!(m.nodes.len(), 8);
        let n1 = &m.nodes[0];
        assert_eq!(n1.id, 1);
        assert!((n1.x - 0.0).abs() < 1e-12);
        let n2 = &m.nodes[1];
        assert!((n2.x - 1.0).abs() < 1e-12);
    }

    #[test]
    fn parses_element_and_assigns_property() {
        let m = parse_inp(SINGLE_HEX).unwrap();
        assert_eq!(m.elements.len(), 1);
        let el = &m.elements[0];
        assert_eq!(el.kind, "CHEXA");
        assert_eq!(el.node_ids, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(el.property_id, 1);
    }

    #[test]
    fn parses_material() {
        let m = parse_inp(SINGLE_HEX).unwrap();
        assert_eq!(m.materials.len(), 1);
        let mat = &m.materials[0];
        assert_eq!(mat.name, "Steel");
        assert!((mat.young - 210e9).abs() < 1e3);
        assert!((mat.poisson - 0.3).abs() < 1e-9);
        assert!((mat.density - 7850.0).abs() < 1e-6);
    }

    #[test]
    fn parses_boundary_conditions() {
        let m = parse_inp(SINGLE_HEX).unwrap();
        // 4 nodes × 3 DOF = 12 constraints
        assert_eq!(m.constraints.len(), 12);
        assert!(m.constraints.iter().all(|c| c.prescribed_value == 0.0));
    }

    #[test]
    fn parses_loads() {
        let m = parse_inp(SINGLE_HEX).unwrap();
        assert_eq!(m.loads.len(), 4);
        let total: f64 = m.loads.iter().map(|l| l.value).sum();
        assert!((total + 10000.0).abs() < 1e-6);
    }

    #[test]
    fn downconverts_c3d10_to_ctetra4() {
        let inp = r#"
*Node
1, 0.,0.,0.
2, 1.,0.,0.
3, 0.,1.,0.
4, 0.,0.,1.
5, 0.5,0.,0.
6, 0.5,0.5,0.
7, 0.,0.5,0.
8, 0.,0.,0.5
9, 0.5,0.,0.5
10, 0.,0.5,0.5
*Element, type=C3D10, elset=All
1, 1,2,3,4,5,6,7,8,9,10
*Material, name=M
*Elastic
1.,0.3
*Solid Section, elset=All, material=M
,
"#;
        let m = parse_inp(inp).unwrap();
        let el = &m.elements[0];
        assert_eq!(el.kind, "CTETRA");
        assert_eq!(el.node_ids, vec![1, 2, 3, 4]); // only corner nodes
    }

    #[test]
    fn parses_2d_nodes() {
        let inp = "*Node\n1, 0.0, 0.0\n2, 1.0, 0.0\n";
        let m = parse_inp(inp).unwrap();
        assert_eq!(m.nodes.len(), 2);
        assert!((m.nodes[0].z).abs() < 1e-12);
        assert!((m.nodes[1].z).abs() < 1e-12);
    }

    #[test]
    fn nset_generate() {
        let inp = "*Nset, Nset=All, generate\n1, 9, 1\n*Boundary\nAll, 1, 3\n";
        let m = parse_inp(inp).unwrap();
        assert_eq!(m.constraints.len(), 9 * 3);
    }

    #[test]
    fn encastre_builtin() {
        let inp = "*Nset, Nset=Fixed\n1, 2\n*Boundary\nFixed, ENCASTRE\n";
        let m = parse_inp(inp).unwrap();
        // 2 nodes × 6 DOF
        assert_eq!(m.constraints.len(), 12);
    }
}
