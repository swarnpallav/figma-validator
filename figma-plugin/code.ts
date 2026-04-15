interface IBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

interface IColorValue {
  r: number
  g: number
  b: number
}

interface ISpacingStyles {
  paddingTop: number | null
  paddingRight: number | null
  paddingBottom: number | null
  paddingLeft: number | null
}

interface ITypographyStyles {
  fontFamily: string | null
  fontSize: number | null
  fontWeight: number | null
  lineHeight: number | null
  lineHeightUnit: string | null
  letterSpacing: number | null
  letterSpacingUnit: string | null
}

interface ILayoutStyles {
  layoutMode: 'HORIZONTAL' | 'VERTICAL' | 'NONE' | 'GRID' | null
  itemSpacing: number | null
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | null
  counterAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE' | null
}

interface IColorStyles {
  text: IColorValue | null
  background: IColorValue | null
}

interface IBorderStyles {
  radius: number | null
  topLeftRadius: number | null
  topRightRadius: number | null
  bottomRightRadius: number | null
  bottomLeftRadius: number | null
  strokeWidth: number | null
  strokeColor: IColorValue | null
}

interface ICompositingStyles {
  opacity: number | null
  blendMode: string | null
}

interface IEffectStyles {
  shadow: string | null
}

interface INodeStyles {
  spacing?: ISpacingStyles
  layout?: ILayoutStyles
  typography?: ITypographyStyles
  colors?: IColorStyles
  border?: IBorderStyles
  compositing?: ICompositingStyles
  effects?: IEffectStyles
}

interface ILayoutSnapshotNode {
  nodeId: string
  nodeName: string
  nodeType: SceneNode['type']
  bounds: IBoundingBox
  visible: boolean
  textContent?: string | null
  styles?: INodeStyles
  children: ILayoutSnapshotNode[]
}

interface ISelectionPublishPayload extends ILayoutSnapshotNode {
  snapshotVersion?: number
  referenceBytes?: number[] | null
  referenceScale?: number | null
  referenceBounds?: IBoundingBox | null
  selectionUrl?: string | null
  implementationPrompt?: string | null
}

interface ILayoutSnapshotStats {
  totalNodes: number
  maxDepth: number
}

function getNodeBounds(node: SceneNode): IBoundingBox | null {
  if (!('absoluteBoundingBox' in node) || !node.absoluteBoundingBox) {
    return null
  }

  const { x, y, width, height } = node.absoluteBoundingBox

  return { x, y, width, height }
}

function toRgbColor(color: RGB | RGBA): IColorValue {
  return {
    r: Math.round(color.r * 255),
    g: Math.round(color.g * 255),
    b: Math.round(color.b * 255)
  }
}

function normalizeStyleString(value: string | symbol | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function normalizeFigmaBlendMode(value: string | null): string | null {
  const normalized = normalizeStyleString(value)
  if (!normalized || normalized === 'PASS_THROUGH' || normalized === 'NORMAL') {
    return null
  }

  return normalized
}

function getSolidStrokeColor(node: SceneNode): IColorValue | null {
  if (!('strokes' in node) || !Array.isArray(node.strokes) || node.strokes.length === 0) {
    return null
  }

  const solidStroke = node.strokes.find(
    stroke => stroke.type === 'SOLID' && stroke.visible !== false
  )

  if (!solidStroke || solidStroke.type !== 'SOLID') return null
  return toRgbColor(solidStroke.color)
}

function formatFigmaShadow(effect: Effect): string | null {
  if (
    (effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') ||
    effect.visible === false
  ) {
    return null
  }

  return [
    effect.type === 'INNER_SHADOW' ? 'inner' : 'drop',
    `x:${Math.round(effect.offset.x * 100) / 100}`,
    `y:${Math.round(effect.offset.y * 100) / 100}`,
    `blur:${Math.round(effect.radius * 100) / 100}`,
    `spread:${Math.round((effect.spread || 0) * 100) / 100}`,
    `rgba(${Math.round(effect.color.r * 255)}, ${Math.round(effect.color.g * 255)}, ${Math.round(
      effect.color.b * 255
    )}, ${Math.round(effect.color.a * 100) / 100})`
  ].join(' ')
}

function getShadowStyles(node: SceneNode): IEffectStyles | undefined {
  if (!('effects' in node) || !Array.isArray(node.effects) || node.effects.length === 0) {
    return undefined
  }

  const shadows = node.effects
    .map(effect => formatFigmaShadow(effect))
    .filter((value): value is string => Boolean(value))

  if (!shadows.length) return undefined

  return {
    shadow: shadows.join(' | ')
  }
}

function getCompositingStyles(node: SceneNode): ICompositingStyles | undefined {
  if (!('opacity' in node) && !('blendMode' in node)) return undefined

  const opacity = 'opacity' in node && typeof node.opacity === 'number' ? node.opacity : null
  const blendMode =
    'blendMode' in node && typeof node.blendMode === 'string'
      ? normalizeFigmaBlendMode(node.blendMode)
      : null

  if (opacity == null && !blendMode) return undefined

  return {
    opacity,
    blendMode
  }
}

function getSolidFillColor(node: SceneNode): IColorValue | null {
  if (!('fills' in node) || !Array.isArray(node.fills) || node.fills.length === 0) {
    return null
  }

  const solidFill = node.fills.find(
    fill => fill.type === 'SOLID' && fill.visible !== false
  )

  if (!solidFill || solidFill.type !== 'SOLID') return null
  return toRgbColor(solidFill.color)
}

function getTypographyStyles(node: SceneNode): ITypographyStyles | undefined {
  if (node.type !== 'TEXT') return undefined

  const textNode = node as TextNode
  const fontFamily =
    textNode.fontName !== figma.mixed &&
    typeof textNode.fontName === 'object' &&
    textNode.fontName &&
    'family' in textNode.fontName
      ? textNode.fontName.family
      : null

  const lineHeightValue =
    typeof node.lineHeight === 'object' && 'value' in node.lineHeight
      ? node.lineHeight.value
      : typeof node.lineHeight === 'number'
        ? node.lineHeight
        : null
  const lineHeightUnit =
    typeof node.lineHeight === 'object' && 'unit' in node.lineHeight
      ? normalizeStyleString(node.lineHeight.unit)
      : null
  const letterSpacingValue =
    typeof node.letterSpacing === 'object' && 'value' in node.letterSpacing
      ? node.letterSpacing.value
      : typeof node.letterSpacing === 'number'
        ? node.letterSpacing
        : null
  const letterSpacingUnit =
    typeof node.letterSpacing === 'object' && 'unit' in node.letterSpacing
      ? normalizeStyleString(node.letterSpacing.unit)
      : null

  return {
    fontFamily,
    fontSize: typeof node.fontSize === 'number' ? node.fontSize : null,
    fontWeight: typeof node.fontWeight === 'number' ? node.fontWeight : null,
    lineHeight: lineHeightValue,
    lineHeightUnit,
    letterSpacing: letterSpacingValue,
    letterSpacingUnit
  }
}

function getLayoutStyles(node: SceneNode): ILayoutStyles | undefined {
  if (!('layoutMode' in node)) return undefined

  const frame = node as FrameNode
  const layoutMode = frame.layoutMode ?? null
  const itemSpacing = typeof frame.itemSpacing === 'number' ? frame.itemSpacing : null
  const primaryAxisAlignItems =
    'primaryAxisAlignItems' in frame ? frame.primaryAxisAlignItems ?? null : null
  const counterAxisAlignItems =
    'counterAxisAlignItems' in frame ? frame.counterAxisAlignItems ?? null : null

  if (
    layoutMode === 'NONE' &&
    itemSpacing === null &&
    !primaryAxisAlignItems &&
    !counterAxisAlignItems
  ) {
    return undefined
  }

  return {
    layoutMode,
    itemSpacing,
    primaryAxisAlignItems,
    counterAxisAlignItems
  }
}

function getSpacingStyles(node: SceneNode): ISpacingStyles | undefined {
  if (!('paddingTop' in node)) return undefined

  return {
    paddingTop: node.paddingTop ?? null,
    paddingRight: node.paddingRight ?? null,
    paddingBottom: node.paddingBottom ?? null,
    paddingLeft: node.paddingLeft ?? null
  }
}

function getBorderStyles(node: SceneNode): IBorderStyles | undefined {
  if (!('cornerRadius' in node)) return undefined

  const topLeftRadius =
    'topLeftRadius' in node && typeof node.topLeftRadius === 'number' ? node.topLeftRadius : null
  const topRightRadius =
    'topRightRadius' in node && typeof node.topRightRadius === 'number'
      ? node.topRightRadius
      : null
  const bottomRightRadius =
    'bottomRightRadius' in node && typeof node.bottomRightRadius === 'number'
      ? node.bottomRightRadius
      : null
  const bottomLeftRadius =
    'bottomLeftRadius' in node && typeof node.bottomLeftRadius === 'number'
      ? node.bottomLeftRadius
      : null
  const strokeWidth =
    'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : null
  const strokeColor = getSolidStrokeColor(node)

  return {
    radius: typeof node.cornerRadius === 'number' ? node.cornerRadius : null,
    topLeftRadius,
    topRightRadius,
    bottomRightRadius,
    bottomLeftRadius,
    strokeWidth,
    strokeColor
  }
}

function getColorStyles(node: SceneNode): IColorStyles | undefined {
  const background = node.type === 'TEXT' ? null : getSolidFillColor(node)
  const text = node.type === 'TEXT' ? getSolidFillColor(node) : null

  if (!background && !text) return undefined

  return {
    text,
    background
  }
}

function getNodeStyles(node: SceneNode): INodeStyles | undefined {
  const typography = getTypographyStyles(node)
  const spacing = getSpacingStyles(node)
  const layout = getLayoutStyles(node)
  const border = getBorderStyles(node)
  const colors = getColorStyles(node)
  const compositing = getCompositingStyles(node)
  const effects = getShadowStyles(node)

  const styles: INodeStyles = {}

  if (typography) styles.typography = typography
  if (spacing) styles.spacing = spacing
  if (layout) styles.layout = layout
  if (border) styles.border = border
  if (colors) styles.colors = colors
  if (compositing) styles.compositing = compositing
  if (effects) styles.effects = effects

  return Object.keys(styles).length > 0 ? styles : undefined
}

function getNodeTextContent(node: SceneNode): string | null | undefined {
  if (node.type !== 'TEXT') return undefined
  return typeof node.characters === 'string' ? node.characters : null
}

function isVisualNode(node: SceneNode): boolean {
  if (!node.visible) return false
  // Vector internals tend to collapse into a single DOM icon wrapper, so we
  // validate icons at the wrapper level instead of trying to map each path.
  if (node.type === 'VECTOR') return false

  const bounds = getNodeBounds(node)
  if (!bounds) return false

  return bounds.width > 0 && bounds.height > 0
}

function toSnapshotNode(node: SceneNode): ILayoutSnapshotNode | null {
  const bounds = getNodeBounds(node)
  if (!bounds || !node.visible) return null

  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    bounds,
    visible: node.visible,
    textContent: getNodeTextContent(node),
    styles: getNodeStyles(node),
    children: []
  }
}

function getVisibleChildren(node: SceneNode): SceneNode[] {
  if (!('children' in node)) return []

  return node.children.filter(child => isVisualNode(child))
}

function createLayoutSnapshot(node: SceneNode): ILayoutSnapshotNode | null {
  const snapshot = toSnapshotNode(node)
  if (!snapshot) return null

  // The extension expects a recursive visible-node tree so it can validate a
  // selected container and then walk the geometry top-down in the browser.
  snapshot.children = getVisibleChildren(node)
    .map(child => createLayoutSnapshot(child))
    .filter((child): child is ILayoutSnapshotNode => child !== null)

  return snapshot
}

function getSnapshotStats(
  node: ILayoutSnapshotNode,
  depth = 0
): ILayoutSnapshotStats {
  return node.children.reduce(
    (stats, child) => {
      const childStats = getSnapshotStats(child, depth + 1)

      return {
        totalNodes: stats.totalNodes + childStats.totalNodes,
        maxDepth: Math.max(stats.maxDepth, childStats.maxDepth)
      }
    },
    {
      totalNodes: 1,
      maxDepth: depth
    }
  )
}

const IMPLEMENTATION_PROMPT_TEMPLATE = `You are implementing a UI from Figma.

Use the provided Figma selection link and any Figma MCP data to recreate the design as closely as possible.

Important implementation rules:

- Preserve visible Figma hierarchy where feasible.
- Preserve major container and group structure instead of flattening everything aggressively.
- Keep separate visible regions separate in the DOM:
  - icon or media region
  - title or heading text
  - body text
  - chip or tag groups
  - CTA button region
- Preserve text boundaries instead of merging multiple visible text regions into a single DOM node.
- Keep meaningful wrapper boundaries when they affect spacing, alignment, sizing, or typography.
- Prefer implementation structure that maps cleanly to visible Figma regions.
- Avoid collapsing multiple distinct visible boxes into one implementation wrapper.

Validation-oriented goals:

- final rendered result should match Figma visually
- spacing and alignment should remain inspectable
- text and typography should remain inspectable as separate visible regions
- implementation should still be understandable in validator Dev mode

If tradeoffs are required, prioritize:

1. visible design fidelity
2. preserving visible region boundaries
3. simplifying only non-visual implementation details`

figma.showUI(__html__)

function getSelectionUrl(node: SceneNode): string | null {
  const fileKey = figma.fileKey
  if (!fileKey) return null

  const encodedNodeId = encodeURIComponent(node.id.replace(':', '-'))
  return `https://www.figma.com/design/${fileKey}/?node-id=${encodedNodeId}`
}

function buildImplementationPrompt(node: SceneNode): string {
  const selectionUrl = getSelectionUrl(node)
  return selectionUrl
    ? `${IMPLEMENTATION_PROMPT_TEMPLATE}\n\nFigma selection: ${selectionUrl}`
    : IMPLEMENTATION_PROMPT_TEMPLATE
}

async function exportReferenceBytes(
  node: SceneNode,
  scale = 2
): Promise<number[] | null> {
  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: {
        type: 'SCALE',
        value: scale
      }
    })

    return Array.from(bytes)
  } catch (error) {
    console.warn('Failed to export reference image:', error)
    return null
  }
}

let publishSequence = 0

async function publishCurrentSelection(): Promise<void> {
  const selection = figma.currentPage.selection
  if (selection.length === 0) return
  const currentSequence = ++publishSequence

  // The plugin always publishes the first selected node as the layout root.
  const snapshot = createLayoutSnapshot(selection[0])
  if (!snapshot) return
  const referenceScale = 2
  const referenceBytes = await exportReferenceBytes(selection[0], referenceScale)

  if (currentSequence !== publishSequence) {
    return
  }

  const payload: ISelectionPublishPayload = {
    ...snapshot,
    snapshotVersion: 2,
    referenceBytes,
    referenceScale: referenceBytes ? referenceScale : null,
    referenceBounds: referenceBytes ? snapshot.bounds : null,
    selectionUrl: getSelectionUrl(selection[0]),
    implementationPrompt: buildImplementationPrompt(selection[0])
  }

  figma.ui.postMessage({
    type: 'snapshot',
    data: payload
  })

  console.log(
    'Layout snapshot:',
    JSON.stringify(
      {
        snapshot: {
          ...snapshot,
          referenceBytes: referenceBytes ? `[${referenceBytes.length} bytes]` : null,
          referenceScale: payload.referenceScale,
          referenceBounds: payload.referenceBounds
        },
        stats: getSnapshotStats(snapshot)
      },
      null,
      2
    )
  )
}

figma.on('selectionchange', publishCurrentSelection)

publishCurrentSelection()
