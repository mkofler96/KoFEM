// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// A topology optimization study: its settings and checks, the run and its
// result, and the convergence chart.
export const optimizeMessages = defineMessages({
  staticCase: {
    en: (study: string) => `Static case · ${study}`,
    de: (study: string) => `Statischer Lastfall · ${study}`,
    fr: (study: string) => `Cas statique · ${study}`,
    it: (study: string) => `Caso statico · ${study}`,
    es: (study: string) => `Caso estático · ${study}`,
    pt: (study: string) => `Caso estático · ${study}`,
  },
  noStaticCase: {
    en: "No static case — pick the static study to optimize for",
    de: "Kein statischer Lastfall – wählen Sie die statische Studie, für die optimiert wird",
    fr: "Aucun cas statique — choisissez l'étude statique à optimiser",
    it: "Nessun caso statico — scegli lo studio statico per cui ottimizzare",
    es: "Sin caso estático: elige el estudio estático para el que optimizar",
    pt: "Nenhum caso estático — escolha o estudo estático para o qual otimizar",
  },
  designDomain: {
    en: "Design domain",
    de: "Designbereich",
    fr: "Domaine de conception",
    it: "Dominio di progetto",
    es: "Dominio de diseño",
    pt: "Domínio de projeto",
  },
  method: {
    en: "Method",
    de: "Methode",
    fr: "Méthode",
    it: "Metodo",
    es: "Método",
    pt: "Método",
  },
  levelSet: {
    en: "Level set",
    de: "Level-Set",
    fr: "Level set",
    it: "Level set",
    es: "Level set",
    pt: "Level set",
  },
  levelSetNote: {
    en: "Nodal level set (reaction–diffusion): a crisp, smooth boundary. Solid models, minimum compliance.",
    de: "Knotenbasiertes Level-Set (Reaktion–Diffusion): ein scharfer, glatter Rand. Volumenmodelle, minimale Nachgiebigkeit.",
    fr: "Level set nodal (réaction–diffusion) : un bord net et lisse. Modèles volumiques, souplesse minimale.",
    it: "Level set nodale (reazione–diffusione): un contorno netto e liscio. Modelli solidi, cedevolezza minima.",
    es: "Level set nodal (reacción–difusión): un contorno nítido y suave. Modelos sólidos, flexibilidad mínima.",
    pt: "Level set nodal (reação–difusão): um contorno nítido e suave. Modelos sólidos, flexibilidade mínima.",
  },
  simpNote: {
    en: "Density per element (SIMP + MMA). Supports every objective and shell models.",
    de: "Dichte je Element (SIMP + MMA). Unterstützt alle Zielfunktionen und Schalenmodelle.",
    fr: "Densité par élément (SIMP + MMA). Prend en charge tous les objectifs et les modèles coque.",
    it: "Densità per elemento (SIMP + MMA). Supporta ogni obiettivo e i modelli a gusci.",
    es: "Densidad por elemento (SIMP + MMA). Admite todos los objetivos y los modelos de láminas.",
    pt: "Densidade por elemento (SIMP + MMA). Aceita todos os objetivos e modelos de cascas.",
  },
  objective: {
    en: "Objective",
    de: "Zielfunktion",
    fr: "Objectif",
    it: "Obiettivo",
    es: "Objetivo",
    pt: "Objetivo",
  },
  minCompliance: {
    en: "Min compliance",
    de: "Min. Nachgiebigkeit",
    fr: "Souplesse min.",
    it: "Cedevolezza min.",
    es: "Flexibilidad mín.",
    pt: "Flexibilidade mín.",
  },
  minVolume: {
    en: "Min volume",
    de: "Min. Volumen",
    fr: "Volume min.",
    it: "Volume min.",
    es: "Volumen mín.",
    pt: "Volume mín.",
  },
  constraint: {
    en: "Constraint",
    de: "Nebenbedingung",
    fr: "Contrainte d'optimisation",
    it: "Vincolo di ottimizzazione",
    es: "Restricción",
    pt: "Restrição",
  },
  volumeFraction: {
    en: "Volume frac.",
    de: "Volumenanteil",
    fr: "Fraction vol.",
    it: "Frazione vol.",
    es: "Fracción vol.",
    pt: "Fração vol.",
  },
  volumeFractionHint: {
    en: "Target fraction of material to keep, 0–1 (e.g. 0.5)",
    de: "Anteil des Materials, der erhalten bleiben soll, 0–1 (z. B. 0.5)",
    fr: "Fraction de matière à conserver, 0–1 (p. ex. 0.5)",
    it: "Frazione di materiale da conservare, 0–1 (ad es. 0.5)",
    es: "Fracción de material que se conserva, 0–1 (p. ej. 0.5)",
    pt: "Fração de material a manter, 0–1 (p. ex. 0.5)",
  },
  complianceLimit: {
    en: "Compliance ≤",
    de: "Nachgiebigkeit ≤",
    fr: "Souplesse ≤",
    it: "Cedevolezza ≤",
    es: "Flexibilidad ≤",
    pt: "Flexibilidade ≤",
  },
  complianceHint: {
    en: "Upper bound on compliance, in the model's work units",
    de: "Obergrenze der Nachgiebigkeit, in den Arbeitseinheiten des Modells",
    fr: "Borne supérieure de la souplesse, en unités de travail du modèle",
    it: "Limite superiore della cedevolezza, nelle unità di lavoro del modello",
    es: "Cota superior de la flexibilidad, en unidades de trabajo del modelo",
    pt: "Limite superior da flexibilidade, nas unidades de trabalho do modelo",
  },
  complianceStressHint: {
    en: "Upper bound on compliance, in the model's work units — leave blank to bound the volume by stress alone",
    de: "Obergrenze der Nachgiebigkeit, in den Arbeitseinheiten des Modells – leer lassen, um das Volumen nur über die Spannung zu begrenzen",
    fr: "Borne supérieure de la souplesse, en unités de travail du modèle — laissez vide pour borner le volume par la contrainte seule",
    it: "Limite superiore della cedevolezza, nelle unità di lavoro del modello — lascia vuoto per limitare il volume solo con la tensione",
    es: "Cota superior de la flexibilidad, en unidades de trabajo del modelo; déjalo vacío para limitar el volumen solo por tensión",
    pt: "Limite superior da flexibilidade, nas unidades de trabalho do modelo — deixe em branco para limitar o volume só pela tensão",
  },
  maxStressConstraint: {
    en: "Max von Mises stress",
    de: "Max. Von-Mises-Spannung",
    fr: "Contrainte de von Mises max.",
    it: "Tensione di von Mises max.",
    es: "Tensión de von Mises máx.",
    pt: "Tensão de von Mises máx.",
  },
  maxStressHint: {
    en: (unit: string) =>
      `Stress limit σ_allow in ${unit}, on the relaxed element von Mises stress (all-solid models)`,
    de: (unit: string) =>
      `Spannungsgrenze σ_allow in ${unit}, auf die relaxierte Von-Mises-Elementspannung (reine Volumenmodelle)`,
    fr: (unit: string) =>
      `Limite de contrainte σ_allow en ${unit}, sur la contrainte de von Mises relaxée des éléments (modèles entièrement volumiques)`,
    it: (unit: string) =>
      `Limite di tensione σ_allow in ${unit}, sulla tensione di von Mises rilassata degli elementi (modelli interamente solidi)`,
    es: (unit: string) =>
      `Límite de tensión σ_allow en ${unit}, sobre la tensión de von Mises relajada de los elementos (modelos totalmente sólidos)`,
    pt: (unit: string) =>
      `Limite de tensão σ_allow em ${unit}, sobre a tensão de von Mises relaxada dos elementos (modelos totalmente sólidos)`,
  },
  levelSetParameters: {
    en: "Level-set parameters",
    de: "Level-Set-Parameter",
    fr: "Paramètres level set",
    it: "Parametri level set",
    es: "Parámetros level set",
    pt: "Parâmetros level set",
  },
  lengthScale: {
    en: "Length ℓ",
    de: "Länge ℓ",
    fr: "Longueur ℓ",
    it: "Lunghezza ℓ",
    es: "Longitud ℓ",
    pt: "Comprimento ℓ",
  },
  lengthScaleHint: {
    en: "Smallest member/curvature scale, in model length units — about one element size keeps thin members",
    de: "Kleinste Stab-/Krümmungsskala, in Längeneinheiten des Modells – etwa eine Elementgröße erhält dünne Stäbe",
    fr: "Plus petite échelle de barre/courbure, en unités de longueur du modèle — environ une taille d'élément conserve les barres fines",
    it: "Scala minima di asta/curvatura, in unità di lunghezza del modello — circa una dimensione di elemento conserva le aste sottili",
    es: "Escala mínima de barra/curvatura, en unidades de longitud del modelo; un tamaño de elemento aproximadamente conserva las barras finas",
    pt: "Menor escala de barra/curvatura, em unidades de comprimento do modelo — cerca de um tamanho de elemento mantém as barras finas",
  },
  simpParameters: {
    en: "SIMP parameters",
    de: "SIMP-Parameter",
    fr: "Paramètres SIMP",
    it: "Parametri SIMP",
    es: "Parámetros SIMP",
    pt: "Parâmetros SIMP",
  },
  penalty: {
    en: "Penalty p",
    de: "Penalisierung p",
    fr: "Pénalisation p",
    it: "Penalizzazione p",
    es: "Penalización p",
    pt: "Penalização p",
  },
  penaltyHint: {
    en: "SIMP penalization exponent, ≥ 1 (typically 3)",
    de: "SIMP-Penalisierungsexponent, ≥ 1 (typisch 3)",
    fr: "Exposant de pénalisation SIMP, ≥ 1 (typiquement 3)",
    it: "Esponente di penalizzazione SIMP, ≥ 1 (tipicamente 3)",
    es: "Exponente de penalización SIMP, ≥ 1 (normalmente 3)",
    pt: "Expoente de penalização SIMP, ≥ 1 (tipicamente 3)",
  },
  filterRadius: {
    en: "Filter r_min",
    de: "Filter r_min",
    fr: "Filtre r_min",
    it: "Filtro r_min",
    es: "Filtro r_min",
    pt: "Filtro r_min",
  },
  filterRadiusHint: {
    en: "Density filter radius, in model length units",
    de: "Radius des Dichtefilters, in Längeneinheiten des Modells",
    fr: "Rayon du filtre de densité, en unités de longueur du modèle",
    it: "Raggio del filtro di densità, in unità di lunghezza del modello",
    es: "Radio del filtro de densidad, en unidades de longitud del modelo",
    pt: "Raio do filtro de densidade, em unidades de comprimento do modelo",
  },
  advanced: {
    en: "Advanced",
    de: "Erweitert",
    fr: "Avancé",
    it: "Avanzate",
    es: "Avanzado",
    pt: "Avançado",
  },
  moveLimit: {
    en: "Move limit",
    de: "Schrittgrenze",
    fr: "Limite de pas",
    it: "Limite di passo",
    es: "Límite de paso",
    pt: "Limite de passo",
  },
  moveLimitHint: {
    en: "MMA step cap per iteration, (0, 1] (default 0.2)",
    de: "MMA-Schrittbegrenzung je Iteration, (0, 1] (Standard 0.2)",
    fr: "Limite de pas MMA par itération, (0, 1] (défaut 0.2)",
    it: "Limite di passo MMA per iterazione, (0, 1] (predefinito 0.2)",
    es: "Límite de paso MMA por iteración, (0, 1] (por defecto 0.2)",
    pt: "Limite de passo MMA por iteração, (0, 1] (padrão 0.2)",
  },
  maxIterations: {
    en: "Max iters",
    de: "Max. Iterationen",
    fr: "Itér. max.",
    it: "Iteraz. max",
    es: "Iter. máx.",
    pt: "Iter. máx.",
  },
  maxIterationsHint: {
    en: "Iteration cap (whole number > 0)",
    de: "Iterationsgrenze (ganze Zahl > 0)",
    fr: "Nombre maximal d'itérations (entier > 0)",
    it: "Numero massimo di iterazioni (intero > 0)",
    es: "Límite de iteraciones (número entero > 0)",
    pt: "Limite de iterações (número inteiro > 0)",
  },
  tolerance: {
    en: "Tolerance",
    de: "Toleranz",
    fr: "Tolérance",
    it: "Tolleranza",
    es: "Tolerancia",
    pt: "Tolerância",
  },
  toleranceHint: {
    en: "Stop when max |Δρ| falls below this (> 0)",
    de: "Abbruch, wenn max |Δρ| darunter fällt (> 0)",
    fr: "Arrêt quand max |Δρ| passe sous cette valeur (> 0)",
    it: "Fermati quando max |Δρ| scende sotto questo valore (> 0)",
    es: "Se detiene cuando max |Δρ| baja de este valor (> 0)",
    pt: "Para quando max |Δρ| ficar abaixo deste valor (> 0)",
  },
  aggregation: {
    en: "Aggregation",
    de: "Aggregation",
    fr: "Agrégation",
    it: "Aggregazione",
    es: "Agregación",
    pt: "Agregação",
  },
  aggregationP: {
    en: "Aggregation P",
    de: "Aggregation P",
    fr: "Agrégation P",
    it: "Aggregazione P",
    es: "Agregación P",
    pt: "Agregação P",
  },
  pNormHint: {
    en: "P-norm exponent, ≥ 1 (default 8) — larger tracks the peak more tightly but converges less smoothly",
    de: "P-Norm-Exponent, ≥ 1 (Standard 8) – größer folgt dem Maximum genauer, konvergiert aber weniger glatt",
    fr: "Exposant de la norme P, ≥ 1 (défaut 8) — plus grand suit le pic de plus près mais converge moins régulièrement",
    it: "Esponente della norma P, ≥ 1 (predefinito 8) — più grande segue il picco più da vicino ma converge in modo meno regolare",
    es: "Exponente de la norma P, ≥ 1 (por defecto 8): más alto sigue el pico más de cerca pero converge con menos suavidad",
    pt: "Expoente da norma P, ≥ 1 (padrão 8) — maior acompanha o pico mais de perto, mas converge com menos suavidade",
  },
  ksHint: {
    en: "KS parameter, ≥ 1 (default 40) — larger tracks the peak more tightly but converges less smoothly",
    de: "KS-Parameter, ≥ 1 (Standard 40) – größer folgt dem Maximum genauer, konvergiert aber weniger glatt",
    fr: "Paramètre KS, ≥ 1 (défaut 40) — plus grand suit le pic de plus près mais converge moins régulièrement",
    it: "Parametro KS, ≥ 1 (predefinito 40) — più grande segue il picco più da vicino ma converge in modo meno regolare",
    es: "Parámetro KS, ≥ 1 (por defecto 40): más alto sigue el pico más de cerca pero converge con menos suavidad",
    pt: "Parâmetro KS, ≥ 1 (padrão 40) — maior acompanha o pico mais de perto, mas converge com menos suavidade",
  },
  optimizing: {
    en: "Optimizing…",
    de: "Wird optimiert…",
    fr: "Optimisation…",
    it: "Ottimizzazione…",
    es: "Optimizando…",
    pt: "Otimizando…",
  },
  runOptimization: {
    en: "▶  Run optimization",
    de: "▶  Optimierung starten",
    fr: "▶  Lancer l'optimisation",
    it: "▶  Avvia ottimizzazione",
    es: "▶  Ejecutar optimización",
    pt: "▶  Executar otimização",
  },
  cancel: {
    en: "Cancel",
    de: "Abbrechen",
    fr: "Annuler",
    it: "Annulla",
    es: "Cancelar",
    pt: "Cancelar",
  },
  requirementGot: {
    en: (requirement: string, raw: string) => `${requirement} — got "${raw}"`,
    de: (requirement: string, raw: string) =>
      `${requirement} – eingegeben: „${raw}“`,
    fr: (requirement: string, raw: string) =>
      `${requirement} — saisi : « ${raw} »`,
    it: (requirement: string, raw: string) =>
      `${requirement} — inserito "${raw}"`,
    es: (requirement: string, raw: string) =>
      `${requirement}; se introdujo "${raw}"`,
    pt: (requirement: string, raw: string) =>
      `${requirement} — digitado "${raw}"`,
  },
  penaltyRequirement: {
    en: "penalty p ≥ 1",
    de: "Penalisierung p ≥ 1",
    fr: "pénalisation p ≥ 1",
    it: "penalizzazione p ≥ 1",
    es: "penalización p ≥ 1",
    pt: "penalização p ≥ 1",
  },
  filterRequirement: {
    en: "filter radius r_min > 0",
    de: "Filterradius r_min > 0",
    fr: "rayon de filtre r_min > 0",
    it: "raggio del filtro r_min > 0",
    es: "radio del filtro r_min > 0",
    pt: "raio do filtro r_min > 0",
  },
  lengthRequirement: {
    en: "length scale ℓ > 0",
    de: "Längenskala ℓ > 0",
    fr: "échelle de longueur ℓ > 0",
    it: "scala di lunghezza ℓ > 0",
    es: "escala de longitud ℓ > 0",
    pt: "escala de comprimento ℓ > 0",
  },
  moveLimitRequirement: {
    en: "move limit in (0, 1]",
    de: "Schrittgrenze in (0, 1]",
    fr: "limite de pas dans (0, 1]",
    it: "limite di passo in (0, 1]",
    es: "límite de paso en (0, 1]",
    pt: "limite de passo em (0, 1]",
  },
  maxIterationsRequirement: {
    en: "max iterations must be a whole number > 0",
    de: "max. Iterationen muss eine ganze Zahl > 0 sein",
    fr: "le nombre max. d'itérations doit être un entier > 0",
    it: "le iterazioni max devono essere un intero > 0",
    es: "las iteraciones máx. deben ser un número entero > 0",
    pt: "as iterações máx. devem ser um número inteiro > 0",
  },
  toleranceRequirement: {
    en: "tolerance > 0",
    de: "Toleranz > 0",
    fr: "tolérance > 0",
    it: "tolleranza > 0",
    es: "tolerancia > 0",
    pt: "tolerância > 0",
  },
  volumeFractionRequirement: {
    en: "volume fraction in (0, 1)",
    de: "Volumenanteil in (0, 1)",
    fr: "fraction volumique dans (0, 1)",
    it: "frazione di volume in (0, 1)",
    es: "fracción de volumen en (0, 1)",
    pt: "fração de volume em (0, 1)",
  },
  complianceOrBlankRequirement: {
    en: "compliance limit > 0, or blank for none",
    de: "Nachgiebigkeitsgrenze > 0, oder leer für keine",
    fr: "limite de souplesse > 0, ou vide pour aucune",
    it: "limite di cedevolezza > 0, o vuoto per nessuno",
    es: "límite de flexibilidad > 0, o vacío para ninguno",
    pt: "limite de flexibilidade > 0, ou em branco para nenhum",
  },
  complianceRequirement: {
    en: "compliance limit > 0",
    de: "Nachgiebigkeitsgrenze > 0",
    fr: "limite de souplesse > 0",
    it: "limite di cedevolezza > 0",
    es: "límite de flexibilidad > 0",
    pt: "limite de flexibilidade > 0",
  },
  maxStressRequirement: {
    en: "max stress σ_allow > 0",
    de: "max. Spannung σ_allow > 0",
    fr: "contrainte max. σ_allow > 0",
    it: "tensione max σ_allow > 0",
    es: "tensión máx. σ_allow > 0",
    pt: "tensão máx. σ_allow > 0",
  },
  aggregationRequirement: {
    en: "aggregation P ≥ 1",
    de: "Aggregation P ≥ 1",
    fr: "agrégation P ≥ 1",
    it: "aggregazione P ≥ 1",
    es: "agregación P ≥ 1",
    pt: "agregação P ≥ 1",
  },
  settingsInvalid: {
    en: (errors: string) => `Optimization settings are invalid: ${errors}`,
    de: (errors: string) =>
      `Die Optimierungseinstellungen sind ungültig: ${errors}`,
    fr: (errors: string) =>
      `Les paramètres d'optimisation ne sont pas valides : ${errors}`,
    it: (errors: string) =>
      `Le impostazioni di ottimizzazione non sono valide: ${errors}`,
    es: (errors: string) =>
      `Los ajustes de optimización no son válidos: ${errors}`,
    pt: (errors: string) =>
      `As configurações de otimização são inválidas: ${errors}`,
  },
  optimizationError: {
    en: (reason: string) => `Optimization error: ${reason}`,
    de: (reason: string) => `Optimierungsfehler: ${reason}`,
    fr: (reason: string) => `Erreur d'optimisation : ${reason}`,
    it: (reason: string) => `Errore di ottimizzazione: ${reason}`,
    es: (reason: string) => `Error de optimización: ${reason}`,
    pt: (reason: string) => `Erro de otimização: ${reason}`,
  },
  rerunBlocked: {
    en: "Could not run the optimization again: resolve the failed pre-flight checks on the Optimize panel first.",
    de: "Die Optimierung konnte nicht erneut gestartet werden: beheben Sie zuerst die fehlgeschlagenen Vorabprüfungen im Optimierungs-Bereich.",
    fr: "Impossible de relancer l'optimisation : corrigez d'abord les vérifications préalables en échec dans le panneau Optimiser.",
    it: "Impossibile ripetere l'ottimizzazione: risolvi prima i controlli preliminari non superati nel pannello Ottimizza.",
    es: "No se pudo repetir la optimización: resuelve primero las comprobaciones previas fallidas en el panel Optimizar.",
    pt: "Não foi possível executar a otimização novamente: resolva primeiro as verificações prévias reprovadas no painel Otimizar.",
  },
  stressSummary: {
    en: (limit: string, unit: string) => ` · σ_vm ≤ ${limit} ${unit}`,
    de: (limit: string, unit: string) => ` · σ_vm ≤ ${limit} ${unit}`,
    fr: (limit: string, unit: string) => ` · σ_vm ≤ ${limit} ${unit}`,
    it: (limit: string, unit: string) => ` · σ_vm ≤ ${limit} ${unit}`,
    es: (limit: string, unit: string) => ` · σ_vm ≤ ${limit} ${unit}`,
    pt: (limit: string, unit: string) => ` · σ_vm ≤ ${limit} ${unit}`,
  },
  complianceSummary: {
    en: (limit: string) => ` · compliance ≤ ${limit}`,
    de: (limit: string) => ` · Nachgiebigkeit ≤ ${limit}`,
    fr: (limit: string) => ` · souplesse ≤ ${limit}`,
    it: (limit: string) => ` · cedevolezza ≤ ${limit}`,
    es: (limit: string) => ` · flexibilidad ≤ ${limit}`,
    pt: (limit: string) => ` · flexibilidade ≤ ${limit}`,
  },
  levelSetSummary: {
    en: (volfrac: string, length: string) =>
      `Level set · minimize compliance · volfrac ${volfrac} · ℓ=${length}`,
    de: (volfrac: string, length: string) =>
      `Level-Set · Nachgiebigkeit minimieren · Volumenanteil ${volfrac} · ℓ=${length}`,
    fr: (volfrac: string, length: string) =>
      `Level set · minimiser la souplesse · fraction vol. ${volfrac} · ℓ=${length}`,
    it: (volfrac: string, length: string) =>
      `Level set · minimizza la cedevolezza · frazione vol. ${volfrac} · ℓ=${length}`,
    es: (volfrac: string, length: string) =>
      `Level set · minimizar flexibilidad · fracción vol. ${volfrac} · ℓ=${length}`,
    pt: (volfrac: string, length: string) =>
      `Level set · minimizar flexibilidade · fração vol. ${volfrac} · ℓ=${length}`,
  },
  minComplianceSummary: {
    en: (volfrac: string, stress: string, penalty: string, radius: string) =>
      `Minimize compliance · volfrac ${volfrac}${stress} · p=${penalty} · r_min=${radius}`,
    de: (volfrac: string, stress: string, penalty: string, radius: string) =>
      `Nachgiebigkeit minimieren · Volumenanteil ${volfrac}${stress} · p=${penalty} · r_min=${radius}`,
    fr: (volfrac: string, stress: string, penalty: string, radius: string) =>
      `Minimiser la souplesse · fraction vol. ${volfrac}${stress} · p=${penalty} · r_min=${radius}`,
    it: (volfrac: string, stress: string, penalty: string, radius: string) =>
      `Minimizza la cedevolezza · frazione vol. ${volfrac}${stress} · p=${penalty} · r_min=${radius}`,
    es: (volfrac: string, stress: string, penalty: string, radius: string) =>
      `Minimizar flexibilidad · fracción vol. ${volfrac}${stress} · p=${penalty} · r_min=${radius}`,
    pt: (volfrac: string, stress: string, penalty: string, radius: string) =>
      `Minimizar flexibilidade · fração vol. ${volfrac}${stress} · p=${penalty} · r_min=${radius}`,
  },
  minVolumeSummary: {
    en: (compliance: string, stress: string, penalty: string, radius: string) =>
      `Minimize volume${compliance}${stress} · p=${penalty} · r_min=${radius}`,
    de: (compliance: string, stress: string, penalty: string, radius: string) =>
      `Volumen minimieren${compliance}${stress} · p=${penalty} · r_min=${radius}`,
    fr: (compliance: string, stress: string, penalty: string, radius: string) =>
      `Minimiser le volume${compliance}${stress} · p=${penalty} · r_min=${radius}`,
    it: (compliance: string, stress: string, penalty: string, radius: string) =>
      `Minimizza il volume${compliance}${stress} · p=${penalty} · r_min=${radius}`,
    es: (compliance: string, stress: string, penalty: string, radius: string) =>
      `Minimizar volumen${compliance}${stress} · p=${penalty} · r_min=${radius}`,
    pt: (compliance: string, stress: string, penalty: string, radius: string) =>
      `Minimizar volume${compliance}${stress} · p=${penalty} · r_min=${radius}`,
  },
  solidElements: {
    en: (count: number) => `${count} solid element${count === 1 ? "" : "s"}`,
    de: (count: number) =>
      `${count} ${count === 1 ? "Volumenelement" : "Volumenelemente"}`,
    fr: (count: number) =>
      `${count} élément${count === 1 ? "" : "s"} volumique${count === 1 ? "" : "s"}`,
    it: (count: number) =>
      `${count} ${count === 1 ? "elemento solido" : "elementi solidi"}`,
    es: (count: number) =>
      `${count} ${count === 1 ? "elemento sólido" : "elementos sólidos"}`,
    pt: (count: number) =>
      `${count} ${count === 1 ? "elemento sólido" : "elementos sólidos"}`,
  },
  shellFacets: {
    en: (count: number) => `${count} shell facet${count === 1 ? "" : "s"}`,
    de: (count: number) =>
      `${count} ${count === 1 ? "Schalenfacette" : "Schalenfacetten"}`,
    fr: (count: number) => `${count} facette${count === 1 ? "" : "s"} de coque`,
    it: (count: number) =>
      `${count} ${count === 1 ? "faccetta guscio" : "faccette guscio"}`,
    es: (count: number) =>
      `${count} ${count === 1 ? "faceta de lámina" : "facetas de lámina"}`,
    pt: (count: number) =>
      `${count} ${count === 1 ? "faceta de casca" : "facetas de casca"}`,
  },
  couplingsHeld: {
    en: (count: number) =>
      ` (${count} coupling${count === 1 ? "" : "s"} held fixed)`,
    de: (count: number) =>
      ` (${count} ${count === 1 ? "Kopplung" : "Kopplungen"} fest)`,
    fr: (count: number) =>
      ` (${count} couplage${count === 1 ? "" : "s"} maintenu${count === 1 ? "" : "s"} fixe${count === 1 ? "" : "s"})`,
    it: (count: number) =>
      ` (${count} ${count === 1 ? "accoppiamento tenuto fisso" : "accoppiamenti tenuti fissi"})`,
    es: (count: number) =>
      ` (${count} ${count === 1 ? "acoplamiento fijo" : "acoplamientos fijos"})`,
    pt: (count: number) =>
      ` (${count} ${count === 1 ? "acoplamento mantido fixo" : "acoplamentos mantidos fixos"})`,
  },
  noLoads: {
    en: "No loads — topology optimization needs an applied load",
    de: "Keine Lasten – die Topologieoptimierung braucht eine Last",
    fr: "Aucune charge — l'optimisation topologique exige une charge",
    it: "Nessun carico — l'ottimizzazione topologica richiede un carico",
    es: "Sin cargas: la optimización topológica necesita una carga",
    pt: "Nenhuma carga — a otimização topológica precisa de uma carga",
  },
  fixSettings: {
    en: (errors: string) => `Fix the optimization settings: ${errors}`,
    de: (errors: string) =>
      `Korrigieren Sie die Optimierungseinstellungen: ${errors}`,
    fr: (errors: string) =>
      `Corrigez les paramètres d'optimisation : ${errors}`,
    it: (errors: string) =>
      `Correggi le impostazioni di ottimizzazione: ${errors}`,
    es: (errors: string) => `Corrige los ajustes de optimización: ${errors}`,
    pt: (errors: string) => `Corrija as configurações de otimização: ${errors}`,
  },
  oneMaterial: {
    en: (count: number) =>
      `Topology optimization uses one design material, but the model spans ${count} — assign a single material to all bodies`,
    de: (count: number) =>
      `Die Topologieoptimierung verwendet einen Design-Werkstoff, das Modell hat aber ${count} – weisen Sie allen Körpern denselben Werkstoff zu`,
    fr: (count: number) =>
      `L'optimisation topologique utilise un seul matériau de conception, mais le modèle en compte ${count} — affectez un seul matériau à tous les corps`,
    it: (count: number) =>
      `L'ottimizzazione topologica usa un solo materiale di progetto, ma il modello ne ha ${count} — assegna un unico materiale a tutti i corpi`,
    es: (count: number) =>
      `La optimización topológica usa un solo material de diseño, pero el modelo tiene ${count}: asigna un único material a todos los cuerpos`,
    pt: (count: number) =>
      `A otimização topológica usa um só material de projeto, mas o modelo tem ${count} — atribua um único material a todos os corpos`,
  },
  oneMaterialPerDomain: {
    en: (solid: number, shell: number) =>
      `Topology optimization uses one material per design domain — the solid domain spans ${solid} and the shell domain ${shell}; assign a single material to each`,
    de: (solid: number, shell: number) =>
      `Die Topologieoptimierung verwendet einen Werkstoff je Designbereich – der Volumenbereich hat ${solid} und der Schalenbereich ${shell}; weisen Sie jedem einen einzigen Werkstoff zu`,
    fr: (solid: number, shell: number) =>
      `L'optimisation topologique utilise un matériau par domaine de conception — le domaine volumique en compte ${solid} et le domaine coque ${shell} ; affectez un seul matériau à chacun`,
    it: (solid: number, shell: number) =>
      `L'ottimizzazione topologica usa un materiale per dominio di progetto — il dominio solido ne ha ${solid} e il dominio a gusci ${shell}; assegna un unico materiale a ciascuno`,
    es: (solid: number, shell: number) =>
      `La optimización topológica usa un material por dominio de diseño: el dominio sólido tiene ${solid} y el de láminas ${shell}; asigna un único material a cada uno`,
    pt: (solid: number, shell: number) =>
      `A otimização topológica usa um material por domínio de projeto — o domínio sólido tem ${solid} e o domínio de cascas ${shell}; atribua um único material a cada um`,
  },
  noDesignRegion: {
    en: "Every region is set to Keep solid or Keep empty — set at least one to Design so the optimizer has material to shape",
    de: "Jeder Bereich ist auf „Fest erhalten“ oder „Leer erhalten“ gesetzt – setzen Sie mindestens einen auf „Design“, damit der Optimierer Material formen kann",
    fr: "Chaque région est réglée sur Garder plein ou Garder vide — réglez-en au moins une sur Conception pour que l'optimiseur ait de la matière à façonner",
    it: "Ogni regione è impostata su Mantieni piena o Mantieni vuota — impostane almeno una su Progetto perché l'ottimizzatore abbia materiale da modellare",
    es: "Todas las regiones están en Mantener sólida o Mantener vacía: pon al menos una en Diseño para que el optimizador tenga material que modelar",
    pt: "Toda região está como Manter sólida ou Manter vazia — defina pelo menos uma como Projeto para que o otimizador tenha material a moldar",
  },
  levelSetShells: {
    en: "The level-set method supports solid models only — use SIMP for shell and coupled models",
    de: "Die Level-Set-Methode unterstützt nur Volumenmodelle – verwenden Sie SIMP für Schalen- und gekoppelte Modelle",
    fr: "La méthode level set ne prend en charge que les modèles volumiques — utilisez SIMP pour les modèles coque et couplés",
    it: "Il metodo level set supporta solo modelli solidi — usa SIMP per modelli a gusci e accoppiati",
    es: "El método level set solo admite modelos sólidos: usa SIMP para modelos de láminas y acoplados",
    pt: "O método level set aceita apenas modelos sólidos — use SIMP para modelos de cascas e acoplados",
  },
  levelSetCouplings: {
    en: "The level-set method does not support couplings yet — remove them, or use SIMP",
    de: "Die Level-Set-Methode unterstützt noch keine Kopplungen – entfernen Sie sie oder verwenden Sie SIMP",
    fr: "La méthode level set ne prend pas encore en charge les couplages — supprimez-les, ou utilisez SIMP",
    it: "Il metodo level set non supporta ancora gli accoppiamenti — rimuovili, o usa SIMP",
    es: "El método level set aún no admite acoplamientos: elimínalos, o usa SIMP",
    pt: "O método level set ainda não aceita acoplamentos — remova-os, ou use SIMP",
  },
  levelSetObjective: {
    en: "The level-set method minimizes compliance only — switch the objective, or use SIMP",
    de: "Die Level-Set-Methode minimiert nur die Nachgiebigkeit – wechseln Sie die Zielfunktion oder verwenden Sie SIMP",
    fr: "La méthode level set ne minimise que la souplesse — changez d'objectif, ou utilisez SIMP",
    it: "Il metodo level set minimizza solo la cedevolezza — cambia obiettivo, o usa SIMP",
    es: "El método level set solo minimiza la flexibilidad: cambia el objetivo, o usa SIMP",
    pt: "O método level set minimiza apenas a flexibilidade — mude o objetivo, ou use SIMP",
  },
  prescribedDisplacements: {
    en: "Remove non-zero prescribed displacements — topology optimization supports fixed (zero) supports only",
    de: "Entfernen Sie vorgegebene Verschiebungen ungleich null – die Topologieoptimierung unterstützt nur feste (Null-)Lagerungen",
    fr: "Supprimez les déplacements imposés non nuls — l'optimisation topologique ne prend en charge que les appuis fixes (nuls)",
    it: "Rimuovi gli spostamenti imposti non nulli — l'ottimizzazione topologica supporta solo vincoli fissi (nulli)",
    es: "Elimina los desplazamientos impuestos no nulos: la optimización topológica solo admite apoyos fijos (nulos)",
    pt: "Remova os deslocamentos prescritos não nulos — a otimização topológica aceita apenas apoios fixos (nulos)",
  },
  stressOnShells: {
    en: "The max-stress constraint supports all-solid models without couplings only — turn it off to optimize this shell/coupled model",
    de: "Die Spannungsnebenbedingung unterstützt nur reine Volumenmodelle ohne Kopplungen – schalten Sie sie aus, um dieses Schalen-/gekoppelte Modell zu optimieren",
    fr: "La contrainte de contrainte max. ne prend en charge que les modèles entièrement volumiques sans couplage — désactivez-la pour optimiser ce modèle coque/couplé",
    it: "Il vincolo di tensione massima supporta solo modelli interamente solidi senza accoppiamenti — disattivalo per ottimizzare questo modello a gusci/accoppiato",
    es: "La restricción de tensión máxima solo admite modelos totalmente sólidos sin acoplamientos: desactívala para optimizar este modelo de láminas/acoplado",
    pt: "A restrição de tensão máxima aceita apenas modelos totalmente sólidos sem acoplamentos — desative-a para otimizar este modelo de cascas/acoplado",
  },
  notConverged: {
    en: (iterations: number) =>
      `Not converged: the optimization stopped at its limit of ${iterations} iterations, so the design may still change.`,
    de: (iterations: number) =>
      `Nicht konvergiert: Die Optimierung hat an ihrer Grenze von ${iterations} Iterationen angehalten, das Design kann sich also noch ändern.`,
    fr: (iterations: number) =>
      `Non convergé : l'optimisation s'est arrêtée à sa limite de ${iterations} itérations, la forme peut donc encore changer.`,
    it: (iterations: number) =>
      `Non a convergenza: l'ottimizzazione si è fermata al limite di ${iterations} iterazioni, quindi il progetto può ancora cambiare.`,
    es: (iterations: number) =>
      `No convergió: la optimización se detuvo en su límite de ${iterations} iteraciones, así que el diseño aún puede cambiar.`,
    pt: (iterations: number) =>
      `Não convergiu: a otimização parou no limite de ${iterations} iterações, então o projeto ainda pode mudar.`,
  },
  runAgain: {
    en: (iterations: number) => `Run again with ${iterations} iterations`,
    de: (iterations: number) => `Erneut mit ${iterations} Iterationen starten`,
    fr: (iterations: number) => `Relancer avec ${iterations} itérations`,
    it: (iterations: number) => `Ripeti con ${iterations} iterazioni`,
    es: (iterations: number) => `Repetir con ${iterations} iteraciones`,
    pt: (iterations: number) =>
      `Executar novamente com ${iterations} iterações`,
  },
  starting: {
    en: "Optimizing · starting",
    de: "Optimierung · startet",
    fr: "Optimisation · démarrage",
    it: "Ottimizzazione · avvio",
    es: "Optimizando · iniciando",
    pt: "Otimizando · iniciando",
  },
  iterationOf: {
    en: (iteration: number, max: string) =>
      `Optimizing · iteration ${iteration} of ${max}`,
    de: (iteration: number, max: string) =>
      `Optimierung · Iteration ${iteration} von ${max}`,
    fr: (iteration: number, max: string) =>
      `Optimisation · itération ${iteration} sur ${max}`,
    it: (iteration: number, max: string) =>
      `Ottimizzazione · iterazione ${iteration} di ${max}`,
    es: (iteration: number, max: string) =>
      `Optimizando · iteración ${iteration} de ${max}`,
    pt: (iteration: number, max: string) =>
      `Otimizando · iteração ${iteration} de ${max}`,
  },
  convergedAfter: {
    en: (iterations: number) => `Converged after ${iterations} iterations`,
    de: (iterations: number) => `Konvergiert nach ${iterations} Iterationen`,
    fr: (iterations: number) => `Convergé après ${iterations} itérations`,
    it: (iterations: number) => `A convergenza dopo ${iterations} iterazioni`,
    es: (iterations: number) => `Convergió tras ${iterations} iteraciones`,
    pt: (iterations: number) => `Convergiu após ${iterations} iterações`,
  },
  stoppedAtLimit: {
    en: (iterations: number) =>
      `Not converged: stopped at the ${iterations}-iteration limit`,
    de: (iterations: number) =>
      `Nicht konvergiert: an der Grenze von ${iterations} Iterationen angehalten`,
    fr: (iterations: number) =>
      `Non convergé : arrêté à la limite de ${iterations} itérations`,
    it: (iterations: number) =>
      `Non a convergenza: fermata al limite di ${iterations} iterazioni`,
    es: (iterations: number) =>
      `No convergió: se detuvo en el límite de ${iterations} iteraciones`,
    pt: (iterations: number) =>
      `Não convergiu: parou no limite de ${iterations} iterações`,
  },
  densityIn3d: {
    en: "Density in 3D",
    de: "Dichte in 3D",
    fr: "Densité en 3D",
    it: "Densità in 3D",
    es: "Densidad en 3D",
    pt: "Densidade em 3D",
  },
  liveRun: {
    en: "Live, as the run goes",
    de: "Live, während der Lauf läuft",
    fr: "En direct, pendant le calcul",
    it: "In tempo reale, durante il calcolo",
    es: "En directo, mientras se calcula",
    pt: "Ao vivo, durante a execução",
  },
  convergenceChart: {
    en: "Convergence chart",
    de: "Konvergenzdiagramm",
    fr: "Graphique de convergence",
    it: "Grafico di convergenza",
    es: "Gráfico de convergencia",
    pt: "Gráfico de convergência",
  },
  runSummary: {
    en: "Run summary",
    de: "Laufübersicht",
    fr: "Résumé du calcul",
    it: "Riepilogo del calcolo",
    es: "Resumen del cálculo",
    pt: "Resumo da execução",
  },
  iterations: {
    en: "Iterations",
    de: "Iterationen",
    fr: "Itérations",
    it: "Iterazioni",
    es: "Iteraciones",
    pt: "Iterações",
  },
  finalVolumeFraction: {
    en: "Final volume frac.",
    de: "Volumenanteil am Ende",
    fr: "Fraction vol. finale",
    it: "Frazione vol. finale",
    es: "Fracción vol. final",
    pt: "Fração vol. final",
  },
  finalCompliance: {
    en: "Final compliance",
    de: "Nachgiebigkeit am Ende",
    fr: "Souplesse finale",
    it: "Cedevolezza finale",
    es: "Flexibilidad final",
    pt: "Flexibilidade final",
  },
  maxVonMises: {
    en: "Max von Mises",
    de: "Max. Von-Mises",
    fr: "Von Mises max.",
    it: "Von Mises max",
    es: "Von Mises máx.",
    pt: "Von Mises máx.",
  },
  stressLimit: {
    en: (limit: string) => ` (limit ${limit})`,
    de: (limit: string) => ` (Grenze ${limit})`,
    fr: (limit: string) => ` (limite ${limit})`,
    it: (limit: string) => ` (limite ${limit})`,
    es: (limit: string) => ` (límite ${limit})`,
    pt: (limit: string) => ` (limite ${limit})`,
  },
  densityRange: {
    en: "Density range",
    de: "Dichtebereich",
    fr: "Plage de densité",
    it: "Intervallo di densità",
    es: "Rango de densidad",
    pt: "Faixa de densidade",
  },
  export: {
    en: "Export",
    de: "Export",
    fr: "Export",
    it: "Esporta",
    es: "Exportar",
    pt: "Exportar",
  },
  exportStl: {
    en: "Export shape as STL",
    de: "Form als STL exportieren",
    fr: "Exporter la forme en STL",
    it: "Esporta la forma in STL",
    es: "Exportar forma como STL",
    pt: "Exportar forma como STL",
  },
  nothingKept: {
    en: "No material is kept at this threshold — lower it to export a shape.",
    de: "Bei diesem Schwellwert bleibt kein Material erhalten – senken Sie ihn, um eine Form zu exportieren.",
    fr: "Aucune matière n'est conservée à ce seuil — abaissez-le pour exporter une forme.",
    it: "A questa soglia non resta materiale — abbassala per esportare una forma.",
    es: "Con este umbral no se conserva material: bájalo para exportar una forma.",
    pt: "Nenhum material é mantido neste limiar — reduza-o para exportar uma forma.",
  },
  smoothExport: {
    en: "The smooth surface shown at the current threshold, in model units.",
    de: "Die beim aktuellen Schwellwert gezeigte glatte Oberfläche, in Modelleinheiten.",
    fr: "La surface lisse affichée au seuil actuel, en unités du modèle.",
    it: "La superficie liscia mostrata alla soglia attuale, in unità del modello.",
    es: "La superficie suave mostrada con el umbral actual, en unidades del modelo.",
    pt: "A superfície suave mostrada no limiar atual, em unidades do modelo.",
  },
  facetedExport: {
    en: "Faceted surface of the elements shown at the current threshold, in model units.",
    de: "Facettierte Oberfläche der beim aktuellen Schwellwert gezeigten Elemente, in Modelleinheiten.",
    fr: "Surface à facettes des éléments affichés au seuil actuel, en unités du modèle.",
    it: "Superficie a faccette degli elementi mostrati alla soglia attuale, in unità del modello.",
    es: "Superficie facetada de los elementos mostrados con el umbral actual, en unidades del modelo.",
    pt: "Superfície facetada dos elementos mostrados no limiar atual, em unidades do modelo.",
  },
  chartField: {
    en: "Chart field",
    de: "Diagrammgröße",
    fr: "Grandeur du graphique",
    it: "Grandezza del grafico",
    es: "Magnitud del gráfico",
    pt: "Grandeza do gráfico",
  },
  compliance: {
    en: "Compliance",
    de: "Nachgiebigkeit",
    fr: "Souplesse",
    it: "Cedevolezza",
    es: "Flexibilidad",
    pt: "Flexibilidade",
  },
  volume: {
    en: "Volume",
    de: "Volumen",
    fr: "Volume",
    it: "Volume",
    es: "Volumen",
    pt: "Volume",
  },
  stress: {
    en: "Stress",
    de: "Spannung",
    fr: "Contrainte",
    it: "Tensione",
    es: "Tensión",
    pt: "Tensão",
  },
  volumeFractionAxis: {
    en: "Volume fraction",
    de: "Volumenanteil",
    fr: "Fraction volumique",
    it: "Frazione di volume",
    es: "Fracción de volumen",
    pt: "Fração de volume",
  },
  stressAxis: {
    en: (unit: string) => `Von Mises stress (${unit})`,
    de: (unit: string) => `Von-Mises-Spannung (${unit})`,
    fr: (unit: string) => `Contrainte de von Mises (${unit})`,
    it: (unit: string) => `Tensione di von Mises (${unit})`,
    es: (unit: string) => `Tensión de von Mises (${unit})`,
    pt: (unit: string) => `Tensão de von Mises (${unit})`,
  },
  target: {
    en: "Target",
    de: "Ziel",
    fr: "Cible",
    it: "Obiettivo",
    es: "Objetivo",
    pt: "Meta",
  },
  limit: {
    en: "Limit",
    de: "Grenze",
    fr: "Limite",
    it: "Limite",
    es: "Límite",
    pt: "Limite",
  },
  againstIteration: {
    en: (axis: string) => `${axis} against iteration`,
    de: (axis: string) => `${axis} über der Iteration`,
    fr: (axis: string) => `${axis} en fonction de l'itération`,
    it: (axis: string) => `${axis} in funzione dell'iterazione`,
    es: (axis: string) => `${axis} frente a la iteración`,
    pt: (axis: string) => `${axis} em função da iteração`,
  },
  firstIteration: {
    en: "The first iteration is on its way…",
    de: "Die erste Iteration ist unterwegs…",
    fr: "La première itération est en cours…",
    it: "La prima iterazione è in arrivo…",
    es: "La primera iteración está en camino…",
    pt: "A primeira iteração está a caminho…",
  },
  iterationValue: {
    en: (iteration: number, value: string) =>
      `Iteration ${iteration}: ${value}`,
    de: (iteration: number, value: string) =>
      `Iteration ${iteration}: ${value}`,
    fr: (iteration: number, value: string) =>
      `Itération ${iteration} : ${value}`,
    it: (iteration: number, value: string) =>
      `Iterazione ${iteration}: ${value}`,
    es: (iteration: number, value: string) =>
      `Iteración ${iteration}: ${value}`,
    pt: (iteration: number, value: string) => `Iteração ${iteration}: ${value}`,
  },
  iteration: {
    en: "Iteration",
    de: "Iteration",
    fr: "Itération",
    it: "Iterazione",
    es: "Iteración",
    pt: "Iteração",
  },
  aggregated: {
    en: "Aggregated (the constraint)",
    de: "Aggregiert (die Nebenbedingung)",
    fr: "Agrégée (la contrainte)",
    it: "Aggregata (il vincolo)",
    es: "Agregada (la restricción)",
    pt: "Agregada (a restrição)",
  },
  trueMax: {
    en: "True max",
    de: "Wahres Maximum",
    fr: "Max. réel",
    it: "Massimo reale",
    es: "Máximo real",
    pt: "Máximo real",
  },
});
