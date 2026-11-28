// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// The Mesh entry: its settings, the mesh it made, what a failed mesh found
// wrong with the geometry, and the notices after a mesh changes the model.
export const meshMessages = defineMessages({
  noGeometryToRemesh: {
    en: "This mesh has no geometry, so it cannot be re-meshed. Import the STEP file to mesh it again.",
    de: "Dieses Netz hat keine Geometrie und kann daher nicht neu erzeugt werden. Importieren Sie die STEP-Datei, um es erneut zu vernetzen.",
    fr: "Ce maillage n'a pas de géométrie et ne peut donc pas être régénéré. Importez le fichier STEP pour le mailler à nouveau.",
    it: "Questa mesh non ha geometria, quindi non può essere rigenerata. Importa il file STEP per generarla di nuovo.",
    es: "Esta malla no tiene geometría, así que no se puede volver a mallar. Importa el archivo STEP para mallarla de nuevo.",
    pt: "Esta malha não tem geometria, então não pode ser gerada de novo. Importe o arquivo STEP para gerá-la novamente.",
  },
  noMesh: {
    en: "No mesh — import a STEP file to mesh.",
    de: "Kein Netz – importieren Sie eine STEP-Datei zum Vernetzen.",
    fr: "Aucun maillage — importez un fichier STEP pour mailler.",
    it: "Nessuna mesh — importa un file STEP per generarla.",
    es: "Sin malla: importa un archivo STEP para mallar.",
    pt: "Sem malha — importe um arquivo STEP para gerar a malha.",
  },
  ok: {
    en: "OK",
    de: "OK",
    fr: "OK",
    it: "OK",
    es: "Aceptar",
    pt: "OK",
  },
  nodes: {
    en: "Nodes",
    de: "Knoten",
    fr: "Nœuds",
    it: "Nodi",
    es: "Nodos",
    pt: "Nós",
  },
  elements: {
    en: "Elements",
    de: "Elemente",
    fr: "Éléments",
    it: "Elementi",
    es: "Elementos",
    pt: "Elementos",
  },
  madeWith: {
    en: "Made with",
    de: "Erstellt mit",
    fr: "Créé avec",
    it: "Creata con",
    es: "Creada con",
    pt: "Gerada com",
  },
  sizes: {
    en: (max: string, min: string) => `max ${max} mm, min ${min} mm`,
    de: (max: string, min: string) => `max. ${max} mm, min. ${min} mm`,
    fr: (max: string, min: string) => `max ${max} mm, min ${min} mm`,
    it: (max: string, min: string) => `max ${max} mm, min ${min} mm`,
    es: (max: string, min: string) => `máx. ${max} mm, mín. ${min} mm`,
    pt: (max: string, min: string) => `máx. ${max} mm, mín. ${min} mm`,
  },
  maxSize: {
    en: (size: string) => `max ${size} mm`,
    de: (size: string) => `max. ${size} mm`,
    fr: (size: string) => `max ${size} mm`,
    it: (size: string) => `max ${size} mm`,
    es: (size: string) => `máx. ${size} mm`,
    pt: (size: string) => `máx. ${size} mm`,
  },
  editElementSize: {
    en: (name: string) => `Edit the element size of ${name}`,
    de: (name: string) => `Elementgröße von ${name} bearbeiten`,
    fr: (name: string) => `Modifier la taille d'élément de ${name}`,
    it: (name: string) => `Modifica la dimensione degli elementi di ${name}`,
    es: (name: string) => `Editar el tamaño de elemento de ${name}`,
    pt: (name: string) => `Editar o tamanho de elemento de ${name}`,
  },
  meshSettings: {
    en: "Mesh settings",
    de: "Netzeinstellungen",
    fr: "Réglages du maillage",
    it: "Impostazioni mesh",
    es: "Ajustes de malla",
    pt: "Configurações de malha",
  },
  modelExtent: {
    en: (extent: string) => `Model extent ${extent} mm`,
    de: (extent: string) => `Modellabmessungen ${extent} mm`,
    fr: (extent: string) => `Encombrement du modèle ${extent} mm`,
    it: (extent: string) => `Ingombro del modello ${extent} mm`,
    es: (extent: string) => `Dimensiones del modelo ${extent} mm`,
    pt: (extent: string) => `Dimensões do modelo ${extent} mm`,
  },
  elementEstimate: {
    en: (estimate: string) => ` · ≈${estimate} elements`,
    de: (estimate: string) => ` · ≈${estimate} Elemente`,
    fr: (estimate: string) => ` · ≈${estimate} éléments`,
    it: (estimate: string) => ` · ≈${estimate} elementi`,
    es: (estimate: string) => ` · ≈${estimate} elementos`,
    pt: (estimate: string) => ` · ≈${estimate} elementos`,
  },
  maxElementSize: {
    en: "Max element size",
    de: "Max. Elementgröße",
    fr: "Taille max. d'élément",
    it: "Dimensione max elemento",
    es: "Tamaño máx. de elemento",
    pt: "Tamanho máx. do elemento",
  },
  maxElementSizeTip: {
    en: "Upper bound on the element size, in mm. Any positive value is allowed — size it to the part, not to a fixed range.",
    de: "Obergrenze der Elementgröße in mm. Jeder positive Wert ist erlaubt – wählen Sie ihn passend zum Bauteil, nicht nach einem festen Bereich.",
    fr: "Borne supérieure de la taille d'élément, en mm. Toute valeur positive est admise — adaptez-la à la pièce, pas à une plage fixe.",
    it: "Limite superiore della dimensione degli elementi, in mm. È ammesso qualsiasi valore positivo — dimensionalo sul pezzo, non su un intervallo fisso.",
    es: "Límite superior del tamaño de elemento, en mm. Se admite cualquier valor positivo: ajústalo a la pieza, no a un rango fijo.",
    pt: "Limite superior do tamanho do elemento, em mm. Qualquer valor positivo é permitido — dimensione pela peça, não por uma faixa fixa.",
  },
  applyToAllBodies: {
    en: "Apply to all bodies",
    de: "Auf alle Körper anwenden",
    fr: "Appliquer à tous les corps",
    it: "Applica a tutti i corpi",
    es: "Aplicar a todos los cuerpos",
    pt: "Aplicar a todos os corpos",
  },
  applyToAllBodiesTip: {
    en: "Clear the max element size each body and region sets, so the whole model uses this one.",
    de: "Löscht die max. Elementgröße, die einzelne Körper und Bereiche festlegen, sodass das ganze Modell diese verwendet.",
    fr: "Efface la taille max. d'élément définie par chaque corps et région, pour que tout le modèle utilise celle-ci.",
    it: "Cancella la dimensione max degli elementi impostata da ogni corpo e regione, così tutto il modello usa questa.",
    es: "Borra el tamaño máx. de elemento que fija cada cuerpo y región, para que todo el modelo use este.",
    pt: "Apaga o tamanho máx. do elemento definido por cada corpo e região, para que o modelo inteiro use este.",
  },
  changesSolids: {
    en: (count: number, noun: string, names: string) =>
      `⚠ Changes ${count} ${noun}: ${names}.`,
    de: (count: number, noun: string, names: string) =>
      `⚠ Ändert ${count} ${noun}: ${names}.`,
    fr: (count: number, noun: string, names: string) =>
      `⚠ Modifie ${count} ${noun} : ${names}.`,
    it: (count: number, noun: string, names: string) =>
      `⚠ Modifica ${count} ${noun}: ${names}.`,
    es: (count: number, noun: string, names: string) =>
      `⚠ Cambia ${count} ${noun}: ${names}.`,
    pt: (count: number, noun: string, names: string) =>
      `⚠ Altera ${count} ${noun}: ${names}.`,
  },
  andMore: {
    en: (count: number) => ` and ${count} more`,
    de: (count: number) => ` und ${count} weitere`,
    fr: (count: number) => ` et ${count} de plus`,
    it: (count: number) => ` e altri ${count}`,
    es: (count: number) => ` y ${count} más`,
    pt: (count: number) => ` e mais ${count}`,
  },
  oneBody: {
    en: "body",
    de: "Körper",
    fr: "corps",
    it: "corpo",
    es: "cuerpo",
    pt: "corpo",
  },
  severalBodies: {
    en: "bodies",
    de: "Körper",
    fr: "corps",
    it: "corpi",
    es: "cuerpos",
    pt: "corpos",
  },
  oneRegion: {
    en: "region",
    de: "Bereich",
    fr: "région",
    it: "regione",
    es: "región",
    pt: "região",
  },
  severalRegions: {
    en: "regions",
    de: "Bereiche",
    fr: "régions",
    it: "regioni",
    es: "regiones",
    pt: "regiões",
  },
  bodiesAndRegions: {
    en: "bodies and regions",
    de: "Körper und Bereiche",
    fr: "corps et régions",
    it: "corpi e regioni",
    es: "cuerpos y regiones",
    pt: "corpos e regiões",
  },
  minElementSize: {
    en: "Min element size",
    de: "Min. Elementgröße",
    fr: "Taille min. d'élément",
    it: "Dimensione min elemento",
    es: "Tamaño mín. de elemento",
    pt: "Tamanho mín. do elemento",
  },
  minElementSizeTip: {
    en: "Floor for curvature-driven refinement, in mm. 0 lets Netgen refine fillets without limit.",
    de: "Untergrenze für die krümmungsabhängige Verfeinerung in mm. Mit 0 verfeinert Netgen Verrundungen unbegrenzt.",
    fr: "Plancher du raffinement piloté par la courbure, en mm. 0 laisse Netgen raffiner les congés sans limite.",
    it: "Limite inferiore per il raffinamento guidato dalla curvatura, in mm. Con 0 Netgen raffina i raccordi senza limite.",
    es: "Límite inferior del refinamiento por curvatura, en mm. Con 0, Netgen refina los redondeos sin límite.",
    pt: "Limite inferior do refinamento por curvatura, em mm. Com 0, o Netgen refina os arredondamentos sem limite.",
  },
  elementOrder: {
    en: "Element order",
    de: "Elementordnung",
    fr: "Ordre des éléments",
    it: "Ordine degli elementi",
    es: "Orden de elemento",
    pt: "Ordem do elemento",
  },
  elementOrderTip: {
    en: "Applied when solving — changing it needs no new mesh.",
    de: "Wird beim Lösen angewendet – eine Änderung braucht kein neues Netz.",
    fr: "Appliqué à la résolution — le changer ne demande pas de nouveau maillage.",
    it: "Applicato alla risoluzione — cambiarlo non richiede una nuova mesh.",
    es: "Se aplica al resolver: cambiarlo no requiere una malla nueva.",
    pt: "Aplicada ao resolver — mudá-la não exige uma nova malha.",
  },
  linear: {
    en: "Linear (1st order)",
    de: "Linear (1. Ordnung)",
    fr: "Linéaire (1er ordre)",
    it: "Lineare (1° ordine)",
    es: "Lineal (1.er orden)",
    pt: "Linear (1ª ordem)",
  },
  quadratic: {
    en: "Quadratic (2nd order)",
    de: "Quadratisch (2. Ordnung)",
    fr: "Quadratique (2e ordre)",
    it: "Quadratico (2° ordine)",
    es: "Cuadrático (2.º orden)",
    pt: "Quadrático (2ª ordem)",
  },
  sizesChanged: {
    en: (sizes: string) =>
      `Regenerate to apply the new sizes — the current mesh was made with ${sizes}.`,
    de: (sizes: string) =>
      `Neu erzeugen, um die neuen Größen anzuwenden – das aktuelle Netz wurde mit ${sizes} erstellt.`,
    fr: (sizes: string) =>
      `Régénérez pour appliquer les nouvelles tailles — le maillage actuel a été créé avec ${sizes}.`,
    it: (sizes: string) =>
      `Rigenera per applicare le nuove dimensioni — la mesh attuale è stata creata con ${sizes}.`,
    es: (sizes: string) =>
      `Regenera para aplicar los nuevos tamaños: la malla actual se creó con ${sizes}.`,
    pt: (sizes: string) =>
      `Gere de novo para aplicar os novos tamanhos — a malha atual foi gerada com ${sizes}.`,
  },
  bodiesChanged: {
    en: "Regenerate to match the bodies — one was suppressed or restored after this mesh was made.",
    de: "Neu erzeugen, um den Körpern zu entsprechen – einer wurde nach dem Erstellen dieses Netzes unterdrückt oder wiederhergestellt.",
    fr: "Régénérez pour correspondre aux corps — l'un d'eux a été supprimé ou rétabli après la création de ce maillage.",
    it: "Rigenera per allinearti ai corpi — uno è stato soppresso o ripristinato dopo la creazione di questa mesh.",
    es: "Regenera para que coincida con los cuerpos: uno se suprimió o restauró después de crear esta malla.",
    pt: "Gere de novo para corresponder aos corpos — um foi suprimido ou restaurado depois que esta malha foi gerada.",
  },
  meshing: {
    en: "Meshing…",
    de: "Vernetze…",
    fr: "Maillage…",
    it: "Generazione mesh…",
    es: "Mallando…",
    pt: "Gerando malha…",
  },
  regenerateMesh: {
    en: "⟳ Regenerate mesh",
    de: "⟳ Netz neu erzeugen",
    fr: "⟳ Régénérer le maillage",
    it: "⟳ Rigenera mesh",
    es: "⟳ Regenerar malla",
    pt: "⟳ Gerar malha de novo",
  },
  generateMesh: {
    en: "▶  Generate mesh",
    de: "▶  Netz erzeugen",
    fr: "▶  Générer le maillage",
    it: "▶  Genera mesh",
    es: "▶  Generar malla",
    pt: "▶  Gerar malha",
  },
  hingeWarning: {
    en: (lines: number) =>
      `Geometric singularity detected (hinge): the part pinches to zero thickness along ${lines === 1 ? "a line" : `${lines} lines`}, so it can't be meshed. Highlighted in the view.`,
    de: (lines: number) =>
      `Geometrische Singularität erkannt (Scharnier): Das Teil verjüngt sich ${lines === 1 ? "entlang einer Linie" : `entlang ${lines} Linien`} auf null Dicke und kann daher nicht vernetzt werden. In der Ansicht hervorgehoben.`,
    fr: (lines: number) =>
      `Singularité géométrique détectée (charnière) : la pièce se réduit à une épaisseur nulle le long ${lines === 1 ? "d'une ligne" : `de ${lines} lignes`} et ne peut donc pas être maillée. Mise en évidence dans la vue.`,
    it: (lines: number) =>
      `Singolarità geometrica rilevata (cerniera): il pezzo si assottiglia a spessore nullo lungo ${lines === 1 ? "una linea" : `${lines} linee`}, quindi non può essere meshato. Evidenziata nella vista.`,
    es: (lines: number) =>
      `Singularidad geométrica detectada (bisagra): la pieza se estrecha hasta espesor cero a lo largo de ${lines === 1 ? "una línea" : `${lines} líneas`}, así que no se puede mallar. Resaltada en la vista.`,
    pt: (lines: number) =>
      `Singularidade geométrica detectada (dobradiça): a peça se estreita até espessura zero ao longo de ${lines === 1 ? "uma linha" : `${lines} linhas`}, então não pode receber malha. Destacada na vista.`,
  },
  repairWidth: {
    en: "Repair width",
    de: "Reparaturbreite",
    fr: "Largeur de réparation",
    it: "Larghezza riparazione",
    es: "Ancho de reparación",
    pt: "Largura do reparo",
  },
  repairWidthTip: {
    en: "Width of the repair across the line, in mm.",
    de: "Breite der Reparatur quer zur Linie in mm.",
    fr: "Largeur de la réparation en travers de la ligne, en mm.",
    it: "Larghezza della riparazione trasversale alla linea, in mm.",
    es: "Ancho de la reparación a través de la línea, en mm.",
    pt: "Largura do reparo transversal à linha, em mm.",
  },
  separate: {
    en: "Separate",
    de: "Trennen",
    fr: "Séparer",
    it: "Separa",
    es: "Separar",
    pt: "Separar",
  },
  separateTip: {
    en: "Cut a small gap along the line. Removes a little material.",
    de: "Schneidet einen kleinen Spalt entlang der Linie. Entfernt etwas Material.",
    fr: "Découpe un petit espace le long de la ligne. Enlève un peu de matière.",
    it: "Taglia una piccola fessura lungo la linea. Toglie un po' di materiale.",
    es: "Corta una pequeña ranura a lo largo de la línea. Quita un poco de material.",
    pt: "Corta uma pequena fenda ao longo da linha. Remove um pouco de material.",
  },
  connect: {
    en: "Connect",
    de: "Verbinden",
    fr: "Relier",
    it: "Collega",
    es: "Conectar",
    pt: "Conectar",
  },
  connectTip: {
    en: "Weld the two sides along the line. Adds a little material.",
    de: "Verschweißt beide Seiten entlang der Linie. Fügt etwas Material hinzu.",
    fr: "Soude les deux côtés le long de la ligne. Ajoute un peu de matière.",
    it: "Salda i due lati lungo la linea. Aggiunge un po' di materiale.",
    es: "Suelda los dos lados a lo largo de la línea. Añade un poco de material.",
    pt: "Solda os dois lados ao longo da linha. Adiciona um pouco de material.",
  },
  coneWarning: {
    en: (cones: number) =>
      cones === 1
        ? "The mesher can't handle a sharp cone tip here, highlighted in the view. Splitting the face fixes this without changing the shape."
        : `The mesher can't handle ${cones} sharp cone tips here, highlighted in the view. Splitting the faces fixes this without changing the shape.`,
    de: (cones: number) =>
      cones === 1
        ? "Der Vernetzer kann hier eine spitze Kegelspitze nicht verarbeiten (in der Ansicht hervorgehoben). Das Teilen der Fläche behebt das, ohne die Form zu ändern."
        : `Der Vernetzer kann hier ${cones} spitze Kegelspitzen nicht verarbeiten (in der Ansicht hervorgehoben). Das Teilen der Flächen behebt das, ohne die Form zu ändern.`,
    fr: (cones: number) =>
      cones === 1
        ? "Le mailleur ne sait pas traiter une pointe de cône aiguë ici, mise en évidence dans la vue. Découper la face corrige cela sans changer la forme."
        : `Le mailleur ne sait pas traiter ${cones} pointes de cône aiguës ici, mises en évidence dans la vue. Découper les faces corrige cela sans changer la forme.`,
    it: (cones: number) =>
      cones === 1
        ? "Il generatore di mesh non gestisce qui una punta di cono acuminata, evidenziata nella vista. Dividere la faccia risolve senza cambiare la forma."
        : `Il generatore di mesh non gestisce qui ${cones} punte di cono acuminate, evidenziate nella vista. Dividere le facce risolve senza cambiare la forma.`,
    es: (cones: number) =>
      cones === 1
        ? "El mallador no puede con una punta de cono afilada aquí, resaltada en la vista. Dividir la cara lo soluciona sin cambiar la forma."
        : `El mallador no puede con ${cones} puntas de cono afiladas aquí, resaltadas en la vista. Dividir las caras lo soluciona sin cambiar la forma.`,
    pt: (cones: number) =>
      cones === 1
        ? "O gerador de malha não consegue tratar uma ponta de cone aguda aqui, destacada na vista. Dividir a face resolve isso sem mudar a forma."
        : `O gerador de malha não consegue tratar ${cones} pontas de cone agudas aqui, destacadas na vista. Dividir as faces resolve isso sem mudar a forma.`,
  },
  splitFaces: {
    en: (faces: number): string => (faces === 1 ? "Split face" : "Split faces"),
    de: (faces: number) => (faces === 1 ? "Fläche teilen" : "Flächen teilen"),
    fr: (faces: number) =>
      faces === 1 ? "Découper la face" : "Découper les faces",
    it: (faces: number) => (faces === 1 ? "Dividi faccia" : "Dividi facce"),
    es: (faces: number) => (faces === 1 ? "Dividir cara" : "Dividir caras"),
    pt: (faces: number) => (faces === 1 ? "Dividir face" : "Dividir faces"),
  },
  unmeshedFaces: {
    en: (faces: number) =>
      `The mesher couldn't mesh ${faces} ${faces === 1 ? "face" : "faces"}, highlighted in the view`,
    de: (faces: number) =>
      faces === 1
        ? "Der Vernetzer konnte 1 Fläche nicht vernetzen, in der Ansicht hervorgehoben"
        : `Der Vernetzer konnte ${faces} Flächen nicht vernetzen, in der Ansicht hervorgehoben`,
    fr: (faces: number) =>
      faces === 1
        ? "Le mailleur n'a pas pu mailler 1 face, mise en évidence dans la vue"
        : `Le mailleur n'a pas pu mailler ${faces} faces, mises en évidence dans la vue`,
    it: (faces: number) =>
      faces === 1
        ? "Il generatore di mesh non è riuscito a meshare 1 faccia, evidenziata nella vista"
        : `Il generatore di mesh non è riuscito a meshare ${faces} facce, evidenziate nella vista`,
    es: (faces: number) =>
      faces === 1
        ? "El mallador no pudo mallar 1 cara, resaltada en la vista"
        : `El mallador no pudo mallar ${faces} caras, resaltadas en la vista`,
    pt: (faces: number) =>
      faces === 1
        ? "O gerador de malha não conseguiu gerar malha em 1 face, destacada na vista"
        : `O gerador de malha não conseguiu gerar malha em ${faces} faces, destacadas na vista`,
  },
  unmeshedWidth: {
    en: (faces: number, width: string) =>
      faces === 1 ? ` (${width} mm wide)` : ` (narrowest ${width} mm wide)`,
    de: (faces: number, width: string) =>
      faces === 1 ? ` (${width} mm breit)` : ` (schmalste ${width} mm breit)`,
    fr: (faces: number, width: string) =>
      faces === 1
        ? ` (${width} mm de large)`
        : ` (la plus étroite : ${width} mm de large)`,
    it: (faces: number, width: string) =>
      faces === 1
        ? ` (larga ${width} mm)`
        : ` (la più stretta larga ${width} mm)`,
    es: (faces: number, width: string) =>
      faces === 1
        ? ` (${width} mm de ancho)`
        : ` (la más estrecha, ${width} mm de ancho)`,
    pt: (faces: number, width: string) =>
      faces === 1
        ? ` (${width} mm de largura)`
        : ` (a mais estreita com ${width} mm de largura)`,
  },
  narrowerThanMin: {
    en: (faces: number): string =>
      faces === 1
        ? "It is narrower than the minimum element size."
        : "They are narrower than the minimum element size.",
    de: (faces: number) =>
      faces === 1
        ? "Sie ist schmaler als die minimale Elementgröße."
        : "Sie sind schmaler als die minimale Elementgröße.",
    fr: (faces: number) =>
      faces === 1
        ? "Elle est plus étroite que la taille minimale d'élément."
        : "Elles sont plus étroites que la taille minimale d'élément.",
    it: (faces: number) =>
      faces === 1
        ? "È più stretta della dimensione minima degli elementi."
        : "Sono più strette della dimensione minima degli elementi.",
    es: (faces: number) =>
      faces === 1
        ? "Es más estrecha que el tamaño mínimo de elemento."
        : "Son más estrechas que el tamaño mínimo de elemento.",
    pt: (faces: number) =>
      faces === 1
        ? "Ela é mais estreita que o tamanho mínimo do elemento."
        : "Elas são mais estreitas que o tamanho mínimo do elemento.",
  },
  trySmallerSize: {
    en: "Try a smaller element size.",
    de: "Versuchen Sie eine kleinere Elementgröße.",
    fr: "Essayez une taille d'élément plus petite.",
    it: "Prova una dimensione degli elementi più piccola.",
    es: "Prueba un tamaño de elemento más pequeño.",
    pt: "Tente um tamanho de elemento menor.",
  },
  removeNarrowFaces: {
    en: (faces: number) =>
      faces === 1 ? "Remove narrow face" : `Remove ${faces} narrow faces`,
    de: (faces: number) =>
      faces === 1
        ? "Schmale Fläche entfernen"
        : `${faces} schmale Flächen entfernen`,
    fr: (faces: number) =>
      faces === 1
        ? "Retirer la face étroite"
        : `Retirer ${faces} faces étroites`,
    it: (faces: number) =>
      faces === 1 ? "Rimuovi faccia stretta" : `Rimuovi ${faces} facce strette`,
    es: (faces: number) =>
      faces === 1 ? "Quitar cara estrecha" : `Quitar ${faces} caras estrechas`,
    pt: (faces: number) =>
      faces === 1
        ? "Remover face estreita"
        : `Remover ${faces} faces estreitas`,
  },
  removeNarrowFacesTip: {
    en: "Extend the surrounding faces to close the gap.",
    de: "Verlängert die umliegenden Flächen, um die Lücke zu schließen.",
    fr: "Prolonge les faces voisines pour combler l'espace.",
    it: "Estende le facce circostanti per chiudere la fessura.",
    es: "Extiende las caras de alrededor para cerrar el hueco.",
    pt: "Estende as faces ao redor para fechar a fenda.",
  },
  removeNarrowFacesNote: {
    en: "Changes the shape by about the face width, which can affect results right next to it. If that detail matters, fix it in CAD.",
    de: "Ändert die Form etwa um die Flächenbreite, was Ergebnisse direkt daneben beeinflussen kann. Ist dieses Detail wichtig, beheben Sie es im CAD.",
    fr: "Modifie la forme d'environ la largeur de la face, ce qui peut influencer les résultats juste à côté. Si ce détail compte, corrigez-le dans la CAO.",
    it: "Cambia la forma di circa la larghezza della faccia, il che può influire sui risultati subito accanto. Se quel dettaglio conta, correggilo nel CAD.",
    es: "Cambia la forma aproximadamente en el ancho de la cara, lo que puede afectar a los resultados justo al lado. Si ese detalle importa, corrígelo en el CAD.",
    pt: "Muda a forma em cerca da largura da face, o que pode afetar os resultados logo ao lado. Se esse detalhe importa, corrija no CAD.",
  },
  surfaceOverlap: {
    en: (places: number) =>
      `The surface mesh overlaps itself in ${places} ${places === 1 ? "place" : "places"}, highlighted in the view. Simplify the geometry there in CAD and re-import.`,
    de: (places: number) =>
      places === 1
        ? "Das Oberflächennetz überlappt sich an 1 Stelle, in der Ansicht hervorgehoben. Vereinfachen Sie die Geometrie dort im CAD und importieren Sie sie erneut."
        : `Das Oberflächennetz überlappt sich an ${places} Stellen, in der Ansicht hervorgehoben. Vereinfachen Sie die Geometrie dort im CAD und importieren Sie sie erneut.`,
    fr: (places: number) =>
      places === 1
        ? "Le maillage surfacique se chevauche à 1 endroit, mis en évidence dans la vue. Simplifiez la géométrie à cet endroit dans la CAO et réimportez."
        : `Le maillage surfacique se chevauche à ${places} endroits, mis en évidence dans la vue. Simplifiez la géométrie à ces endroits dans la CAO et réimportez.`,
    it: (places: number) =>
      places === 1
        ? "La mesh di superficie si sovrappone a sé stessa in 1 punto, evidenziato nella vista. Semplifica lì la geometria nel CAD e reimporta."
        : `La mesh di superficie si sovrappone a sé stessa in ${places} punti, evidenziati nella vista. Semplifica lì la geometria nel CAD e reimporta.`,
    es: (places: number) =>
      places === 1
        ? "La malla de superficie se solapa consigo misma en 1 lugar, resaltado en la vista. Simplifica ahí la geometría en el CAD y vuelve a importarla."
        : `La malla de superficie se solapa consigo misma en ${places} lugares, resaltados en la vista. Simplifica ahí la geometría en el CAD y vuelve a importarla.`,
    pt: (places: number) =>
      places === 1
        ? "A malha de superfície se sobrepõe em 1 lugar, destacado na vista. Simplifique a geometria ali no CAD e importe de novo."
        : `A malha de superfície se sobrepõe em ${places} lugares, destacados na vista. Simplifique a geometria ali no CAD e importe de novo.`,
  },
  logs: {
    en: "LOGS",
    de: "PROTOKOLL",
    fr: "JOURNAL",
    it: "LOG",
    es: "REGISTRO",
    pt: "REGISTRO",
  },
  waiting: {
    en: "Waiting…",
    de: "Warte…",
    fr: "En attente…",
    it: "In attesa…",
    es: "Esperando…",
    pt: "Aguardando…",
  },
  noGeometryToMesh: {
    en: "Cannot mesh: this model has no geometry to mesh on. Import a STEP file to mesh it.",
    de: "Vernetzen nicht möglich: Dieses Modell hat keine Geometrie. Importieren Sie eine STEP-Datei, um sie zu vernetzen.",
    fr: "Maillage impossible : ce modèle n'a pas de géométrie à mailler. Importez un fichier STEP pour le mailler.",
    it: "Impossibile generare la mesh: questo modello non ha geometria. Importa un file STEP per generarla.",
    es: "No se puede mallar: este modelo no tiene geometría que mallar. Importa un archivo STEP para mallarlo.",
    pt: "Não é possível gerar a malha: este modelo não tem geometria. Importe um arquivo STEP para gerar a malha.",
  },
  noStepFile: {
    en: "Cannot mesh: the original STEP file is no longer available (e.g. after loading a saved analysis). Re-import the STEP file to mesh.",
    de: "Vernetzen nicht möglich: Die ursprüngliche STEP-Datei ist nicht mehr verfügbar (z. B. nach dem Laden einer gespeicherten Analyse). Importieren Sie die STEP-Datei erneut, um zu vernetzen.",
    fr: "Maillage impossible : le fichier STEP d'origine n'est plus disponible (par ex. après l'ouverture d'une analyse enregistrée). Réimportez le fichier STEP pour mailler.",
    it: "Impossibile generare la mesh: il file STEP originale non è più disponibile (ad es. dopo aver aperto un'analisi salvata). Importa di nuovo il file STEP per generarla.",
    es: "No se puede mallar: el archivo STEP original ya no está disponible (p. ej., tras abrir un análisis guardado). Vuelve a importar el archivo STEP para mallar.",
    pt: "Não é possível gerar a malha: o arquivo STEP original não está mais disponível (por exemplo, depois de abrir uma análise salva). Importe o arquivo STEP novamente para gerar a malha.",
  },
  volumeMeshFailed: {
    en: (detail: string) => `Volume meshing failed: ${detail}`,
    de: (detail: string) => `Volumenvernetzung fehlgeschlagen: ${detail}`,
    fr: (detail: string) => `Échec du maillage volumique : ${detail}`,
    it: (detail: string) =>
      `Generazione della mesh di volume non riuscita: ${detail}`,
    es: (detail: string) => `Falló el mallado de volumen: ${detail}`,
    pt: (detail: string) => `Falha na geração da malha de volume: ${detail}`,
  },
  faceSizes: {
    en: "Face sizes",
    de: "Flächengrößen",
    fr: "Tailles par face",
    it: "Dimensioni per faccia",
    es: "Tamaños por cara",
    pt: "Tamanhos por face",
  },
  faceSizesHint: {
    en: "Mesh picked faces finer; the mesh grades out to the body size.",
    de: "Gewählte Flächen feiner vernetzen; das Netz wird zur Körpergröße hin gröber.",
    fr: "Mailler plus finement les faces choisies ; le maillage s'élargit vers la taille du corps.",
    it: "Mesh più fine sulle facce scelte; la mesh si allarga fino alla dimensione del corpo.",
    es: "Malla más fina en las caras elegidas; la malla crece hasta el tamaño del cuerpo.",
    pt: "Malha mais fina nas faces escolhidas; a malha cresce até o tamanho do corpo.",
  },
  pickFaces: {
    en: "Pick faces",
    de: "Flächen wählen",
    fr: "Choisir des faces",
    it: "Scegli facce",
    es: "Elegir caras",
    pt: "Escolher faces",
  },
  stopPickingFaces: {
    en: "Stop picking",
    de: "Auswahl beenden",
    fr: "Arrêter la sélection",
    it: "Termina selezione",
    es: "Terminar selección",
    pt: "Parar seleção",
  },
  facesPicked: {
    en: (n: number) => (n === 1 ? "1 face picked" : `${n} faces picked`),
    de: (n: number) => (n === 1 ? "1 Fläche gewählt" : `${n} Flächen gewählt`),
    fr: (n: number) => (n === 1 ? "1 face choisie" : `${n} faces choisies`),
    it: (n: number) => (n === 1 ? "1 faccia scelta" : `${n} facce scelte`),
    es: (n: number) => (n === 1 ? "1 cara elegida" : `${n} caras elegidas`),
    pt: (n: number) => (n === 1 ? "1 face escolhida" : `${n} faces escolhidas`),
  },
  clickFacesToPick: {
    en: "Click faces in the view.",
    de: "Flächen in der Ansicht anklicken.",
    fr: "Cliquez sur des faces dans la vue.",
    it: "Fai clic sulle facce nella vista.",
    es: "Haz clic en caras de la vista.",
    pt: "Clique em faces na vista.",
  },
  setFaceSize: {
    en: "Set size",
    de: "Größe setzen",
    fr: "Appliquer la taille",
    it: "Imposta dimensione",
    es: "Aplicar tamaño",
    pt: "Aplicar tamanho",
  },
  faceSizeTip: {
    en: "Max element size on the picked faces, in mm",
    de: "Max. Elementgröße auf den gewählten Flächen, in mm",
    fr: "Taille max. d'élément sur les faces choisies, en mm",
    it: "Dimensione max degli elementi sulle facce scelte, in mm",
    es: "Tamaño máx. de elemento en las caras elegidas, en mm",
    pt: "Tamanho máx. de elemento nas faces escolhidas, em mm",
  },
  faceList: {
    en: (n: number, ids: string) => (n === 1 ? `Face ${ids}` : `Faces ${ids}`),
    de: (n: number, ids: string) =>
      n === 1 ? `Fläche ${ids}` : `Flächen ${ids}`,
    fr: (n: number, ids: string) => (n === 1 ? `Face ${ids}` : `Faces ${ids}`),
    it: (n: number, ids: string) =>
      n === 1 ? `Faccia ${ids}` : `Facce ${ids}`,
    es: (n: number, ids: string) => (n === 1 ? `Cara ${ids}` : `Caras ${ids}`),
    pt: (n: number, ids: string) => (n === 1 ? `Face ${ids}` : `Faces ${ids}`),
  },
  removeFaceSize: {
    en: (faces: string) => `Remove the element size of ${faces}`,
    de: (faces: string) => `Elementgröße von ${faces} entfernen`,
    fr: (faces: string) => `Retirer la taille d'élément de ${faces}`,
    it: (faces: string) => `Rimuovi la dimensione degli elementi di ${faces}`,
    es: (faces: string) => `Quitar el tamaño de elemento de ${faces}`,
    pt: (faces: string) => `Remover o tamanho de elemento de ${faces}`,
  },
  noFacePicked: {
    en: "No face picked: pick the faces to size first.",
    de: "Keine Fläche gewählt: Wählen Sie zuerst die Flächen.",
    fr: "Aucune face choisie : choisissez d'abord les faces.",
    it: "Nessuna faccia scelta: scegli prima le facce.",
    es: "Ninguna cara elegida: elige primero las caras.",
    pt: "Nenhuma face escolhida: escolha primeiro as faces.",
  },
  faceSizeInvalid: {
    en: (typed: string) =>
      `Face size ${typed} mm: an element size must be a positive number of mm.`,
    de: (typed: string) =>
      `Flächengröße ${typed} mm: Eine Elementgröße muss eine positive Zahl in mm sein.`,
    fr: (typed: string) =>
      `Taille de face ${typed} mm : une taille d'élément doit être un nombre positif en mm.`,
    it: (typed: string) =>
      `Dimensione della faccia ${typed} mm: una dimensione degli elementi deve essere un numero positivo in mm.`,
    es: (typed: string) =>
      `Tamaño de cara ${typed} mm: un tamaño de elemento debe ser un número positivo en mm.`,
    pt: (typed: string) =>
      `Tamanho de face ${typed} mm: um tamanho de elemento deve ser um número positivo em mm.`,
  },
  minExceedsFaceSize: {
    en: (min: number, faces: string, size: number) =>
      `Min element size (${min} mm) must not exceed the element size of ${faces} (${size} mm).`,
    de: (min: number, faces: string, size: number) =>
      `Die min. Elementgröße (${min} mm) darf die Elementgröße von ${faces} (${size} mm) nicht überschreiten.`,
    fr: (min: number, faces: string, size: number) =>
      `La taille min. d'élément (${min} mm) ne doit pas dépasser la taille d'élément de ${faces} (${size} mm).`,
    it: (min: number, faces: string, size: number) =>
      `La dimensione min degli elementi (${min} mm) non deve superare la dimensione degli elementi di ${faces} (${size} mm).`,
    es: (min: number, faces: string, size: number) =>
      `El tamaño mín. de elemento (${min} mm) no debe superar el tamaño de elemento de ${faces} (${size} mm).`,
    pt: (min: number, faces: string, size: number) =>
      `O tamanho mín. de elemento (${min} mm) não deve exceder o tamanho de elemento de ${faces} (${size} mm).`,
  },
  maxSizeInvalid: {
    en: (typed: string) =>
      `Max element size must be a positive number of mm — got "${typed}".`,
    de: (typed: string) =>
      `Die max. Elementgröße muss eine positive Zahl in mm sein – eingegeben: „${typed}“.`,
    fr: (typed: string) =>
      `La taille max. d'élément doit être un nombre positif en mm — saisi : « ${typed} ».`,
    it: (typed: string) =>
      `La dimensione max degli elementi deve essere un numero positivo in mm — inserito "${typed}".`,
    es: (typed: string) =>
      `El tamaño máx. de elemento debe ser un número positivo en mm; se introdujo "${typed}".`,
    pt: (typed: string) =>
      `O tamanho máx. do elemento deve ser um número positivo em mm — foi digitado "${typed}".`,
  },
  minSizeInvalid: {
    en: (typed: string) =>
      `Min element size must be 0 or a positive number of mm — got "${typed}".`,
    de: (typed: string) =>
      `Die min. Elementgröße muss 0 oder eine positive Zahl in mm sein – eingegeben: „${typed}“.`,
    fr: (typed: string) =>
      `La taille min. d'élément doit être 0 ou un nombre positif en mm — saisi : « ${typed} ».`,
    it: (typed: string) =>
      `La dimensione min degli elementi deve essere 0 o un numero positivo in mm — inserito "${typed}".`,
    es: (typed: string) =>
      `El tamaño mín. de elemento debe ser 0 o un número positivo en mm; se introdujo "${typed}".`,
    pt: (typed: string) =>
      `O tamanho mín. do elemento deve ser 0 ou um número positivo em mm — foi digitado "${typed}".`,
  },
  minExceedsMax: {
    en: (min: number, max: number) =>
      `Min element size (${min} mm) must not exceed max element size (${max} mm).`,
    de: (min: number, max: number) =>
      `Die min. Elementgröße (${min} mm) darf die max. Elementgröße (${max} mm) nicht überschreiten.`,
    fr: (min: number, max: number) =>
      `La taille min. d'élément (${min} mm) ne doit pas dépasser la taille max. d'élément (${max} mm).`,
    it: (min: number, max: number) =>
      `La dimensione min degli elementi (${min} mm) non deve superare la dimensione max (${max} mm).`,
    es: (min: number, max: number) =>
      `El tamaño mín. de elemento (${min} mm) no debe superar el tamaño máx. de elemento (${max} mm).`,
    pt: (min: number, max: number) =>
      `O tamanho mín. do elemento (${min} mm) não pode passar do tamanho máx. do elemento (${max} mm).`,
  },
  minExceedsRegionMax: {
    en: (min: number, solid: string, size: number) =>
      `Min element size (${min} mm) must not exceed the max element size of ${solid} (${size} mm).`,
    de: (min: number, solid: string, size: number) =>
      `Die min. Elementgröße (${min} mm) darf die max. Elementgröße von ${solid} (${size} mm) nicht überschreiten.`,
    fr: (min: number, solid: string, size: number) =>
      `La taille min. d'élément (${min} mm) ne doit pas dépasser la taille max. d'élément de ${solid} (${size} mm).`,
    it: (min: number, solid: string, size: number) =>
      `La dimensione min degli elementi (${min} mm) non deve superare la dimensione max di ${solid} (${size} mm).`,
    es: (min: number, solid: string, size: number) =>
      `El tamaño mín. de elemento (${min} mm) no debe superar el tamaño máx. de elemento de ${solid} (${size} mm).`,
    pt: (min: number, solid: string, size: number) =>
      `O tamanho mín. do elemento (${min} mm) não pode passar do tamanho máx. do elemento de ${solid} (${size} mm).`,
  },
  regionSizeInvalid: {
    en: (solid: string, typed: string) =>
      `The max element size of ${solid} must be a positive number of mm — got "${typed}".`,
    de: (solid: string, typed: string) =>
      `Die max. Elementgröße von ${solid} muss eine positive Zahl in mm sein – eingegeben: „${typed}“.`,
    fr: (solid: string, typed: string) =>
      `La taille max. d'élément de ${solid} doit être un nombre positif en mm — saisi : « ${typed} ».`,
    it: (solid: string, typed: string) =>
      `La dimensione max degli elementi di ${solid} deve essere un numero positivo in mm — inserito "${typed}".`,
    es: (solid: string, typed: string) =>
      `El tamaño máx. de elemento de ${solid} debe ser un número positivo en mm; se introdujo "${typed}".`,
    pt: (solid: string, typed: string) =>
      `O tamanho máx. do elemento de ${solid} deve ser um número positivo em mm — foi digitado "${typed}".`,
  },
  unconfirmedMaterial: {
    en: (count: number, bodies: string) =>
      count === 1
        ? `Choose the material of body ${bodies}: the mesh added it`
        : `Choose the materials of bodies ${bodies}: the mesh added them`,
    de: (count: number, bodies: string) =>
      count === 1
        ? `Wählen Sie den Werkstoff von Körper ${bodies}: Das Netz hat ihn hinzugefügt`
        : `Wählen Sie die Werkstoffe der Körper ${bodies}: Das Netz hat sie hinzugefügt`,
    fr: (count: number, bodies: string) =>
      count === 1
        ? `Choisissez le matériau du corps ${bodies} : le maillage l'a ajouté`
        : `Choisissez les matériaux des corps ${bodies} : le maillage les a ajoutés`,
    it: (count: number, bodies: string) =>
      count === 1
        ? `Scegli il materiale del corpo ${bodies}: l'ha aggiunto la mesh`
        : `Scegli i materiali dei corpi ${bodies}: li ha aggiunti la mesh`,
    es: (count: number, bodies: string) =>
      count === 1
        ? `Elige el material del cuerpo ${bodies}: lo añadió la malla`
        : `Elige los materiales de los cuerpos ${bodies}: los añadió la malla`,
    pt: (count: number, bodies: string) =>
      count === 1
        ? `Escolha o material do corpo ${bodies}: a malha o adicionou`
        : `Escolha os materiais dos corpos ${bodies}: a malha os adicionou`,
  },
  suppressedStillMeshed: {
    en: (solids: string) => `Re-mesh: suppressed ${solids} still in the mesh`,
    de: (solids: string) =>
      `Neu vernetzen: unterdrückt, aber noch im Netz: ${solids}`,
    fr: (solids: string) =>
      `Remailler : ${solids} supprimé mais encore dans le maillage`,
    it: (solids: string) =>
      `Rigenera la mesh: ${solids} soppresso ma ancora nella mesh`,
    es: (solids: string) =>
      `Volver a mallar: ${solids} suprimido sigue en la malla`,
    pt: (solids: string) =>
      `Gerar malha de novo: ${solids} suprimido ainda está na malha`,
  },
  restoredNotMeshed: {
    en: (solids: string) => `Re-mesh: restored ${solids} not in the mesh`,
    de: (solids: string) =>
      `Neu vernetzen: wiederhergestellt, aber nicht im Netz: ${solids}`,
    fr: (solids: string) =>
      `Remailler : ${solids} rétabli mais absent du maillage`,
    it: (solids: string) =>
      `Rigenera la mesh: ${solids} ripristinato ma non nella mesh`,
    es: (solids: string) =>
      `Volver a mallar: ${solids} restaurado no está en la malla`,
    pt: (solids: string) =>
      `Gerar malha de novo: ${solids} restaurado não está na malha`,
  },
  newBodies: {
    en: (count: number, bodies: string) =>
      count === 1
        ? `Meshing split the part: body ${bodies} is new — choose its material.`
        : `Meshing split the part: bodies ${bodies} are new — choose their materials.`,
    de: (count: number, bodies: string) =>
      count === 1
        ? `Die Vernetzung hat das Teil geteilt: Körper ${bodies} ist neu – wählen Sie seinen Werkstoff.`
        : `Die Vernetzung hat das Teil geteilt: Die Körper ${bodies} sind neu – wählen Sie ihre Werkstoffe.`,
    fr: (count: number, bodies: string) =>
      count === 1
        ? `Le maillage a divisé la pièce : le corps ${bodies} est nouveau — choisissez son matériau.`
        : `Le maillage a divisé la pièce : les corps ${bodies} sont nouveaux — choisissez leurs matériaux.`,
    it: (count: number, bodies: string) =>
      count === 1
        ? `La mesh ha diviso il pezzo: il corpo ${bodies} è nuovo — scegli il suo materiale.`
        : `La mesh ha diviso il pezzo: i corpi ${bodies} sono nuovi — scegli i loro materiali.`,
    es: (count: number, bodies: string) =>
      count === 1
        ? `El mallado dividió la pieza: el cuerpo ${bodies} es nuevo; elige su material.`
        : `El mallado dividió la pieza: los cuerpos ${bodies} son nuevos; elige sus materiales.`,
    pt: (count: number, bodies: string) =>
      count === 1
        ? `A geração da malha dividiu a peça: o corpo ${bodies} é novo — escolha o material dele.`
        : `A geração da malha dividiu a peça: os corpos ${bodies} são novos — escolha os materiais deles.`,
  },
  allSuppressed: {
    en: (bodies: string) =>
      `Every body of the mesh is suppressed (bodies ${bodies}) — nothing is left to analyse. Unsuppress at least one body.`,
    de: (bodies: string) =>
      `Alle Körper des Netzes sind unterdrückt (Körper ${bodies}) – es bleibt nichts zu berechnen. Heben Sie die Unterdrückung mindestens eines Körpers auf.`,
    fr: (bodies: string) =>
      `Tous les corps du maillage sont supprimés (corps ${bodies}) — il ne reste rien à calculer. Rétablissez au moins un corps.`,
    it: (bodies: string) =>
      `Tutti i corpi della mesh sono soppressi (corpi ${bodies}) — non resta nulla da analizzare. Ripristina almeno un corpo.`,
    es: (bodies: string) =>
      `Todos los cuerpos de la malla están suprimidos (cuerpos ${bodies}): no queda nada que analizar. Deja de suprimir al menos un cuerpo.`,
    pt: (bodies: string) =>
      `Todos os corpos da malha estão suprimidos (corpos ${bodies}) — não sobra nada para analisar. Deixe de suprimir pelo menos um corpo.`,
  },
  notOnShellRim: {
    en: (face: number) => `CAD face ${face} is not on the new mesh's shell rim`,
    de: (face: number) =>
      `CAD-Fläche ${face} liegt nicht auf dem Schalenrand des neuen Netzes`,
    fr: (face: number) =>
      `la face CAO ${face} n'est pas sur le bord de coque du nouveau maillage`,
    it: (face: number) =>
      `la faccia CAD ${face} non è sul bordo guscio della nuova mesh`,
    es: (face: number) =>
      `la cara CAD ${face} no está en el borde de lámina de la nueva malla`,
    pt: (face: number) =>
      `a face CAD ${face} não está na borda de casca da nova malha`,
  },
  notOnSurface: {
    en: (face: number) => `CAD face ${face} is not on the new mesh's surface`,
    de: (face: number) =>
      `CAD-Fläche ${face} liegt nicht auf der Oberfläche des neuen Netzes`,
    fr: (face: number) =>
      `la face CAO ${face} n'est pas sur la surface du nouveau maillage`,
    it: (face: number) =>
      `la faccia CAD ${face} non è sulla superficie della nuova mesh`,
    es: (face: number) =>
      `la cara CAD ${face} no está en la superficie de la nueva malla`,
    pt: (face: number) =>
      `a face CAD ${face} não está na superfície da nova malha`,
  },
  edgePick: {
    en: "an edge pick",
    de: "eine Kantenauswahl",
    fr: "une sélection d'arête",
    it: "una selezione di spigolo",
    es: "una selección de arista",
    pt: "uma seleção de aresta",
  },
  nodePick: {
    en: "a node pick",
    de: "eine Knotenauswahl",
    fr: "une sélection de nœud",
    it: "una selezione di nodo",
    es: "una selección de nodo",
    pt: "uma seleção de nó",
  },
  notWholeFace: {
    en: "not a whole CAD face",
    de: "keine ganze CAD-Fläche",
    fr: "pas une face CAO entière",
    it: "non un'intera faccia CAD",
    es: "no es una cara CAD completa",
    pt: "não é uma face CAD inteira",
  },
  droppedEntry: {
    en: (owner: string, entry: string, reason: string) =>
      `${owner} ${entry} (${reason})`,
    de: (owner: string, entry: string, reason: string) =>
      `${owner} ${entry} (${reason})`,
    fr: (owner: string, entry: string, reason: string) =>
      `${owner} ${entry} (${reason})`,
    it: (owner: string, entry: string, reason: string) =>
      `${owner} ${entry} (${reason})`,
    es: (owner: string, entry: string, reason: string) =>
      `${owner} ${entry} (${reason})`,
    pt: (owner: string, entry: string, reason: string) =>
      `${owner} ${entry} (${reason})`,
  },
  droppedReferencePoint: {
    en: (owner: string, entry: string, coupling: string) =>
      `${owner} ${entry} (the reference point of ${coupling}, which was cleared)`,
    de: (owner: string, entry: string, coupling: string) =>
      `${owner} ${entry} (der Referenzpunkt von ${coupling}, der gelöscht wurde)`,
    fr: (owner: string, entry: string, coupling: string) =>
      `${owner} ${entry} (le point de référence de ${coupling}, qui a été effacé)`,
    it: (owner: string, entry: string, coupling: string) =>
      `${owner} ${entry} (il punto di riferimento di ${coupling}, che è stato cancellato)`,
    es: (owner: string, entry: string, coupling: string) =>
      `${owner} ${entry} (el punto de referencia de ${coupling}, que se borró)`,
    pt: (owner: string, entry: string, coupling: string) =>
      `${owner} ${entry} (o ponto de referência de ${coupling}, que foi apagado)`,
  },
  nothingToGrip: {
    en: (coupling: string) => `${coupling} — nothing left to grip`,
    de: (coupling: string) => `${coupling} – nichts mehr zum Anbinden`,
    fr: (coupling: string) => `${coupling} — plus rien à saisir`,
    it: (coupling: string) => `${coupling} — non resta nulla da collegare`,
    es: (coupling: string) => `${coupling}: no queda nada que sujetar`,
    pt: (coupling: string) => `${coupling} — não sobrou nada para prender`,
  },
  nothingToApplyTo: {
    en: (group: string) => `${group} — nothing left to apply it to`,
    de: (group: string) => `${group} – nichts mehr, worauf sie wirken kann`,
    fr: (group: string) => `${group} — plus rien sur quoi l'appliquer`,
    it: (group: string) => `${group} — non resta nulla a cui applicarlo`,
    es: (group: string) => `${group}: no queda nada a lo que aplicarlo`,
    pt: (group: string) => `${group} — não sobrou nada onde aplicá-lo`,
  },
  tieSideA: {
    en: (tie: string) => `${tie} side A`,
    de: (tie: string) => `${tie} Seite A`,
    fr: (tie: string) => `${tie} côté A`,
    it: (tie: string) => `${tie} lato A`,
    es: (tie: string) => `${tie} lado A`,
    pt: (tie: string) => `${tie} lado A`,
  },
  tieSideB: {
    en: (tie: string) => `${tie} side B`,
    de: (tie: string) => `${tie} Seite B`,
    fr: (tie: string) => `${tie} côté B`,
    it: (tie: string) => `${tie} lato B`,
    es: (tie: string) => `${tie} lado B`,
    pt: (tie: string) => `${tie} lado B`,
  },
  nothingToTouch: {
    en: (contact: string) => `${contact} — a side has no face left to touch`,
    de: (contact: string) =>
      `${contact} — einer Seite bleibt keine Fläche zum Berühren`,
    fr: (contact: string) => `${contact} — un côté n'a plus de face à toucher`,
    it: (contact: string) => `${contact} — un lato non ha più facce da toccare`,
    es: (contact: string) =>
      `${contact} — a un lado no le queda cara que tocar`,
    pt: (contact: string) =>
      `${contact} — um lado não tem mais face para tocar`,
  },
  nothingToTie: {
    en: (tie: string) => `${tie} — a side has nothing left to tie`,
    de: (tie: string) => `${tie} – eine Seite hat nichts mehr zu verbinden`,
    fr: (tie: string) => `${tie} — un côté n'a plus rien à lier`,
    it: (tie: string) => `${tie} — a un lato non resta nulla da collegare`,
    es: (tie: string) => `${tie}: a un lado no le queda nada que unir`,
    pt: (tie: string) => `${tie} — um lado não tem mais nada para ligar`,
  },
  keptGroups: {
    en: (groups: number) =>
      `${groups} support/load/tie group${groups === 1 ? "" : "s"}`,
    de: (groups: number) =>
      groups === 1
        ? "1 Lagerungs-/Last-/Verbindungsgruppe"
        : `${groups} Lagerungs-/Last-/Verbindungsgruppen`,
    fr: (groups: number) =>
      groups === 1
        ? "1 groupe d'appuis/charges/liaisons"
        : `${groups} groupes d'appuis/charges/liaisons`,
    it: (groups: number) =>
      groups === 1
        ? "1 gruppo di vincoli/carichi/tie"
        : `${groups} gruppi di vincoli/carichi/tie`,
    es: (groups: number) =>
      groups === 1
        ? "1 grupo de apoyo/carga/unión"
        : `${groups} grupos de apoyo/carga/unión`,
    pt: (groups: number) =>
      groups === 1
        ? "1 grupo de apoio/carga/ligação"
        : `${groups} grupos de apoio/carga/ligação`,
  },
  keptCouplings: {
    en: (couplings: number) =>
      `${couplings} coupling${couplings === 1 ? "" : "s"}`,
    de: (couplings: number) =>
      couplings === 1 ? "1 Kopplung" : `${couplings} Kopplungen`,
    fr: (couplings: number) =>
      couplings === 1 ? "1 couplage" : `${couplings} couplages`,
    it: (couplings: number) =>
      couplings === 1 ? "1 accoppiamento" : `${couplings} accoppiamenti`,
    es: (couplings: number) =>
      couplings === 1 ? "1 acoplamiento" : `${couplings} acoplamientos`,
    pt: (couplings: number) =>
      couplings === 1 ? "1 acoplamento" : `${couplings} acoplamentos`,
  },
  keptOnFaces: {
    en: (groups: string) => `Kept ${groups} on their CAD faces.`,
    de: (groups: string) => `${groups} auf ihren CAD-Flächen beibehalten.`,
    fr: (groups: string) => `${groups} conservé(s) sur leurs faces CAO.`,
    it: (groups: string) => `Mantenuti ${groups} sulle loro facce CAD.`,
    es: (groups: string) => `Se mantuvieron ${groups} en sus caras CAD.`,
    pt: (groups: string) => `Mantidos ${groups} nas suas faces CAD.`,
  },
  keptAndKept: {
    en: (groups: string, couplings: string) => `${groups} and ${couplings}`,
    de: (groups: string, couplings: string) => `${groups} und ${couplings}`,
    fr: (groups: string, couplings: string) => `${groups} et ${couplings}`,
    it: (groups: string, couplings: string) => `${groups} e ${couplings}`,
    es: (groups: string, couplings: string) => `${groups} y ${couplings}`,
    pt: (groups: string, couplings: string) => `${groups} e ${couplings}`,
  },
  noGroupKept: {
    en: "No group could be kept on the new mesh.",
    de: "Keine Gruppe konnte auf das neue Netz übernommen werden.",
    fr: "Aucun groupe n'a pu être conservé sur le nouveau maillage.",
    it: "Nessun gruppo ha potuto essere mantenuto sulla nuova mesh.",
    es: "No se pudo mantener ningún grupo en la nueva malla.",
    pt: "Nenhum grupo pôde ser mantido na nova malha.",
  },
  pickAgain: {
    en: (kept: string, dropped: string) =>
      `${kept} Cleared — pick again: ${dropped}.`,
    de: (kept: string, dropped: string) =>
      `${kept} Gelöscht – neu auswählen: ${dropped}.`,
    fr: (kept: string, dropped: string) =>
      `${kept} Effacés — à resélectionner : ${dropped}.`,
    it: (kept: string, dropped: string) =>
      `${kept} Cancellati — seleziona di nuovo: ${dropped}.`,
    es: (kept: string, dropped: string) =>
      `${kept} Borrados; vuelve a seleccionar: ${dropped}.`,
    pt: (kept: string, dropped: string) =>
      `${kept} Apagados — selecione de novo: ${dropped}.`,
  },
  meanEdge: {
    en: "Mean edge",
    de: "Mittl. Kante",
    fr: "Arête moyenne",
    it: "Lato medio",
    es: "Arista media",
    pt: "Aresta média",
  },
  meanEdgeTip: {
    en: "Mean length of the element edges in this body's mesh. On thin walls it is far below the max size.",
    de: "Mittlere Länge der Elementkanten im Netz dieses Körpers. An dünnen Wänden liegt sie weit unter der max. Größe.",
    fr: "Longueur moyenne des arêtes des éléments du maillage de ce corps. Sur les parois minces, elle est bien inférieure à la taille max.",
    it: "Lunghezza media dei lati degli elementi nella mesh di questo corpo. Sulle pareti sottili è molto inferiore alla dimensione max.",
    es: "Longitud media de las aristas de los elementos en la malla de este cuerpo. En paredes delgadas queda muy por debajo del tamaño máx.",
    pt: "Comprimento médio das arestas dos elementos na malha deste corpo. Em paredes finas fica bem abaixo do tamanho máx.",
  },
  currentMeanEdge: {
    en: (edge: string) => `Current mesh: mean edge ${edge} mm`,
    de: (edge: string) => `Aktuelles Netz: mittlere Kante ${edge} mm`,
    fr: (edge: string) => `Maillage actuel : arête moyenne ${edge} mm`,
    it: (edge: string) => `Mesh attuale: lato medio ${edge} mm`,
    es: (edge: string) => `Malla actual: arista media ${edge} mm`,
    pt: (edge: string) => `Malha atual: aresta média ${edge} mm`,
  },
  volume: {
    en: "Volume",
    de: "Volumen",
    fr: "Volume",
    it: "Volume",
    es: "Volumen",
    pt: "Volume",
  },
  mass: {
    en: "Mass",
    de: "Masse",
    fr: "Masse",
    it: "Massa",
    es: "Masa",
    pt: "Massa",
  },
  noDensity: {
    en: "No density",
    de: "Keine Dichte",
    fr: "Pas de masse volumique",
    it: "Nessuna densità",
    es: "Sin densidad",
    pt: "Sem densidade",
  },
  noDensityTip: {
    en: "This body's material has no density. Set one in Materials to see the mass.",
    de: "Der Werkstoff dieses Körpers hat keine Dichte. Legen Sie unter Werkstoffe eine fest, um die Masse zu sehen.",
    fr: "Le matériau de ce corps n'a pas de masse volumique. Définissez-en une dans Matériaux pour voir la masse.",
    it: "Il materiale di questo corpo non ha densità. Impostala in Materiali per vedere la massa.",
    es: "El material de este cuerpo no tiene densidad. Defina una en Materiales para ver la masa.",
    pt: "O material deste corpo não tem densidade. Defina uma em Materiais para ver a massa.",
  },
  statisticsUnreadable: {
    en: (reason: string) => `Body statistics unavailable: ${reason}`,
    de: (reason: string) => `Körperwerte nicht verfügbar: ${reason}`,
    fr: (reason: string) => `Valeurs par corps indisponibles : ${reason}`,
    it: (reason: string) => `Valori per corpo non disponibili: ${reason}`,
    es: (reason: string) => `Valores por cuerpo no disponibles: ${reason}`,
    pt: (reason: string) => `Valores por corpo indisponíveis: ${reason}`,
  },
  statisticsUnknownNode: {
    en: (element: number, node: number) =>
      `element ${element} references node ${node}, which the mesh does not have`,
    de: (element: number, node: number) =>
      `Element ${element} verweist auf Knoten ${node}, den das Netz nicht hat`,
    fr: (element: number, node: number) =>
      `l'élément ${element} référence le nœud ${node}, absent du maillage`,
    it: (element: number, node: number) =>
      `l'elemento ${element} fa riferimento al nodo ${node}, che la mesh non ha`,
    es: (element: number, node: number) =>
      `el elemento ${element} hace referencia al nodo ${node}, que la malla no tiene`,
    pt: (element: number, node: number) =>
      `o elemento ${element} referencia o nó ${node}, que a malha não tem`,
  },
  statisticsUnknownProperty: {
    en: (element: number, property: number) =>
      `element ${element} belongs to body ${property}, which the model does not have`,
    de: (element: number, property: number) =>
      `Element ${element} gehört zu Körper ${property}, den das Modell nicht hat`,
    fr: (element: number, property: number) =>
      `l'élément ${element} appartient au corps ${property}, absent du modèle`,
    it: (element: number, property: number) =>
      `l'elemento ${element} appartiene al corpo ${property}, che il modello non ha`,
    es: (element: number, property: number) =>
      `el elemento ${element} pertenece al cuerpo ${property}, que el modelo no tiene`,
    pt: (element: number, property: number) =>
      `o elemento ${element} pertence ao corpo ${property}, que o modelo não tem`,
  },
  statisticsNoThickness: {
    en: (element: number) =>
      `shell element ${element} has no thickness, so its volume is unknown`,
    de: (element: number) =>
      `Schalenelement ${element} hat keine Dicke, sein Volumen ist daher unbekannt`,
    fr: (element: number) =>
      `l'élément coque ${element} n'a pas d'épaisseur, son volume est donc inconnu`,
    it: (element: number) =>
      `l'elemento guscio ${element} non ha spessore, quindi il suo volume è ignoto`,
    es: (element: number) =>
      `el elemento lámina ${element} no tiene espesor, así que su volumen es desconocido`,
    pt: (element: number) =>
      `o elemento de casca ${element} não tem espessura, então seu volume é desconhecido`,
  },
});
