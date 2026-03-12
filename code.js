// ─── DESDOBRAMENTO PS — index.js ─────────────────────────────────────────────
const { app, core, action, constants } = require("photoshop");
const { executeAsModal } = core;
const { batchPlay } = action;

// ── Pega artboard selecionado ─────────────────────────────────────────────────
function getSelectedArtboard() {
  const doc = app.activeDocument;
  if (!doc) return null;
  const sel = doc.activeLayers;
  if (!sel || !sel.length) return null;
  const layer = sel[0];
  // LayerKind 16 = Artboard no Photoshop
  if (layer.kind === constants.LayerKind.ARTBOARD) return layer;
  return null;
}

// ── Calcula centro de massa dos layers filhos (não-texto) ─────────────────────
function getSubjectCenter(artboard) {
  const layers = artboard.layers || [];
  const visuals = layers.filter(l =>
    l.kind !== constants.LayerKind.TEXT && l.visible
  );
  if (!visuals.length) {
    return { x: artboard.bounds.width / 2, y: artboard.bounds.height / 2 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of visuals) {
    const b = l.bounds;
    minX = Math.min(minX, b.left);
    minY = Math.min(minY, b.top);
    maxX = Math.max(maxX, b.right);
    maxY = Math.max(maxY, b.bottom);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// ── Duplica artboard via batchPlay ───────────────────────────────────────────
async function duplicateArtboard(artboard, newName) {
  await batchPlay([
    {
      _obj: "duplicate",
      _target: [{ _ref: "layer", _id: artboard.id }],
      name: newName,
      version: 5,
    }
  ], { synchronousExecution: false });

  // O duplicado vira o layer ativo
  const doc = app.activeDocument;
  return doc.activeLayers[0];
}

// ── Reposiciona layers dentro do artboard clonado ────────────────────────────
async function smartReposition(clone, origW, origH, newW, newH, subjectCenter) {
  const scale = Math.min(newW / origW, newH / origH);
  const anchorX = subjectCenter.x / origW;
  const anchorY = subjectCenter.y / origH;
  const newSubjectX = anchorX * newW;
  const newSubjectY = anchorY * newH;

  const layers = clone.layers || [];
  for (const layer of layers) {
    const b = layer.bounds;
    const childCX = (b.left + b.right) / 2;
    const childCY = (b.top + b.bottom) / 2;
    const relX = childCX - subjectCenter.x;
    const relY = childCY - subjectCenter.y;

    if (layer.kind === constants.LayerKind.TEXT) {
      // Texto: só move, não escala
      const targetCX = newSubjectX + relX;
      const targetCY = newSubjectY + relY;
      const dx = targetCX - childCX;
      const dy = targetCY - childCY;
      await layer.translate(dx, dy);
    } else {
      // Visuais: escala uniforme + reposiciona
      const targetCX = newSubjectX + relX * scale;
      const targetCY = newSubjectY + relY * scale;
      const currentW = b.right - b.left;
      const currentH = b.bottom - b.top;
      const pctW = (currentW * scale / currentW) * 100;
      const pctH = (currentH * scale / currentH) * 100;
      await layer.resize(pctW, pctH, constants.AnchorPosition.MIDDLECENTER);
      // Após resize, recalcula bounds
      const nb = layer.bounds;
      const newCX = (nb.left + nb.right) / 2;
      const newCY = (nb.top + nb.bottom) / 2;
      await layer.translate(targetCX - newCX, targetCY - newCY);
    }
  }
}

// ── Resize do artboard via batchPlay ─────────────────────────────────────────
async function resizeArtboard(artboard, newW, newH, offsetX, offsetY) {
  await batchPlay([
    {
      _obj: "set",
      _target: [{ _ref: "layer", _id: artboard.id }],
      to: {
        _obj: "artboard",
        artboardRect: {
          _obj: "classFloatRect",
          top: offsetY,
          left: offsetX,
          bottom: offsetY + newH,
          right: offsetX + newW,
        }
      }
    }
  ], { synchronousExecution: false });
}

// ── Handler principal ────────────────────────────────────────────────────────
async function generate({ formats, gap, smartCrop }) {
  const artboard = getSelectedArtboard();
  if (!artboard) throw new Error("Nenhum artboard selecionado.");

  const doc = app.activeDocument;
  const origBounds = artboard.bounds;
  const origW = origBounds.right - origBounds.left;
  const origH = origBounds.bottom - origBounds.top;
  const subjectCenter = smartCrop
    ? getSubjectCenter(artboard)
    : { x: origW / 2, y: origH / 2 };

  let offsetX = origBounds.right + gap;
  const results = [];

  for (const fmt of formats) {
    const newName = `${artboard.name} — ${fmt.label}`;

    // 1. Duplica o artboard
    const clone = await duplicateArtboard(artboard, newName);

    // 2. Reposiciona os layers antes de redimensionar o artboard
    if (smartCrop && clone.layers && clone.layers.length) {
      await smartReposition(clone, origW, origH, fmt.width, fmt.height, subjectCenter);
    }

    // 3. Redimensiona o artboard
    await resizeArtboard(clone, fmt.width, fmt.height, offsetX, origBounds.top);

    offsetX += fmt.width + gap;
    results.push({ name: newName, width: fmt.width, height: fmt.height });
  }

  return results;
}

// ── Expõe pra UI ─────────────────────────────────────────────────────────────
window.__desdobramento = {
  async getSelection() {
    const ab = getSelectedArtboard();
    if (!ab) return null;
    const b = ab.bounds;
    return {
      name: ab.name,
      width: b.right - b.left,
      height: b.bottom - b.top,
    };
  },

  async generate(params) {
    return await executeAsModal(
      async () => generate(params),
      { commandName: "Desdobramento" }
    );
  }
};

// Escuta mudanças de seleção e notifica a UI
app.eventNotifier = async (event) => {
  if (["select", "set", "modalStateChanged"].includes(event)) {
    const panel = document.querySelector("desdobramento-panel");
    if (panel && panel.onSelectionChange) panel.onSelectionChange();
  }
};