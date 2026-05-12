use crate::elements::ElementType;
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

    pub fn n_dof(&self) -> usize {
        self.nodes.len() * 6
    }
}
