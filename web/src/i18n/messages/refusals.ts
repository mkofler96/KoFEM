// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// Why a solve path or the optimizer refuses a model (lib/solve): a tie, an
// element order, a load or a temperature change it cannot apply, a body the
// supports leave loose, a wall too thin for its mesh. The Solve and Optimize
// panels show the same words before the run.
export const refusalMessages = defineMessages({
  namedTie: {
    en: (name: string) => `tie "${name}"`,
    de: (name: string) => `die Verbindung „${name}“`,
    fr: (name: string) => `la liaison « ${name} »`,
    it: (name: string) => `il vincolo tie "${name}"`,
    es: (name: string) => `la unión "${name}"`,
    pt: (name: string) => `a ligação "${name}"`,
  },
  namedTies: {
    en: (count: number, names: string) => `${count} ties (${names})`,
    de: (count: number, names: string) => `${count} Verbindungen (${names})`,
    fr: (count: number, names: string) => `${count} liaisons (${names})`,
    it: (count: number, names: string) => `${count} vincoli tie (${names})`,
    es: (count: number, names: string) => `${count} uniones (${names})`,
    pt: (count: number, names: string) => `${count} ligações (${names})`,
  },
  topOptTies: {
    en: (ties: string, count: number) =>
      `Topology optimization does not support ties yet, but this model has ${ties}. Delete ${count === 1 ? "it" : "them"} to optimize.`,
    de: (ties: string, count: number) =>
      `Die Topologieoptimierung unterstützt noch keine Verbindungen, dieses Modell hat aber ${ties}. Löschen Sie ${count === 1 ? "sie" : "diese"}, um zu optimieren.`,
    fr: (ties: string, count: number) =>
      `L'optimisation topologique ne prend pas encore en charge les liaisons, mais ce modèle a ${ties}. Supprimez-${count === 1 ? "la" : "les"} pour optimiser.`,
    it: (ties: string, count: number) =>
      `L'ottimizzazione topologica non supporta ancora i vincoli tie, ma questo modello ha ${ties}. ${count === 1 ? "Eliminalo" : "Eliminali"} per ottimizzare.`,
    es: (ties: string, count: number) =>
      `La optimización topológica aún no admite uniones, pero este modelo tiene ${ties}. ${count === 1 ? "Elimínala" : "Elimínalas"} para optimizar.`,
    pt: (ties: string, count: number) =>
      `A otimização topológica ainda não aceita ligações, mas este modelo tem ${ties}. ${count === 1 ? "Exclua-a" : "Exclua-as"} para otimizar.`,
  },
  shellTies: {
    en: (ties: string, count: number) =>
      `The shell solver does not support ties yet, but this model has ${ties}. Delete ${count === 1 ? "it" : "them"} to solve this shell model.`,
    de: (ties: string, count: number) =>
      `Der Schalenlöser unterstützt noch keine Verbindungen, dieses Modell hat aber ${ties}. Löschen Sie ${count === 1 ? "sie" : "diese"}, um dieses Schalenmodell zu lösen.`,
    fr: (ties: string, count: number) =>
      `Le solveur coque ne prend pas encore en charge les liaisons, mais ce modèle a ${ties}. Supprimez-${count === 1 ? "la" : "les"} pour résoudre ce modèle coque.`,
    it: (ties: string, count: number) =>
      `Il solutore a gusci non supporta ancora i vincoli tie, ma questo modello ha ${ties}. ${count === 1 ? "Eliminalo" : "Eliminali"} per risolvere questo modello a gusci.`,
    es: (ties: string, count: number) =>
      `El solucionador de láminas aún no admite uniones, pero este modelo tiene ${ties}. ${count === 1 ? "Elimínala" : "Elimínalas"} para resolver este modelo de láminas.`,
    pt: (ties: string, count: number) =>
      `O solucionador de cascas ainda não aceita ligações, mas este modelo tem ${ties}. ${count === 1 ? "Exclua-a" : "Exclua-as"} para resolver este modelo de cascas.`,
  },
  namedContact: {
    en: (name: string) => `contact "${name}"`,
    de: (name: string) => `den Kontakt „${name}“`,
    fr: (name: string) => `le contact « ${name} »`,
    it: (name: string) => `il contatto "${name}"`,
    es: (name: string) => `el contacto "${name}"`,
    pt: (name: string) => `o contato "${name}"`,
  },
  namedContacts: {
    en: (count: number, names: string) => `${count} contacts (${names})`,
    de: (count: number, names: string) => `${count} Kontakte (${names})`,
    fr: (count: number, names: string) => `${count} contacts (${names})`,
    it: (count: number, names: string) => `${count} contatti (${names})`,
    es: (count: number, names: string) => `${count} contactos (${names})`,
    pt: (count: number, names: string) => `${count} contatos (${names})`,
  },
  contactNotSolid: {
    en: (contacts: string, count: number) =>
      `Contact is solved on all-solid models only, without shells, bodies solved as shells or couplings, but this model has ${contacts}. Delete ${count === 1 ? "it" : "them"}, or solve every body as a solid without couplings.`,
    de: (contacts: string, count: number) =>
      `Kontakt wird nur in reinen Volumenmodellen ohne Schalen, als Schale gerechnete Körper oder Kopplungen gelöst, dieses Modell hat aber ${contacts}. Löschen Sie ${count === 1 ? "ihn" : "diese"}, oder rechnen Sie alle Körper als Volumen ohne Kopplungen.`,
    fr: (contacts: string, count: number) =>
      `Le contact n'est résolu que sur des modèles entièrement volumiques, sans coques, corps calculés en coque ni couplages, mais ce modèle a ${contacts}. Supprimez-${count === 1 ? "le" : "les"}, ou calculez tous les corps en volume sans couplages.`,
    it: (contacts: string, count: number) =>
      `Il contatto si risolve solo su modelli interamente solidi, senza gusci, corpi calcolati come gusci o accoppiamenti, ma questo modello ha ${contacts}. ${count === 1 ? "Eliminalo" : "Eliminali"}, oppure calcola tutti i corpi come solidi senza accoppiamenti.`,
    es: (contacts: string, count: number) =>
      `El contacto solo se resuelve en modelos totalmente sólidos, sin láminas, cuerpos calculados como lámina ni acoplamientos, pero este modelo tiene ${contacts}. ${count === 1 ? "Elimínalo" : "Elimínalos"}, o calcula todos los cuerpos como sólidos sin acoplamientos.`,
    pt: (contacts: string, count: number) =>
      `O contato só é resolvido em modelos totalmente sólidos, sem cascas, corpos calculados como casca ou acoplamentos, mas este modelo tem ${contacts}. ${count === 1 ? "Exclua-o" : "Exclua-os"}, ou calcule todos os corpos como sólidos sem acoplamentos.`,
  },
  contactOrder: {
    en: (contacts: string, order: number) =>
      `Contact is solved with linear elements only, but this model has ${contacts} and element order ${order} is selected. Set Element order to Linear in the Mesh panel.`,
    de: (contacts: string, order: number) =>
      `Kontakt wird nur mit linearen Elementen gelöst, dieses Modell hat aber ${contacts}, und gewählt ist Elementordnung ${order}. Stellen Sie im Netz-Bereich die Elementordnung auf Linear.`,
    fr: (contacts: string, order: number) =>
      `Le contact se résout uniquement avec des éléments linéaires, mais ce modèle a ${contacts} et l'ordre d'éléments ${order} est sélectionné. Réglez l'ordre des éléments sur Linéaire dans le panneau Maillage.`,
    it: (contacts: string, order: number) =>
      `Il contatto si risolve solo con elementi lineari, ma questo modello ha ${contacts} ed è selezionato l'ordine degli elementi ${order}. Imposta l'ordine degli elementi su Lineare nel pannello Mesh.`,
    es: (contacts: string, order: number) =>
      `El contacto se resuelve solo con elementos lineales, pero este modelo tiene ${contacts} y está seleccionado el orden de elementos ${order}. Ajusta el orden de los elementos a Lineal en el panel Malla.`,
    pt: (contacts: string, order: number) =>
      `O contato é resolvido apenas com elementos lineares, mas este modelo tem ${contacts} e a ordem de elementos ${order} está selecionada. Defina a ordem dos elementos como Linear no painel Malha.`,
  },
  largeDeformationNotSolid: {
    en: "Large deformation is solved on all-solid models only, without shells, bodies solved as shells or couplings. Turn off Large deformation in the solver settings, or solve every body as a solid without couplings.",
    de: "Große Verformungen werden nur in reinen Volumenmodellen ohne Schalen, als Schale gerechnete Körper oder Kopplungen gelöst. Schalten Sie Große Verformungen in den Löser-Einstellungen aus, oder rechnen Sie alle Körper als Volumen ohne Kopplungen.",
    fr: "Les grandes déformations ne se résolvent que sur des modèles entièrement volumiques, sans coques, corps calculés en coque ni couplages. Désactivez Grandes déformations dans les paramètres du solveur, ou calculez tous les corps en volume sans couplages.",
    it: "Le grandi deformazioni si risolvono solo su modelli interamente solidi, senza gusci, corpi calcolati come gusci o accoppiamenti. Disattiva Grandi deformazioni nelle impostazioni del solutore, oppure calcola tutti i corpi come solidi senza accoppiamenti.",
    es: "Las grandes deformaciones solo se resuelven en modelos totalmente sólidos, sin láminas, cuerpos calculados como lámina ni acoplamientos. Desactiva Grandes deformaciones en los ajustes del solucionador, o calcula todos los cuerpos como sólidos sin acoplamientos.",
    pt: "Grandes deformações são resolvidas apenas em modelos totalmente sólidos, sem cascas, corpos calculados como casca ou acoplamentos. Desative Grandes deformações nas configurações do solucionador, ou calcule todos os corpos como sólidos sem acoplamentos.",
  },
  largeDeformationContacts: {
    en: (contacts: string, count: number) =>
      `Large deformation cannot be combined with contact yet, but this model has ${contacts}. Turn off Large deformation in the solver settings, or delete ${count === 1 ? "it" : "them"}.`,
    de: (contacts: string, count: number) =>
      `Große Verformungen lassen sich noch nicht mit Kontakt kombinieren, dieses Modell hat aber ${contacts}. Schalten Sie Große Verformungen in den Löser-Einstellungen aus, oder löschen Sie ${count === 1 ? "ihn" : "diese"}.`,
    fr: (contacts: string, count: number) =>
      `Les grandes déformations ne se combinent pas encore avec le contact, mais ce modèle a ${contacts}. Désactivez Grandes déformations dans les paramètres du solveur, ou supprimez-${count === 1 ? "le" : "les"}.`,
    it: (contacts: string, count: number) =>
      `Le grandi deformazioni non si combinano ancora con il contatto, ma questo modello ha ${contacts}. Disattiva Grandi deformazioni nelle impostazioni del solutore, oppure ${count === 1 ? "eliminalo" : "eliminali"}.`,
    es: (contacts: string, count: number) =>
      `Las grandes deformaciones aún no se combinan con el contacto, pero este modelo tiene ${contacts}. Desactiva Grandes deformaciones en los ajustes del solucionador, o ${count === 1 ? "elimínalo" : "elimínalos"}.`,
    pt: (contacts: string, count: number) =>
      `Grandes deformações ainda não se combinam com contato, mas este modelo tem ${contacts}. Desative Grandes deformações nas configurações do solucionador, ou ${count === 1 ? "exclua-o" : "exclua-os"}.`,
  },
  largeDeformationTies: {
    en: (ties: string, count: number) =>
      `Large deformation cannot be combined with constraint ties yet, but this model has ${ties}. Turn off Large deformation in the solver settings, or delete ${count === 1 ? "it" : "them"}.`,
    de: (ties: string, count: number) =>
      `Große Verformungen lassen sich noch nicht mit Zwangsbedingungs-Verbindungen kombinieren, dieses Modell hat aber ${ties}. Schalten Sie Große Verformungen in den Löser-Einstellungen aus, oder löschen Sie ${count === 1 ? "sie" : "diese"}.`,
    fr: (ties: string, count: number) =>
      `Les grandes déformations ne se combinent pas encore avec les liaisons par contrainte, mais ce modèle a ${ties}. Désactivez Grandes déformations dans les paramètres du solveur, ou supprimez-${count === 1 ? "la" : "les"}.`,
    it: (ties: string, count: number) =>
      `Le grandi deformazioni non si combinano ancora con i vincoli di collegamento, ma questo modello ha ${ties}. Disattiva Grandi deformazioni nelle impostazioni del solutore, oppure ${count === 1 ? "eliminalo" : "eliminali"}.`,
    es: (ties: string, count: number) =>
      `Las grandes deformaciones aún no se combinan con uniones por restricción, pero este modelo tiene ${ties}. Desactiva Grandes deformaciones en los ajustes del solucionador, o ${count === 1 ? "elimínala" : "elimínalas"}.`,
    pt: (ties: string, count: number) =>
      `Grandes deformações ainda não se combinam com ligações por restrição, mas este modelo tem ${ties}. Desative Grandes deformações nas configurações do solucionador, ou ${count === 1 ? "exclua-a" : "exclua-as"}.`,
  },
  largeDeformationTemperature: {
    en: "Large deformation cannot be combined with a temperature change yet. Turn off Large deformation in the solver settings, or remove the temperature change.",
    de: "Große Verformungen lassen sich noch nicht mit einer Temperaturänderung kombinieren. Schalten Sie Große Verformungen in den Löser-Einstellungen aus, oder entfernen Sie die Temperaturänderung.",
    fr: "Les grandes déformations ne se combinent pas encore avec une variation de température. Désactivez Grandes déformations dans les paramètres du solveur, ou supprimez la variation de température.",
    it: "Le grandi deformazioni non si combinano ancora con una variazione di temperatura. Disattiva Grandi deformazioni nelle impostazioni del solutore, oppure rimuovi la variazione di temperatura.",
    es: "Las grandes deformaciones aún no se combinan con un cambio de temperatura. Desactiva Grandes deformaciones en los ajustes del solucionador, o quita el cambio de temperatura.",
    pt: "Grandes deformações ainda não se combinam com uma variação de temperatura. Desative Grandes deformações nas configurações do solucionador, ou remova a variação de temperatura.",
  },
  topOptLargeDeformation: {
    en: "Topology optimization is linear and does not take large deformation. Turn off Large deformation in the solver settings to optimize.",
    de: "Die Topologieoptimierung ist linear und berücksichtigt keine großen Verformungen. Schalten Sie Große Verformungen in den Löser-Einstellungen aus, um zu optimieren.",
    fr: "L'optimisation topologique est linéaire et ne prend pas en compte les grandes déformations. Désactivez Grandes déformations dans les paramètres du solveur pour optimiser.",
    it: "L'ottimizzazione topologica è lineare e non considera le grandi deformazioni. Disattiva Grandi deformazioni nelle impostazioni del solutore per ottimizzare.",
    es: "La optimización topológica es lineal y no admite grandes deformaciones. Desactiva Grandes deformaciones en los ajustes del solucionador para optimizar.",
    pt: "A otimização topológica é linear e não aceita grandes deformações. Desative Grandes deformações nas configurações do solucionador para otimizar.",
  },
  topOptContacts: {
    en: (contacts: string, count: number) =>
      `Topology optimization does not support contact yet, but this model has ${contacts}. Delete ${count === 1 ? "it" : "them"} to optimize.`,
    de: (contacts: string, count: number) =>
      `Die Topologieoptimierung unterstützt noch keinen Kontakt, dieses Modell hat aber ${contacts}. Löschen Sie ${count === 1 ? "ihn" : "diese"}, um zu optimieren.`,
    fr: (contacts: string, count: number) =>
      `L'optimisation topologique ne prend pas encore en charge le contact, mais ce modèle a ${contacts}. Supprimez-${count === 1 ? "le" : "les"} pour optimiser.`,
    it: (contacts: string, count: number) =>
      `L'ottimizzazione topologica non supporta ancora il contatto, ma questo modello ha ${contacts}. ${count === 1 ? "Eliminalo" : "Eliminali"} per ottimizzare.`,
    es: (contacts: string, count: number) =>
      `La optimización topológica aún no admite el contacto, pero este modelo tiene ${contacts}. ${count === 1 ? "Elimínalo" : "Elimínalos"} para optimizar.`,
    pt: (contacts: string, count: number) =>
      `A otimização topológica ainda não aceita contato, mas este modelo tem ${contacts}. ${count === 1 ? "Exclua-o" : "Exclua-os"} para otimizar.`,
  },
  shellOrder: {
    en: (order: number) =>
      `Shell and mixed shell/solid models solve with linear elements only, but element order ${order} is selected. Set Element order to Linear in the Mesh panel.`,
    de: (order: number) =>
      `Schalen- und gemischte Schalen-/Volumenmodelle werden nur mit linearen Elementen gelöst, gewählt ist aber Elementordnung ${order}. Stellen Sie im Netz-Bereich die Elementordnung auf Linear.`,
    fr: (order: number) =>
      `Les modèles coque et mixtes coque/volumique se résolvent uniquement avec des éléments linéaires, mais l'ordre d'éléments ${order} est sélectionné. Réglez l'ordre des éléments sur Linéaire dans le panneau Maillage.`,
    it: (order: number) =>
      `I modelli a gusci e misti gusci/solidi si risolvono solo con elementi lineari, ma è selezionato l'ordine degli elementi ${order}. Imposta l'ordine degli elementi su Lineare nel pannello Mesh.`,
    es: (order: number) =>
      `Los modelos de láminas y mixtos lámina/sólido se resuelven solo con elementos lineales, pero está seleccionado el orden de elementos ${order}. Ajusta el orden de los elementos a Lineal en el panel Malla.`,
    pt: (order: number) =>
      `Modelos de cascas e mistos casca/sólido são resolvidos apenas com elementos lineares, mas a ordem de elementos ${order} está selecionada. Defina a ordem dos elementos como Linear no painel Malha.`,
  },
  shellCoupling: {
    en: (count: number) =>
      `This model is all shell elements and declares ${count} surface-to-point coupling(s), which the shell solver cannot apply — a coupling needs the coupled solid-shell assembler, and that needs at least one solid body. Delete the coupling, or keep one body solid.`,
    de: (count: number) =>
      `Dieses Modell besteht nur aus Schalenelementen und hat ${count} Flächen-Punkt-Kopplung(en), die der Schalenlöser nicht anwenden kann – eine Kopplung braucht den gekoppelten Volumen-Schalen-Assembler, und dieser mindestens einen Volumenkörper. Löschen Sie die Kopplung oder lassen Sie einen Körper als Volumen.`,
    fr: (count: number) =>
      `Ce modèle ne contient que des éléments coque et déclare ${count} couplage(s) surface-point, que le solveur coque ne peut pas appliquer — un couplage exige l'assembleur couplé volumique-coque, qui exige au moins un corps volumique. Supprimez le couplage, ou gardez un corps volumique.`,
    it: (count: number) =>
      `Questo modello è composto solo da elementi guscio e dichiara ${count} accoppiamento/i superficie-punto, che il solutore a gusci non può applicare — un accoppiamento richiede l'assemblatore accoppiato solido-guscio, e questo richiede almeno un corpo solido. Elimina l'accoppiamento, o mantieni un corpo solido.`,
    es: (count: number) =>
      `Este modelo es solo de elementos lámina y declara ${count} acoplamiento(s) superficie-punto, que el solucionador de láminas no puede aplicar: un acoplamiento necesita el ensamblador acoplado sólido-lámina, y este necesita al menos un cuerpo sólido. Elimina el acoplamiento, o mantén un cuerpo sólido.`,
    pt: (count: number) =>
      `Este modelo é só de elementos de casca e declara ${count} acoplamento(s) superfície-ponto, que o solucionador de cascas não consegue aplicar — um acoplamento precisa do montador acoplado sólido-casca, e este precisa de pelo menos um corpo sólido. Exclua o acoplamento, ou mantenha um corpo sólido.`,
  },
  solidModel: {
    en: (reason: string) => `The solver cannot solve this model: ${reason}.`,
    de: (reason: string) =>
      `Der Löser kann dieses Modell nicht lösen: ${reason}.`,
    fr: (reason: string) =>
      `Le solveur ne peut pas résoudre ce modèle : ${reason}.`,
    it: (reason: string) =>
      `Il solutore non può risolvere questo modello: ${reason}.`,
    es: (reason: string) =>
      `El solucionador no puede resolver este modelo: ${reason}.`,
    pt: (reason: string) =>
      `O solucionador não consegue resolver este modelo: ${reason}.`,
  },
  namedLoad: {
    en: (name: string) => `Load "${name}"`,
    de: (name: string) => `Last „${name}“`,
    fr: (name: string) => `Charge « ${name} »`,
    it: (name: string) => `Carico "${name}"`,
    es: (name: string) => `Carga "${name}"`,
    pt: (name: string) => `Carga "${name}"`,
  },
  numberedLoad: {
    en: (index: number) => `Surface load ${index}`,
    de: (index: number) => `Flächenlast ${index}`,
    fr: (index: number) => `Charge surfacique ${index}`,
    it: (index: number) => `Carico di superficie ${index}`,
    es: (index: number) => `Carga de superficie ${index}`,
    pt: (index: number) => `Carga de superfície ${index}`,
  },
  loadMatchesNoFace: {
    en: (load: string) =>
      `${load}: its selection matches no face of the current mesh, so it would apply no load at all. Re-pick the load on faces of the mesh.`,
    de: (load: string) =>
      `${load}: Ihre Auswahl trifft keine Fläche des aktuellen Netzes, sie würde also gar keine Last aufbringen. Wählen Sie die Last erneut auf Flächen des Netzes.`,
    fr: (load: string) =>
      `${load} : sa sélection ne correspond à aucune face du maillage actuel, elle n'appliquerait donc aucune charge. Sélectionnez à nouveau la charge sur des faces du maillage.`,
    it: (load: string) =>
      `${load}: la sua selezione non corrisponde ad alcuna faccia della mesh attuale, quindi non applicherebbe alcun carico. Riseleziona il carico su facce della mesh.`,
    es: (load: string) =>
      `${load}: su selección no coincide con ninguna cara de la malla actual, así que no aplicaría ninguna carga. Vuelve a seleccionar la carga sobre caras de la malla.`,
    pt: (load: string) =>
      `${load}: sua seleção não corresponde a nenhuma face da malha atual, então não aplicaria carga nenhuma. Selecione novamente a carga em faces da malha.`,
  },
  loadStaleNoLoad: {
    en: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 of its selections matches" : `${stale} of its selections match`} no face of the current mesh, so it would apply no load at all. Re-pick the load on faces of the mesh.`,
    de: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 ihrer Auswahlen trifft" : `${stale} ihrer Auswahlen treffen`} keine Fläche des aktuellen Netzes, sie würde also gar keine Last aufbringen. Wählen Sie die Last erneut auf Flächen des Netzes.`,
    fr: (load: string, stale: number) =>
      `${load} : ${stale === 1 ? "1 de ses sélections ne correspond" : `${stale} de ses sélections ne correspondent`} à aucune face du maillage actuel, elle n'appliquerait donc aucune charge. Sélectionnez à nouveau la charge sur des faces du maillage.`,
    it: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 delle sue selezioni non corrisponde" : `${stale} delle sue selezioni non corrispondono`} ad alcuna faccia della mesh attuale, quindi non applicherebbe alcun carico. Riseleziona il carico su facce della mesh.`,
    es: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 de sus selecciones no coincide" : `${stale} de sus selecciones no coinciden`} con ninguna cara de la malla actual, así que no aplicaría ninguna carga. Vuelve a seleccionar la carga sobre caras de la malla.`,
    pt: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 de suas seleções não corresponde" : `${stale} de suas seleções não correspondem`} a nenhuma face da malha atual, então não aplicaria carga nenhuma. Selecione novamente a carga em faces da malha.`,
  },
  loadStalePartial: {
    en: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 of its selections matches" : `${stale} of its selections match`} no face of the current mesh, so its total would act on the other selections alone. Re-pick the load on faces of the mesh.`,
    de: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 ihrer Auswahlen trifft" : `${stale} ihrer Auswahlen treffen`} keine Fläche des aktuellen Netzes, ihre Gesamtlast würde also allein auf die übrigen Auswahlen wirken. Wählen Sie die Last erneut auf Flächen des Netzes.`,
    fr: (load: string, stale: number) =>
      `${load} : ${stale === 1 ? "1 de ses sélections ne correspond" : `${stale} de ses sélections ne correspondent`} à aucune face du maillage actuel, son total agirait donc sur les seules autres sélections. Sélectionnez à nouveau la charge sur des faces du maillage.`,
    it: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 delle sue selezioni non corrisponde" : `${stale} delle sue selezioni non corrispondono`} ad alcuna faccia della mesh attuale, quindi il suo totale agirebbe solo sulle altre selezioni. Riseleziona il carico su facce della mesh.`,
    es: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 de sus selecciones no coincide" : `${stale} de sus selecciones no coinciden`} con ninguna cara de la malla actual, así que su total actuaría solo sobre las demás selecciones. Vuelve a seleccionar la carga sobre caras de la malla.`,
    pt: (load: string, stale: number) =>
      `${load}: ${stale === 1 ? "1 de suas seleções não corresponde" : `${stale} de suas seleções não correspondem`} a nenhuma face da malha atual, então seu total atuaria apenas sobre as demais seleções. Selecione novamente a carga em faces da malha.`,
  },
  loadOffBoundary: {
    en: (load: string, off: number, total: number) =>
      `${load}: ${off} of its ${total} faces ${off === 1 ? "is" : "are"} not on the mesh boundary, so the rest would carry the whole load. Re-pick the load on faces of the mesh.`,
    de: (load: string, off: number, total: number) =>
      `${load}: ${off} ihrer ${total} Flächen ${off === 1 ? "liegt" : "liegen"} nicht auf dem Netzrand, die übrigen würden also die ganze Last tragen. Wählen Sie die Last erneut auf Flächen des Netzes.`,
    fr: (load: string, off: number, total: number) =>
      `${load} : ${off} de ses ${total} faces ${off === 1 ? "n'est" : "ne sont"} pas sur le bord du maillage, les autres porteraient donc toute la charge. Sélectionnez à nouveau la charge sur des faces du maillage.`,
    it: (load: string, off: number, total: number) =>
      `${load}: ${off} delle sue ${total} facce ${off === 1 ? "non è" : "non sono"} sul bordo della mesh, quindi le altre porterebbero l'intero carico. Riseleziona il carico su facce della mesh.`,
    es: (load: string, off: number, total: number) =>
      `${load}: ${off} de sus ${total} caras no ${off === 1 ? "está" : "están"} en el contorno de la malla, así que las demás soportarían toda la carga. Vuelve a seleccionar la carga sobre caras de la malla.`,
    pt: (load: string, off: number, total: number) =>
      `${load}: ${off} de suas ${total} faces não ${off === 1 ? "está" : "estão"} no contorno da malha, então as demais carregariam a carga inteira. Selecione novamente a carga em faces da malha.`,
  },
  temperatureOptimization: {
    en: "A topology optimization cannot take a temperature change yet: only an all-solid model is solved with one. Remove the temperature change, or make every body Solid.",
    de: "Eine Topologieoptimierung kann noch keine Temperaturänderung berücksichtigen: nur ein reines Volumenmodell wird damit gelöst. Entfernen Sie die Temperaturänderung oder setzen Sie jeden Körper auf Volumen.",
    fr: "Une optimisation topologique ne peut pas encore prendre en compte une variation de température : seul un modèle entièrement volumique est résolu avec. Supprimez la variation de température, ou rendez chaque corps volumique.",
    it: "Un'ottimizzazione topologica non può ancora considerare una variazione di temperatura: solo un modello interamente solido viene risolto con essa. Rimuovi la variazione di temperatura, o rendi solido ogni corpo.",
    es: "Una optimización topológica aún no admite un cambio de temperatura: solo un modelo totalmente sólido se resuelve con él. Quita el cambio de temperatura, o haz sólido cada cuerpo.",
    pt: "Uma otimização topológica ainda não aceita uma variação de temperatura: apenas um modelo totalmente sólido é resolvido com ela. Remova a variação de temperatura, ou torne todo corpo Sólido.",
  },
  temperatureShell: {
    en: "A shell model cannot take a temperature change yet: only an all-solid model is solved with one. Remove the temperature change, or make every body Solid.",
    de: "Ein Schalenmodell kann noch keine Temperaturänderung berücksichtigen: nur ein reines Volumenmodell wird damit gelöst. Entfernen Sie die Temperaturänderung oder setzen Sie jeden Körper auf Volumen.",
    fr: "Un modèle coque ne peut pas encore prendre en compte une variation de température : seul un modèle entièrement volumique est résolu avec. Supprimez la variation de température, ou rendez chaque corps volumique.",
    it: "Un modello a gusci non può ancora considerare una variazione di temperatura: solo un modello interamente solido viene risolto con essa. Rimuovi la variazione di temperatura, o rendi solido ogni corpo.",
    es: "Un modelo de láminas aún no admite un cambio de temperatura: solo un modelo totalmente sólido se resuelve con él. Quita el cambio de temperatura, o haz sólido cada cuerpo.",
    pt: "Um modelo de cascas ainda não aceita uma variação de temperatura: apenas um modelo totalmente sólido é resolvido com ela. Remova a variação de temperatura, ou torne todo corpo Sólido.",
  },
  temperatureCoupled: {
    en: "A model with shells and solids, or with a coupling, cannot take a temperature change yet: only an all-solid model is solved with one. Remove the temperature change, or make every body Solid.",
    de: "Ein Modell mit Schalen und Volumen oder mit einer Kopplung kann noch keine Temperaturänderung berücksichtigen: nur ein reines Volumenmodell wird damit gelöst. Entfernen Sie die Temperaturänderung oder setzen Sie jeden Körper auf Volumen.",
    fr: "Un modèle avec coques et volumes, ou avec un couplage, ne peut pas encore prendre en compte une variation de température : seul un modèle entièrement volumique est résolu avec. Supprimez la variation de température, ou rendez chaque corps volumique.",
    it: "Un modello con gusci e solidi, o con un accoppiamento, non può ancora considerare una variazione di temperatura: solo un modello interamente solido viene risolto con essa. Rimuovi la variazione di temperatura, o rendi solido ogni corpo.",
    es: "Un modelo con láminas y sólidos, o con un acoplamiento, aún no admite un cambio de temperatura: solo un modelo totalmente sólido se resuelve con él. Quita el cambio de temperatura, o haz sólido cada cuerpo.",
    pt: "Um modelo com cascas e sólidos, ou com um acoplamento, ainda não aceita uma variação de temperatura: apenas um modelo totalmente sólido é resolvido com ela. Remova a variação de temperatura, ou torne todo corpo Sólido.",
  },
  temperatureAutoShell: {
    en: "A model with a body marked Shell cannot take a temperature change yet: only an all-solid model is solved with one. Remove the temperature change, or make every body Solid.",
    de: "Ein Modell mit einem als Schale markierten Körper kann noch keine Temperaturänderung berücksichtigen: nur ein reines Volumenmodell wird damit gelöst. Entfernen Sie die Temperaturänderung oder setzen Sie jeden Körper auf Volumen.",
    fr: "Un modèle avec un corps marqué Coque ne peut pas encore prendre en compte une variation de température : seul un modèle entièrement volumique est résolu avec. Supprimez la variation de température, ou rendez chaque corps volumique.",
    it: "Un modello con un corpo contrassegnato come Guscio non può ancora considerare una variazione di temperatura: solo un modello interamente solido viene risolto con essa. Rimuovi la variazione di temperatura, o rendi solido ogni corpo.",
    es: "Un modelo con un cuerpo marcado como Lámina aún no admite un cambio de temperatura: solo un modelo totalmente sólido se resuelve con él. Quita el cambio de temperatura, o haz sólido cada cuerpo.",
    pt: "Um modelo com um corpo marcado como Casca ainda não aceita uma variação de temperatura: apenas um modelo totalmente sólido é resolvido com ela. Remova a variação de temperatura, ou torne todo corpo Sólido.",
  },
  topOptShellNotIdealised: {
    en: (count: number) =>
      `Topology optimization: ${count} body/bodies are marked "Shell" but were not idealised into shell elements. Re-mesh (which collapses their thin walls to a shell mid-surface), then optimize the mixed model — or switch them to Solid.`,
    de: (count: number) =>
      `Topologieoptimierung: ${count} Körper sind als „Schale“ markiert, wurden aber nicht in Schalenelemente idealisiert. Vernetzen Sie neu (das reduziert ihre dünnen Wände auf eine Schalenmittelfläche) und optimieren Sie dann das gemischte Modell – oder setzen Sie sie auf Volumen.`,
    fr: (count: number) =>
      `Optimisation topologique : ${count} corps sont marqués « Coque » mais n'ont pas été idéalisés en éléments coque. Remaillez (ce qui ramène leurs parois minces à une surface moyenne de coque), puis optimisez le modèle mixte — ou passez-les en Volumique.`,
    it: (count: number) =>
      `Ottimizzazione topologica: ${count} corpo/i sono contrassegnati come "Guscio" ma non sono stati idealizzati in elementi guscio. Rigenera la mesh (che riduce le loro pareti sottili a una superficie media di guscio), poi ottimizza il modello misto — oppure impostali su Solido.`,
    es: (count: number) =>
      `Optimización topológica: ${count} cuerpo(s) están marcados como "Lámina" pero no se idealizaron en elementos lámina. Vuelve a mallar (lo que reduce sus paredes delgadas a una superficie media de lámina) y luego optimiza el modelo mixto, o cámbialos a Sólido.`,
    pt: (count: number) =>
      `Otimização topológica: ${count} corpo(s) estão marcados como "Casca", mas não foram idealizados em elementos de casca. Gere a malha novamente (o que reduz as paredes finas a uma superfície média de casca) e depois otimize o modelo misto — ou mude-os para Sólido.`,
  },
  topOptLevelSetShells: {
    en: (count: number) =>
      `Topology optimization: the level-set method supports solid models only, but this model has ${count} shell (CTRIA3) element(s) — use SIMP for shell and coupled models.`,
    de: (count: number) =>
      `Topologieoptimierung: Die Level-Set-Methode unterstützt nur Volumenmodelle, dieses Modell hat aber ${count} Schalenelement(e) (CTRIA3) – verwenden Sie SIMP für Schalen- und gekoppelte Modelle.`,
    fr: (count: number) =>
      `Optimisation topologique : la méthode level-set ne prend en charge que les modèles volumiques, mais ce modèle a ${count} élément(s) coque (CTRIA3) — utilisez SIMP pour les modèles coque et couplés.`,
    it: (count: number) =>
      `Ottimizzazione topologica: il metodo level-set supporta solo modelli solidi, ma questo modello ha ${count} elemento/i guscio (CTRIA3) — usa SIMP per modelli a gusci e accoppiati.`,
    es: (count: number) =>
      `Optimización topológica: el método level-set solo admite modelos sólidos, pero este modelo tiene ${count} elemento(s) lámina (CTRIA3); usa SIMP para modelos de láminas y acoplados.`,
    pt: (count: number) =>
      `Otimização topológica: o método level-set aceita apenas modelos sólidos, mas este modelo tem ${count} elemento(s) de casca (CTRIA3) — use SIMP para modelos de cascas e acoplados.`,
  },
  topOptLevelSetCouplings: {
    en: (count: number) =>
      `Topology optimization: the level-set method does not support couplings yet, but this model has ${count} — remove them or use SIMP.`,
    de: (count: number) =>
      `Topologieoptimierung: Die Level-Set-Methode unterstützt noch keine Kopplungen, dieses Modell hat aber ${count} – entfernen Sie sie oder verwenden Sie SIMP.`,
    fr: (count: number) =>
      `Optimisation topologique : la méthode level-set ne prend pas encore en charge les couplages, mais ce modèle en a ${count} — supprimez-les ou utilisez SIMP.`,
    it: (count: number) =>
      `Ottimizzazione topologica: il metodo level-set non supporta ancora gli accoppiamenti, ma questo modello ne ha ${count} — rimuovili o usa SIMP.`,
    es: (count: number) =>
      `Optimización topológica: el método level-set aún no admite acoplamientos, pero este modelo tiene ${count}; elimínalos o usa SIMP.`,
    pt: (count: number) =>
      `Otimização topológica: o método level-set ainda não aceita acoplamentos, mas este modelo tem ${count} — remova-os ou use SIMP.`,
  },
  severalShellBodies: {
    en: (ids: string) =>
      `Bodies ${ids} are all marked "Shell", but one body per model can be idealised as shells today. Keep one of them Shell and set the others to Solid.`,
    de: (ids: string) =>
      `Die Körper ${ids} sind alle als „Schale“ markiert, derzeit kann aber nur ein Körper pro Modell als Schale idealisiert werden. Lassen Sie einen davon als Schale und setzen Sie die anderen auf Volumen.`,
    fr: (ids: string) =>
      `Les corps ${ids} sont tous marqués « Coque », mais un seul corps par modèle peut être idéalisé en coque aujourd'hui. Gardez-en un en Coque et passez les autres en Volumique.`,
    it: (ids: string) =>
      `I corpi ${ids} sono tutti contrassegnati come "Guscio", ma oggi si può idealizzare come guscio un solo corpo per modello. Lasciane uno come Guscio e imposta gli altri su Solido.`,
    es: (ids: string) =>
      `Los cuerpos ${ids} están todos marcados como "Lámina", pero hoy solo se puede idealizar como lámina un cuerpo por modelo. Deja uno como Lámina y cambia los demás a Sólido.`,
    pt: (ids: string) =>
      `Os corpos ${ids} estão todos marcados como "Casca", mas hoje apenas um corpo por modelo pode ser idealizado como casca. Mantenha um deles como Casca e mude os outros para Sólido.`,
  },
  shellBodyNoMaterial: {
    en: (id: number) =>
      `Body ${id} is marked "Shell" but has no material assignment: the property table sent with the mesh request does not list it. Re-import the geometry or assign the body a material.`,
    de: (id: number) =>
      `Körper ${id} ist als „Schale“ markiert, hat aber keine Werkstoffzuweisung: die mit der Vernetzungsanfrage gesendete Eigenschaftstabelle führt ihn nicht. Importieren Sie die Geometrie neu oder weisen Sie dem Körper einen Werkstoff zu.`,
    fr: (id: number) =>
      `Le corps ${id} est marqué « Coque » mais n'a pas de matériau affecté : la table des propriétés envoyée avec la demande de maillage ne le contient pas. Réimportez la géométrie ou affectez un matériau au corps.`,
    it: (id: number) =>
      `Il corpo ${id} è contrassegnato come "Guscio" ma non ha un materiale assegnato: la tabella delle proprietà inviata con la richiesta di mesh non lo elenca. Reimporta la geometria o assegna un materiale al corpo.`,
    es: (id: number) =>
      `El cuerpo ${id} está marcado como "Lámina" pero no tiene material asignado: la tabla de propiedades enviada con la solicitud de mallado no lo incluye. Vuelve a importar la geometría o asigna un material al cuerpo.`,
    pt: (id: number) =>
      `O corpo ${id} está marcado como "Casca", mas não tem material atribuído: a tabela de propriedades enviada com o pedido de malha não o inclui. Importe a geometria novamente ou atribua um material ao corpo.`,
  },
  shellNoThinWalls: {
    en: (ids: string) =>
      `Shell idealisation failed: body ${ids} is marked "Shell" but no thin walls were found in it. Switch it to Solid, or check that it is genuinely thin-walled.`,
    de: (ids: string) =>
      `Schalenidealisierung fehlgeschlagen: Körper ${ids} ist als „Schale“ markiert, aber es wurden keine dünnen Wände darin gefunden. Setzen Sie ihn auf Volumen oder prüfen Sie, ob er wirklich dünnwandig ist.`,
    fr: (ids: string) =>
      `Échec de l'idéalisation en coque : le corps ${ids} est marqué « Coque » mais aucune paroi mince n'y a été trouvée. Passez-le en Volumique, ou vérifiez qu'il est vraiment à parois minces.`,
    it: (ids: string) =>
      `Idealizzazione a guscio non riuscita: il corpo ${ids} è contrassegnato come "Guscio" ma non vi sono state trovate pareti sottili. Impostalo su Solido, o verifica che sia davvero a parete sottile.`,
    es: (ids: string) =>
      `Falló la idealización como lámina: el cuerpo ${ids} está marcado como "Lámina" pero no se encontraron paredes delgadas en él. Cámbialo a Sólido, o comprueba que sea realmente de pared delgada.`,
    pt: (ids: string) =>
      `A idealização como casca falhou: o corpo ${ids} está marcado como "Casca", mas nenhuma parede fina foi encontrada nele. Mude-o para Sólido, ou verifique se ele tem mesmo parede fina.`,
  },
  surfaceInconsistent: {
    en: (triangles: number, faceIds: number) =>
      `The surface mesh is inconsistent: ${triangles} surface triangles but ${faceIds} face ids. Re-mesh the model.`,
    de: (triangles: number, faceIds: number) =>
      `Das Oberflächennetz ist inkonsistent: ${triangles} Oberflächendreiecke, aber ${faceIds} Flächen-IDs. Vernetzen Sie das Modell neu.`,
    fr: (triangles: number, faceIds: number) =>
      `Le maillage de surface est incohérent : ${triangles} triangles de surface mais ${faceIds} identifiants de face. Remaillez le modèle.`,
    it: (triangles: number, faceIds: number) =>
      `La mesh di superficie è incoerente: ${triangles} triangoli di superficie ma ${faceIds} id di faccia. Rigenera la mesh del modello.`,
    es: (triangles: number, faceIds: number) =>
      `La malla de superficie es incoherente: ${triangles} triángulos de superficie pero ${faceIds} identificadores de cara. Vuelve a mallar el modelo.`,
    pt: (triangles: number, faceIds: number) =>
      `A malha de superfície está inconsistente: ${triangles} triângulos de superfície, mas ${faceIds} ids de face. Gere a malha do modelo novamente.`,
  },
  shellBodiesMarked: {
    en: (ids: string, count: number) =>
      count === 1
        ? `Body ${ids} is marked "Shell"`
        : `Bodies ${ids} are marked "Shell"`,
    de: (ids: string, count: number) =>
      count === 1
        ? `Körper ${ids} ist als „Schale“ markiert`
        : `Die Körper ${ids} sind als „Schale“ markiert`,
    fr: (ids: string, count: number) =>
      count === 1
        ? `Le corps ${ids} est marqué « Coque »`
        : `Les corps ${ids} sont marqués « Coque »`,
    it: (ids: string, count: number) =>
      count === 1
        ? `Il corpo ${ids} è contrassegnato come "Guscio"`
        : `I corpi ${ids} sono contrassegnati come "Guscio"`,
    es: (ids: string, count: number) =>
      count === 1
        ? `El cuerpo ${ids} está marcado como "Lámina"`
        : `Los cuerpos ${ids} están marcados como "Lámina"`,
    pt: (ids: string, count: number) =>
      count === 1
        ? `O corpo ${ids} está marcado como "Casca"`
        : `Os corpos ${ids} estão marcados como "Casca"`,
  },
  shellNoSurfaceMesh: {
    en: (marked: string) =>
      `${marked}, but the model has no surface mesh to find thin walls in. Re-mesh the model, or set the body to Solid.`,
    de: (marked: string) =>
      `${marked}, aber das Modell hat kein Oberflächennetz, in dem dünne Wände gesucht werden könnten. Vernetzen Sie das Modell neu oder setzen Sie den Körper auf Volumen.`,
    fr: (marked: string) =>
      `${marked}, mais le modèle n'a pas de maillage de surface où chercher des parois minces. Remaillez le modèle, ou passez le corps en Volumique.`,
    it: (marked: string) =>
      `${marked}, ma il modello non ha una mesh di superficie in cui cercare pareti sottili. Rigenera la mesh del modello, o imposta il corpo su Solido.`,
    es: (marked: string) =>
      `${marked}, pero el modelo no tiene malla de superficie en la que buscar paredes delgadas. Vuelve a mallar el modelo, o cambia el cuerpo a Sólido.`,
    pt: (marked: string) =>
      `${marked}, mas o modelo não tem malha de superfície onde procurar paredes finas. Gere a malha do modelo novamente, ou mude o corpo para Sólido.`,
  },
  shellHexMesh: {
    en: (marked: string, hexes: number) =>
      `${marked}, but the mesh has ${hexes} hexahedral element(s), and shell idealisation works on tetrahedral meshes only. Mesh with tetrahedra, or set the body to Solid.`,
    de: (marked: string, hexes: number) =>
      `${marked}, aber das Netz hat ${hexes} Hexaederelement(e), und die Schalenidealisierung funktioniert nur auf Tetraedernetzen. Vernetzen Sie mit Tetraedern oder setzen Sie den Körper auf Volumen.`,
    fr: (marked: string, hexes: number) =>
      `${marked}, mais le maillage a ${hexes} élément(s) hexaédrique(s), et l'idéalisation en coque ne fonctionne que sur des maillages tétraédriques. Maillez en tétraèdres, ou passez le corps en Volumique.`,
    it: (marked: string, hexes: number) =>
      `${marked}, ma la mesh ha ${hexes} elemento/i esaedrico/i, e l'idealizzazione a guscio funziona solo su mesh tetraedriche. Genera la mesh con tetraedri, o imposta il corpo su Solido.`,
    es: (marked: string, hexes: number) =>
      `${marked}, pero la malla tiene ${hexes} elemento(s) hexaédrico(s), y la idealización como lámina solo funciona en mallas de tetraedros. Malla con tetraedros, o cambia el cuerpo a Sólido.`,
    pt: (marked: string, hexes: number) =>
      `${marked}, mas a malha tem ${hexes} elemento(s) hexaédrico(s), e a idealização como casca só funciona em malhas de tetraedros. Gere a malha com tetraedros, ou mude o corpo para Sólido.`,
  },
  shellTouchesNoSolid: {
    en: (marked: string, solids: string) =>
      `${marked}, but the shell touches no solid body, so it cannot be coupled to body ${solids}, and a pure shell solve would leave the solid bodies out. Tie the Shell body to a solid body, or set it to Solid.`,
    de: (marked: string, solids: string) =>
      `${marked}, aber die Schale berührt keinen Volumenkörper, kann also nicht mit Körper ${solids} gekoppelt werden, und eine reine Schalenberechnung würde die Volumenkörper weglassen. Verbinden Sie den Schalenkörper mit einem Volumenkörper oder setzen Sie ihn auf Volumen.`,
    fr: (marked: string, solids: string) =>
      `${marked}, mais la coque ne touche aucun corps volumique : elle ne peut donc pas être couplée au corps ${solids}, et un calcul de coque seul laisserait de côté les corps volumiques. Liez le corps coque à un corps volumique, ou passez-le en Volumique.`,
    it: (marked: string, solids: string) =>
      `${marked}, ma il guscio non tocca alcun corpo solido, quindi non può essere accoppiato al corpo ${solids}, e un calcolo a soli gusci tralascerebbe i corpi solidi. Collega il corpo guscio a un corpo solido, o impostalo su Solido.`,
    es: (marked: string, solids: string) =>
      `${marked}, pero la lámina no toca ningún cuerpo sólido, así que no puede acoplarse al cuerpo ${solids}, y un cálculo solo de láminas dejaría fuera los cuerpos sólidos. Une el cuerpo lámina a un cuerpo sólido, o cámbialo a Sólido.`,
    pt: (marked: string, solids: string) =>
      `${marked}, mas a casca não toca nenhum corpo sólido, então não pode ser acoplada ao corpo ${solids}, e uma análise só de cascas deixaria os corpos sólidos de fora. Ligue o corpo de casca a um corpo sólido, ou mude-o para Sólido.`,
  },
  listTwo: {
    en: (head: string, last: string) => `${head} and ${last}`,
    de: (head: string, last: string) => `${head} und ${last}`,
    fr: (head: string, last: string) => `${head} et ${last}`,
    it: (head: string, last: string) => `${head} e ${last}`,
    es: (head: string, last: string) => `${head} y ${last}`,
    pt: (head: string, last: string) => `${head} e ${last}`,
  },
  moveAlong: {
    en: (axes: string) => `move along ${axes}`,
    de: (axes: string) => `entlang ${axes} verschieben`,
    fr: (axes: string) => `se déplacer selon ${axes}`,
    it: (axes: string) => `traslare lungo ${axes}`,
    es: (axes: string) => `desplazarse a lo largo de ${axes}`,
    pt: (axes: string) => `se deslocar ao longo de ${axes}`,
  },
  rotateAbout: {
    en: (axes: string) => `rotate about ${axes}`,
    de: (axes: string) => `um ${axes} drehen`,
    fr: (axes: string) => `tourner autour de ${axes}`,
    it: (axes: string) => `ruotare attorno a ${axes}`,
    es: (axes: string) => `girar alrededor de ${axes}`,
    pt: (axes: string) => `girar em torno de ${axes}`,
  },
  motionAnd: {
    en: (move: string, rotate: string) => `${move} and ${rotate}`,
    de: (move: string, rotate: string) => `${move} und ${rotate}`,
    fr: (move: string, rotate: string) => `${move} et ${rotate}`,
    it: (move: string, rotate: string) => `${move} e ${rotate}`,
    es: (move: string, rotate: string) => `${move} y ${rotate}`,
    pt: (move: string, rotate: string) => `${move} e ${rotate}`,
  },
  motionAndAfterList: {
    en: (move: string, rotate: string) => `${move}, and ${rotate}`,
    de: (move: string, rotate: string) => `${move} und ${rotate}`,
    fr: (move: string, rotate: string) => `${move} et ${rotate}`,
    it: (move: string, rotate: string) => `${move} e ${rotate}`,
    es: (move: string, rotate: string) => `${move} y ${rotate}`,
    pt: (move: string, rotate: string) => `${move} e ${rotate}`,
  },
  bodyCanStill: {
    en: (body: number, motion: string) => `Body ${body} can still ${motion}.`,
    de: (body: number, motion: string) =>
      `Körper ${body} kann sich noch ${motion}.`,
    fr: (body: number, motion: string) =>
      `Le corps ${body} peut encore ${motion}.`,
    it: (body: number, motion: string) =>
      `Il corpo ${body} può ancora ${motion}.`,
    es: (body: number, motion: string) =>
      `El cuerpo ${body} todavía puede ${motion}.`,
    pt: (body: number, motion: string) =>
      `O corpo ${body} ainda pode ${motion}.`,
  },
  bodiesCanStill: {
    en: (bodies: string, motion: string) =>
      `Bodies ${bodies} can still ${motion}.`,
    de: (bodies: string, motion: string) =>
      `Die Körper ${bodies} können sich noch ${motion}.`,
    fr: (bodies: string, motion: string) =>
      `Les corps ${bodies} peuvent encore ${motion}.`,
    it: (bodies: string, motion: string) =>
      `I corpi ${bodies} possono ancora ${motion}.`,
    es: (bodies: string, motion: string) =>
      `Los cuerpos ${bodies} todavía pueden ${motion}.`,
    pt: (bodies: string, motion: string) =>
      `Os corpos ${bodies} ainda podem ${motion}.`,
  },
  holdOneBody: {
    en: "Add a support or connect it to another body.",
    de: "Fügen Sie eine Lagerung hinzu oder verbinden Sie ihn mit einem anderen Körper.",
    fr: "Ajoutez un appui ou reliez-le à un autre corps.",
    it: "Aggiungi un vincolo o collegalo a un altro corpo.",
    es: "Añade un apoyo o únelo a otro cuerpo.",
    pt: "Adicione um apoio ou ligue-o a outro corpo.",
  },
  holdBodies: {
    en: "Add supports or connect them to other bodies.",
    de: "Fügen Sie Lagerungen hinzu oder verbinden Sie sie mit anderen Körpern.",
    fr: "Ajoutez des appuis ou reliez-les à d'autres corps.",
    it: "Aggiungi vincoli o collegali ad altri corpi.",
    es: "Añade apoyos o únelos a otros cuerpos.",
    pt: "Adicione apoios ou ligue-os a outros corpos.",
  },
  thinWall: {
    en: (body: number, across: string, thickness: string) =>
      `Thin wall on body ${body}: about ${across} linear elements across ${thickness} mm — results may be far too stiff. Use quadratic elements (Mesh panel) or set the body to Shell.`,
    de: (body: number, across: string, thickness: string) =>
      `Dünne Wand an Körper ${body}: etwa ${across} lineare Elemente über ${thickness} mm – die Ergebnisse können viel zu steif sein. Verwenden Sie quadratische Elemente (Netz-Bereich) oder setzen Sie den Körper auf Schale.`,
    fr: (body: number, across: string, thickness: string) =>
      `Paroi mince sur le corps ${body} : environ ${across} éléments linéaires dans ${thickness} mm d'épaisseur — les résultats peuvent être beaucoup trop rigides. Utilisez des éléments quadratiques (panneau Maillage) ou passez le corps en Coque.`,
    it: (body: number, across: string, thickness: string) =>
      `Parete sottile sul corpo ${body}: circa ${across} elementi lineari su ${thickness} mm di spessore — i risultati possono essere decisamente troppo rigidi. Usa elementi quadratici (pannello Mesh) o imposta il corpo su Guscio.`,
    es: (body: number, across: string, thickness: string) =>
      `Pared delgada en el cuerpo ${body}: unos ${across} elementos lineales en ${thickness} mm de espesor; los resultados pueden ser demasiado rígidos. Usa elementos cuadráticos (panel Malla) o cambia el cuerpo a Lámina.`,
    pt: (body: number, across: string, thickness: string) =>
      `Parede fina no corpo ${body}: cerca de ${across} elementos lineares em ${thickness} mm de espessura — os resultados podem ficar rígidos demais. Use elementos quadráticos (painel Malha) ou mude o corpo para Casca.`,
  },
});
