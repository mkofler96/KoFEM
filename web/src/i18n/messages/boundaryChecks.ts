// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// Why a solve refuses a tie, coupling, load or material assignment the user
// can fix. Names stay in straight double quotes in every language: a problem
// report redacts quoted text (lib/feedback.ts).
export const boundaryChecksMessages = defineMessages({
  tieNodeMissing: {
    en: (tie: string, node: number) =>
      `Tie "${tie}" references node ${node}, which is not in the mesh — re-pick its surfaces after remeshing`,
    de: (tie: string, node: number) =>
      `Verbindung "${tie}" verweist auf Knoten ${node}, der nicht im Netz liegt – wählen Sie ihre Flächen nach dem Neuvernetzen erneut`,
    fr: (tie: string, node: number) =>
      `La liaison "${tie}" fait référence au nœud ${node}, absent du maillage — sélectionnez à nouveau ses surfaces après le remaillage`,
    it: (tie: string, node: number) =>
      `Il tie "${tie}" fa riferimento al nodo ${node}, che non è nella mesh — riseleziona le sue superfici dopo aver rigenerato la mesh`,
    es: (tie: string, node: number) =>
      `La unión "${tie}" hace referencia al nodo ${node}, que no está en la malla: vuelve a seleccionar sus superficies después de remallar`,
    pt: (tie: string, node: number) =>
      `A ligação "${tie}" faz referência ao nó ${node}, que não está na malha — selecione suas superfícies novamente depois de refazer a malha`,
  },
  tiePullsApart: {
    en: (tie: string, gap: string, problem: string) =>
      `Tie "${tie}" pulls nodes up to ${gap} mm apart together, which ${problem}. Tie surfaces that touch or nearly touch, or set the connection to a region with a search distance below the element size.`,
    de: (tie: string, gap: string, problem: string) =>
      `Verbindung "${tie}" zieht Knoten mit bis zu ${gap} mm Abstand zusammen und ${problem}. Verbinden Sie Flächen, die sich berühren oder fast berühren, oder beschränken Sie die Verbindung auf einen Bereich mit einem Suchabstand unter der Elementgröße.`,
    fr: (tie: string, gap: string, problem: string) =>
      `La liaison "${tie}" rapproche des nœuds distants jusqu'à ${gap} mm, ce qui ${problem}. Liez des surfaces qui se touchent ou presque, ou limitez la liaison à une région avec une distance de recherche inférieure à la taille des éléments.`,
    it: (tie: string, gap: string, problem: string) =>
      `Il tie "${tie}" avvicina nodi distanti fino a ${gap} mm, il che ${problem}. Unisci superfici che si toccano o quasi, oppure limita il collegamento a una regione con una distanza di ricerca inferiore alla dimensione degli elementi.`,
    es: (tie: string, gap: string, problem: string) =>
      `La unión "${tie}" junta nodos separados hasta ${gap} mm, lo que ${problem}. Une superficies que se tocan o casi se tocan, o limita la unión a una región con una distancia de búsqueda menor que el tamaño de elemento.`,
    pt: (tie: string, gap: string, problem: string) =>
      `A ligação "${tie}" aproxima nós distantes até ${gap} mm, o que ${problem}. Ligue superfícies que se tocam ou quase se tocam, ou limite a ligação a uma região com distância de busca menor que o tamanho do elemento.`,
  },
  tieCollapsesElement: {
    en: "merges two nodes of one element and collapses it to zero volume",
    de: "verschmilzt zwei Knoten eines Elements, das dadurch auf null Volumen zusammenfällt",
    fr: "fusionne deux nœuds d'un même élément et réduit son volume à zéro",
    it: "unisce due nodi dello stesso elemento e ne riduce il volume a zero",
    es: "fusiona dos nodos de un mismo elemento y reduce su volumen a cero",
    pt: "funde dois nós de um mesmo elemento e reduz seu volume a zero",
  },
  tieSharedFace: {
    en: "leaves an element face shared by three elements, so the mesh is no longer a valid solid",
    de: "lässt eine Elementfläche von drei Elementen geteilt zurück, sodass das Netz kein gültiges Volumen mehr ist",
    fr: "laisse une face d'élément partagée par trois éléments, si bien que le maillage n'est plus un volume valide",
    it: "lascia una faccia condivisa da tre elementi, quindi la mesh non è più un solido valido",
    es: "deja una cara de elemento compartida por tres elementos, así que la malla deja de ser un sólido válido",
    pt: "deixa uma face de elemento compartilhada por três elementos, de modo que a malha deixa de ser um sólido válido",
  },
  tieInsideOut: {
    en: "turns elements next to the weld inside out",
    de: "stülpt Elemente neben der Verschweißung um",
    fr: "retourne les éléments voisins de la soudure",
    it: "rovescia gli elementi vicini alla saldatura",
    es: "invierte los elementos junto a la soldadura",
    pt: "inverte os elementos junto à solda",
  },
  couplingGripsNothing: {
    en: (coupling: string) =>
      `Coupling "${coupling}" grips no node — pick the surface it couples to its reference point, or delete the coupling.`,
    de: (coupling: string) =>
      `Kopplung "${coupling}" erfasst keinen Knoten – wählen Sie die Fläche, die sie an ihren Referenzpunkt koppelt, oder löschen Sie die Kopplung.`,
    fr: (coupling: string) =>
      `Le couplage "${coupling}" ne saisit aucun nœud — sélectionnez la surface qu'il couple à son point de référence, ou supprimez le couplage.`,
    it: (coupling: string) =>
      `L'accoppiamento "${coupling}" non aggancia alcun nodo — seleziona la superficie che accoppia al suo punto di riferimento, o elimina l'accoppiamento.`,
    es: (coupling: string) =>
      `El acoplamiento "${coupling}" no sujeta ningún nodo: selecciona la superficie que acopla a su punto de referencia, o elimina el acoplamiento.`,
    pt: (coupling: string) =>
      `O acoplamento "${coupling}" não prende nenhum nó — selecione a superfície que ele acopla ao seu ponto de referência, ou exclua o acoplamento.`,
  },
  couplingTooFewNodes: {
    en: (coupling: string, count: number) =>
      `Coupling "${coupling}" is distributing but grips only ${count} node(s); an RBE3 average needs at least 3. Pick a larger surface, or make the coupling kinematic.`,
    de: (coupling: string, count: number) =>
      `Kopplung "${coupling}" ist verteilend, erfasst aber nur ${count} Knoten; eine RBE3-Mittelung braucht mindestens 3. Wählen Sie eine größere Fläche oder machen Sie die Kopplung kinematisch.`,
    fr: (coupling: string, count: number) =>
      `Le couplage "${coupling}" est distribué mais ne saisit que ${count} nœud(s) ; une moyenne RBE3 en demande au moins 3. Sélectionnez une surface plus grande, ou rendez le couplage cinématique.`,
    it: (coupling: string, count: number) =>
      `L'accoppiamento "${coupling}" è distribuito ma aggancia solo ${count} nodo/i; una media RBE3 ne richiede almeno 3. Seleziona una superficie più grande, o rendi l'accoppiamento cinematico.`,
    es: (coupling: string, count: number) =>
      `El acoplamiento "${coupling}" es distribuido pero solo sujeta ${count} nodo(s); un promedio RBE3 necesita al menos 3. Selecciona una superficie mayor o haz el acoplamiento cinemático.`,
    pt: (coupling: string, count: number) =>
      `O acoplamento "${coupling}" é distribuído, mas prende apenas ${count} nó(s); uma média RBE3 precisa de pelo menos 3. Selecione uma superfície maior ou torne o acoplamento cinemático.`,
  },
  couplingNoDof: {
    en: (coupling: string) =>
      `Coupling "${coupling}" is kinematic but ties no DOF at all — select at least one of Ux…Rz.`,
    de: (coupling: string) =>
      `Kopplung "${coupling}" ist kinematisch, koppelt aber keinen Freiheitsgrad – wählen Sie mindestens einen von Ux…Rz.`,
    fr: (coupling: string) =>
      `Le couplage "${coupling}" est cinématique mais ne lie aucun degré de liberté — sélectionnez-en au moins un parmi Ux…Rz.`,
    it: (coupling: string) =>
      `L'accoppiamento "${coupling}" è cinematico ma non vincola alcun grado di libertà — selezionane almeno uno tra Ux…Rz.`,
    es: (coupling: string) =>
      `El acoplamiento "${coupling}" es cinemático pero no vincula ningún grado de libertad: selecciona al menos uno de Ux…Rz.`,
    pt: (coupling: string) =>
      `O acoplamento "${coupling}" é cinemático, mas não vincula nenhum grau de liberdade — selecione pelo menos um entre Ux…Rz.`,
  },
  couplingOverlap: {
    en: (node: number, first: string, second: string) =>
      `Node ${node} is gripped by both kinematic couplings "${first}" and "${second}" — a DOF can be eliminated by only one constraint. Make one of them distributing, or pick surfaces that do not overlap.`,
    de: (node: number, first: string, second: string) =>
      `Knoten ${node} wird von beiden kinematischen Kopplungen "${first}" und "${second}" erfasst – ein Freiheitsgrad kann nur durch eine Zwangsbedingung eliminiert werden. Machen Sie eine davon verteilend oder wählen Sie Flächen, die sich nicht überlappen.`,
    fr: (node: number, first: string, second: string) =>
      `Le nœud ${node} est saisi par les deux couplages cinématiques "${first}" et "${second}" — un degré de liberté ne peut être éliminé que par une seule contrainte. Rendez l'un d'eux distribué, ou sélectionnez des surfaces qui ne se chevauchent pas.`,
    it: (node: number, first: string, second: string) =>
      `Il nodo ${node} è agganciato da entrambi gli accoppiamenti cinematici "${first}" e "${second}" — un grado di libertà può essere eliminato da un solo vincolo. Rendi uno dei due distribuito, o seleziona superfici che non si sovrappongono.`,
    es: (node: number, first: string, second: string) =>
      `El nodo ${node} está sujeto por los dos acoplamientos cinemáticos "${first}" y "${second}": un grado de libertad solo puede eliminarse con una restricción. Haz uno de ellos distribuido o selecciona superficies que no se solapen.`,
    pt: (node: number, first: string, second: string) =>
      `O nó ${node} é preso pelos dois acoplamentos cinemáticos "${first}" e "${second}" — um grau de liberdade só pode ser eliminado por uma restrição. Torne um deles distribuído ou selecione superfícies que não se sobreponham.`,
  },
  momentOnSolidNode: {
    en: (node: number, dof: number, value: number) =>
      `Node ${node} carries a moment (DOF ${dof} = ${value}), but it is a solid node with no rotational DOF, so the moment would be dropped. Apply the moment to a face, or couple the surface to a reference point and apply it there.`,
    de: (node: number, dof: number, value: number) =>
      `Knoten ${node} trägt ein Moment (FHG ${dof} = ${value}), ist aber ein Volumenknoten ohne Rotationsfreiheitsgrad, das Moment ginge verloren. Setzen Sie das Moment auf einer Fläche an oder koppeln Sie die Fläche an einen Referenzpunkt und setzen Sie es dort an.`,
    fr: (node: number, dof: number, value: number) =>
      `Le nœud ${node} porte un moment (DDL ${dof} = ${value}), mais c'est un nœud volumique sans degré de liberté en rotation, le moment serait perdu. Appliquez le moment sur une face, ou couplez la surface à un point de référence et appliquez-le à ce point.`,
    it: (node: number, dof: number, value: number) =>
      `Il nodo ${node} porta un momento (GDL ${dof} = ${value}), ma è un nodo solido senza gradi di libertà rotazionali, quindi il momento andrebbe perso. Applica il momento a una faccia, o accoppia la superficie a un punto di riferimento e applicalo lì.`,
    es: (node: number, dof: number, value: number) =>
      `El nodo ${node} tiene un momento (GDL ${dof} = ${value}), pero es un nodo sólido sin grados de libertad de rotación, así que el momento se perdería. Aplica el momento a una cara, o acopla la superficie a un punto de referencia y aplícalo ahí.`,
    pt: (node: number, dof: number, value: number) =>
      `O nó ${node} recebe um momento (GL ${dof} = ${value}), mas é um nó sólido sem grau de liberdade de rotação, então o momento seria perdido. Aplique o momento a uma face, ou acople a superfície a um ponto de referência e aplique-o ali.`,
  },
  oneMaterialPerDomain: {
    en: (domain: string, count: number, materials: string) =>
      `coupled solve: this path supports only one ${domain} material, but the ${domain} domain spans ${count} distinct materials (${materials}). Assign a single material to the ${domain} domain.`,
    de: (domain: string, count: number, materials: string) =>
      `Gekoppelte Lösung: Dieser Pfad unterstützt nur einen Werkstoff für ${domain}, der Bereich ${domain} umfasst aber ${count} verschiedene Werkstoffe (${materials}). Weisen Sie dem Bereich ${domain} einen einzigen Werkstoff zu.`,
    fr: (domain: string, count: number, materials: string) =>
      `Calcul couplé : ce chemin n'accepte qu'un seul matériau ${domain}, mais le domaine ${domain} compte ${count} matériaux distincts (${materials}). Affectez un seul matériau au domaine ${domain}.`,
    it: (domain: string, count: number, materials: string) =>
      `Calcolo accoppiato: questo percorso supporta un solo materiale ${domain}, ma il dominio ${domain} comprende ${count} materiali distinti (${materials}). Assegna un unico materiale al dominio ${domain}.`,
    es: (domain: string, count: number, materials: string) =>
      `Cálculo acoplado: esta vía admite un solo material de ${domain}, pero el dominio de ${domain} abarca ${count} materiales distintos (${materials}). Asigna un único material al dominio de ${domain}.`,
    pt: (domain: string, count: number, materials: string) =>
      `Cálculo acoplado: este caminho aceita apenas um material de ${domain}, mas o domínio de ${domain} abrange ${count} materiais distintos (${materials}). Atribua um único material ao domínio de ${domain}.`,
  },
  domainSolid: {
    en: "solid",
    de: "Volumen",
    fr: "volumique",
    it: "solido",
    es: "sólido",
    pt: "sólido",
  },
  domainShell: {
    en: "shell",
    de: "Schale",
    fr: "coque",
    it: "guscio",
    es: "lámina",
    pt: "casca",
  },
});
