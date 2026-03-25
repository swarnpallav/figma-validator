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
  fontSize: number | null
  fontWeight: number | null
  lineHeight: number | null
}

interface IColorStyles {
  text: IColorValue | null
  background: IColorValue | null
}

interface IBorderStyles {
  radius: number | null
}

interface INodeStyles {
  spacing?: ISpacingStyles
  typography?: ITypographyStyles
  colors?: IColorStyles
  border?: IBorderStyles
}

interface ILayoutSnapshotNode {
  nodeId: string
  nodeName: string
  nodeType: SceneNode['type']
  bounds: IBoundingBox
  visible: boolean
  styles?: INodeStyles
  children: ILayoutSnapshotNode[]
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

  const lineHeightValue =
    typeof node.lineHeight === 'object' && 'value' in node.lineHeight
      ? node.lineHeight.value
      : typeof node.lineHeight === 'number'
        ? node.lineHeight
        : null

  return {
    fontSize: typeof node.fontSize === 'number' ? node.fontSize : null,
    fontWeight: typeof node.fontWeight === 'number' ? node.fontWeight : null,
    lineHeight: lineHeightValue
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

  return {
    radius: typeof node.cornerRadius === 'number' ? node.cornerRadius : null
  }
}

function getColorStyles(node: SceneNode): IColorStyles | undefined {
  const background = getSolidFillColor(node)
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
  const border = getBorderStyles(node)
  const colors = getColorStyles(node)

  const styles: INodeStyles = {}

  if (typography) styles.typography = typography
  if (spacing) styles.spacing = spacing
  if (border) styles.border = border
  if (colors) styles.colors = colors

  return Object.keys(styles).length > 0 ? styles : undefined
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

figma.showUI(__html__)

function publishCurrentSelection(): void {
  const selection = figma.currentPage.selection
  if (selection.length === 0) return

  // The plugin always publishes the first selected node as the layout root.
  const snapshot = createLayoutSnapshot(selection[0])
  if (!snapshot) return

  figma.ui.postMessage({
    type: 'snapshot',
    data: snapshot
  })

  console.log(
    'Layout snapshot:',
    JSON.stringify(
      {
        snapshot,
        stats: getSnapshotStats(snapshot)
      },
      null,
      2
    )
  )
}

figma.on('selectionchange', publishCurrentSelection)

publishCurrentSelection()
