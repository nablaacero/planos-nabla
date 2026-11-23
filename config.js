// =====================================================================
//  CONFIGURACIÓN - Planos NABLA (extensión de Trimble Connect)
//  Colorea el modelo según la revisión de planos PDF vs listado vigente.
//  Este es el único archivo que normalmente hay que editar.
// =====================================================================
window.CONFIG = {
  // --- Archivo de revisión de planos dentro del proyecto de Trimble Connect ---
  // Se toma el archivo más reciente de esta carpeta cuyo nombre cumpla el patrón
  // (ej. "1274_Revision_Planos_PDF.xlsm"). Se lee la hoja "Resultado".
  carpetaRevision: "5_FAB/5.3_LISTADOS",
  patronArchivo: "revisi[oó]n[ _-]*planos",
  hojaResultado: "Resultado",

  // --- Estados y colores (del peor al mejor) ---
  etapas: [
    { nombre: "Falta plano",     color: "#D93025" },   // rojo   (FALTA PDF, FALTA PDF Y NC)
    { nombre: "Por revisar",     color: "#F28C28" },   // naranja (REVISAR, FALTA NC)
    { nombre: "Plano entregado", color: "#2EAA4A" }    // verde  (OK)
  ],
  nombreSinDato: "No está en la revisión",
  colorSinAvance: "#BDBDBD",           // marcas del modelo que no aparecen en el Excel
  atenuarResto: true,                  // objetos sin marca reconocida -> gris transparente

  // Cómo se traduce la columna "Resultado" del Excel a los estados de arriba
  // (1 = Falta plano, 2 = Por revisar, 3 = Plano entregado; lo demás no se pinta)
  resultados: [
    { patron: "^OK",           estado: 3 },
    { patron: "^REVISAR",      estado: 2 },
    { patron: "^FALTA NC",     estado: 2 },
    { patron: "^FALTA PDF",    estado: 1 }
  ],

  // --- Dónde buscar la marca del ENSAMBLE en las propiedades del modelo ---
  propiedadesMarca: [
    "Tekla Assembly.Assembly/Cast unit Mark",
    "Tekla Assembly.ASSEMBLY_POS",
    "Assembly.ASSEMBLY_POS",
    "Part Properties.Assembly Mark",
    "Nabla Aceros.MainPartMark",
    "Nabla Aceros.Main Part",
    "Nabla Aceros.Marca",
    "Identity Data.Mark",
    "Product.Name"          // solo en objetos ensamble
  ],

  // --- Dónde buscar la marca de la PIEZA (vista "Piezas sueltas") ---
  propiedadesPieza: [
    "Nabla Aceros.SinglePartMark",
    "Nabla Aceros.Single Part Mark",
    "Tekla Common.Part mark",
    "Part Properties.Part Mark",
    "Part Properties.PART_POS",
    "Identity Data.Part Mark"
  ],

  // Dónde buscar el peso (kg). Si el ensamble no lo trae, se suman sus piezas.
  propiedadesPeso: [
    "Assembly.WEIGHT",
    "Tekla Assembly.Weight",
    "Nabla Aceros.WeightNet_kg",
    "Tekla Common.Weight",
    "Part Properties.Weight"
  ],

  // Número de proyecto: primeros dígitos del nombre del proyecto de Trimble Connect
  patronProyecto: "^\\s*(\\d{3,5})",

  // Prefijos de marca secundarios (botones Est. principal / Solo secundarios)
  // CT/CF costaneras · BC bracones · GT canal pluvial · TS tensores
  prefijosOcultables: ["CT", "CF", "BC", "GT", "TS"],
  ocultarTornillos: true,

  // Grupos del proyecto de Trimble Connect que NO pueden usar la extensión
  gruposBloqueados: ["EXTERNO"],

  // Sin SharePoint en esta extensión
  clientId: "",

  // Actualización automática mientras el panel está abierto (minutos, 0 = no)
  autoActualizarMin: 10
};
