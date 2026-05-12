use crate::elements::ElementType;
use crate::material::IsotropicElastic;
use crate::property::PropertyCard;
use alloc::vec::Vec;

#[derive(Debug, Clone)]
pub struct Node {
    pub id: usize,
    pub coords: [f64; 3],
}

#[derive(Debug, Clone)]
pub struct Element {
    pub id: usize,
    pub element_type: ElementType,
    pub node_ids: Vec<usize>,
    pub material_id: usize,
    pub property_id: usize,
}

#[derive(Debug, Default)]
pub struct Mesh {
    pub nodes: Vec<Node>,
    pub elements: Vec<Element>,
    pub materials: Vec<(usize, IsotropicElastic)>,
    pub properties: Vec<(usize, PropertyCard)>,
}

impl Mesh {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, id: usize, x: f64, y: f64, z: f64) -> usize {
        self.nodes.push(Node {
            id,
            coords: [x, y, z],
        });
        id
    }

    pub fn add_element(
        &mut self,
        id: usize,
        element_type: ElementType,
        node_ids: Vec<usize>,
        material_id: usize,
        property_id: usize,
    ) -> usize {
        self.elements.push(Element {
            id,
            element_type,
            node_ids,
            material_id,
            property_id,
        });
        id
    }

    pub fn add_material(&mut self, id: usize, material: IsotropicElastic) {
        self.materials.push((id, material));
    }

    pub fn add_property(&mut self, id: usize, property: PropertyCard) {
        self.properties.push((id, property));
    }

    pub fn find_material(&self, id: usize) -> Option<&IsotropicElastic> {
        self.materials.iter().find(|(mid, _)| *mid == id).map(|(_, m)| m)
    }

    pub fn find_property(&self, id: usize) -> Option<&PropertyCard> {
        self.properties.iter().find(|(pid, _)| *pid == id).map(|(_, p)| p)
    }

    pub fn find_node_idx(&self, id: usize) -> Option<usize> {
        self.nodes.iter().position(|n| n.id == id)
    }

    pub fn n_dof(&self) -> usize {
        self.nodes.len() * 6
    }
}
