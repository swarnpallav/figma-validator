"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
function getNodeBounds(node) {
    if (!('absoluteBoundingBox' in node) || !node.absoluteBoundingBox) {
        return null;
    }
    const { x, y, width, height } = node.absoluteBoundingBox;
    return { x, y, width, height };
}
function toRgbColor(color) {
    return {
        r: Math.round(color.r * 255),
        g: Math.round(color.g * 255),
        b: Math.round(color.b * 255)
    };
}
function normalizeStyleString(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function normalizeFigmaBlendMode(value) {
    const normalized = normalizeStyleString(value);
    if (!normalized || normalized === 'PASS_THROUGH' || normalized === 'NORMAL') {
        return null;
    }
    return normalized;
}
function getSolidStrokeColor(node) {
    if (!('strokes' in node) || !Array.isArray(node.strokes) || node.strokes.length === 0) {
        return null;
    }
    const solidStroke = node.strokes.find(stroke => stroke.type === 'SOLID' && stroke.visible !== false);
    if (!solidStroke || solidStroke.type !== 'SOLID')
        return null;
    return toRgbColor(solidStroke.color);
}
function formatFigmaShadow(effect) {
    if ((effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') ||
        effect.visible === false) {
        return null;
    }
    return [
        effect.type === 'INNER_SHADOW' ? 'inner' : 'drop',
        `x:${Math.round(effect.offset.x * 100) / 100}`,
        `y:${Math.round(effect.offset.y * 100) / 100}`,
        `blur:${Math.round(effect.radius * 100) / 100}`,
        `spread:${Math.round((effect.spread || 0) * 100) / 100}`,
        `rgba(${Math.round(effect.color.r * 255)}, ${Math.round(effect.color.g * 255)}, ${Math.round(effect.color.b * 255)}, ${Math.round(effect.color.a * 100) / 100})`
    ].join(' ');
}
function getShadowStyles(node) {
    if (!('effects' in node) || !Array.isArray(node.effects) || node.effects.length === 0) {
        return undefined;
    }
    const shadows = node.effects
        .map(effect => formatFigmaShadow(effect))
        .filter((value) => Boolean(value));
    if (!shadows.length)
        return undefined;
    return {
        shadow: shadows.join(' | ')
    };
}
function getCompositingStyles(node) {
    if (!('opacity' in node) && !('blendMode' in node))
        return undefined;
    const opacity = 'opacity' in node && typeof node.opacity === 'number' ? node.opacity : null;
    const blendMode = 'blendMode' in node && typeof node.blendMode === 'string'
        ? normalizeFigmaBlendMode(node.blendMode)
        : null;
    if (opacity == null && !blendMode)
        return undefined;
    return {
        opacity,
        blendMode
    };
}
function getSolidFillColor(node) {
    if (!('fills' in node) || !Array.isArray(node.fills) || node.fills.length === 0) {
        return null;
    }
    const solidFill = node.fills.find(fill => fill.type === 'SOLID' && fill.visible !== false);
    if (!solidFill || solidFill.type !== 'SOLID')
        return null;
    return toRgbColor(solidFill.color);
}
function getTypographyStyles(node) {
    if (node.type !== 'TEXT')
        return undefined;
    const textNode = node;
    const fontFamily = textNode.fontName !== figma.mixed &&
        typeof textNode.fontName === 'object' &&
        textNode.fontName &&
        'family' in textNode.fontName
        ? textNode.fontName.family
        : null;
    const lineHeightValue = typeof node.lineHeight === 'object' && 'value' in node.lineHeight
        ? node.lineHeight.value
        : typeof node.lineHeight === 'number'
            ? node.lineHeight
            : null;
    const lineHeightUnit = typeof node.lineHeight === 'object' && 'unit' in node.lineHeight
        ? normalizeStyleString(node.lineHeight.unit)
        : null;
    const letterSpacingValue = typeof node.letterSpacing === 'object' && 'value' in node.letterSpacing
        ? node.letterSpacing.value
        : typeof node.letterSpacing === 'number'
            ? node.letterSpacing
            : null;
    const letterSpacingUnit = typeof node.letterSpacing === 'object' && 'unit' in node.letterSpacing
        ? normalizeStyleString(node.letterSpacing.unit)
        : null;
    return {
        fontFamily,
        fontSize: typeof node.fontSize === 'number' ? node.fontSize : null,
        fontWeight: typeof node.fontWeight === 'number' ? node.fontWeight : null,
        lineHeight: lineHeightValue,
        lineHeightUnit,
        letterSpacing: letterSpacingValue,
        letterSpacingUnit
    };
}
function getLayoutStyles(node) {
    var _a, _b, _c;
    if (!('layoutMode' in node))
        return undefined;
    const frame = node;
    const layoutMode = (_a = frame.layoutMode) !== null && _a !== void 0 ? _a : null;
    const itemSpacing = typeof frame.itemSpacing === 'number' ? frame.itemSpacing : null;
    const primaryAxisAlignItems = 'primaryAxisAlignItems' in frame ? (_b = frame.primaryAxisAlignItems) !== null && _b !== void 0 ? _b : null : null;
    const counterAxisAlignItems = 'counterAxisAlignItems' in frame ? (_c = frame.counterAxisAlignItems) !== null && _c !== void 0 ? _c : null : null;
    if (layoutMode === 'NONE' &&
        itemSpacing === null &&
        !primaryAxisAlignItems &&
        !counterAxisAlignItems) {
        return undefined;
    }
    return {
        layoutMode,
        itemSpacing,
        primaryAxisAlignItems,
        counterAxisAlignItems
    };
}
function getSpacingStyles(node) {
    var _a, _b, _c, _d;
    if (!('paddingTop' in node))
        return undefined;
    return {
        paddingTop: (_a = node.paddingTop) !== null && _a !== void 0 ? _a : null,
        paddingRight: (_b = node.paddingRight) !== null && _b !== void 0 ? _b : null,
        paddingBottom: (_c = node.paddingBottom) !== null && _c !== void 0 ? _c : null,
        paddingLeft: (_d = node.paddingLeft) !== null && _d !== void 0 ? _d : null
    };
}
function getBorderStyles(node) {
    if (!('cornerRadius' in node))
        return undefined;
    const topLeftRadius = 'topLeftRadius' in node && typeof node.topLeftRadius === 'number' ? node.topLeftRadius : null;
    const topRightRadius = 'topRightRadius' in node && typeof node.topRightRadius === 'number'
        ? node.topRightRadius
        : null;
    const bottomRightRadius = 'bottomRightRadius' in node && typeof node.bottomRightRadius === 'number'
        ? node.bottomRightRadius
        : null;
    const bottomLeftRadius = 'bottomLeftRadius' in node && typeof node.bottomLeftRadius === 'number'
        ? node.bottomLeftRadius
        : null;
    const strokeWidth = 'strokeWeight' in node && typeof node.strokeWeight === 'number' ? node.strokeWeight : null;
    const strokeColor = getSolidStrokeColor(node);
    return {
        radius: typeof node.cornerRadius === 'number' ? node.cornerRadius : null,
        topLeftRadius,
        topRightRadius,
        bottomRightRadius,
        bottomLeftRadius,
        strokeWidth,
        strokeColor
    };
}
function getColorStyles(node) {
    const background = node.type === 'TEXT' ? null : getSolidFillColor(node);
    const text = node.type === 'TEXT' ? getSolidFillColor(node) : null;
    if (!background && !text)
        return undefined;
    return {
        text,
        background
    };
}
function getNodeStyles(node) {
    const typography = getTypographyStyles(node);
    const spacing = getSpacingStyles(node);
    const layout = getLayoutStyles(node);
    const border = getBorderStyles(node);
    const colors = getColorStyles(node);
    const compositing = getCompositingStyles(node);
    const effects = getShadowStyles(node);
    const styles = {};
    if (typography)
        styles.typography = typography;
    if (spacing)
        styles.spacing = spacing;
    if (layout)
        styles.layout = layout;
    if (border)
        styles.border = border;
    if (colors)
        styles.colors = colors;
    if (compositing)
        styles.compositing = compositing;
    if (effects)
        styles.effects = effects;
    return Object.keys(styles).length > 0 ? styles : undefined;
}
function getNodeTextContent(node) {
    if (node.type !== 'TEXT')
        return undefined;
    return typeof node.characters === 'string' ? node.characters : null;
}
function isVisualNode(node) {
    if (!node.visible)
        return false;
    // Vector internals tend to collapse into a single DOM icon wrapper, so we
    // validate icons at the wrapper level instead of trying to map each path.
    if (node.type === 'VECTOR')
        return false;
    const bounds = getNodeBounds(node);
    if (!bounds)
        return false;
    return bounds.width > 0 && bounds.height > 0;
}
function toSnapshotNode(node) {
    const bounds = getNodeBounds(node);
    if (!bounds || !node.visible)
        return null;
    return {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        bounds,
        visible: node.visible,
        textContent: getNodeTextContent(node),
        styles: getNodeStyles(node),
        children: []
    };
}
function getVisibleChildren(node) {
    if (!('children' in node))
        return [];
    return node.children.filter(child => isVisualNode(child));
}
function createLayoutSnapshot(node) {
    const snapshot = toSnapshotNode(node);
    if (!snapshot)
        return null;
    // The extension expects a recursive visible-node tree so it can validate a
    // selected container and then walk the geometry top-down in the browser.
    snapshot.children = getVisibleChildren(node)
        .map(child => createLayoutSnapshot(child))
        .filter((child) => child !== null);
    return snapshot;
}
function getSnapshotStats(node, depth = 0) {
    return node.children.reduce((stats, child) => {
        const childStats = getSnapshotStats(child, depth + 1);
        return {
            totalNodes: stats.totalNodes + childStats.totalNodes,
            maxDepth: Math.max(stats.maxDepth, childStats.maxDepth)
        };
    }, {
        totalNodes: 1,
        maxDepth: depth
    });
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
3. simplifying only non-visual implementation details`;
figma.showUI(__html__);
function getSelectionUrl(node) {
    const fileKey = figma.fileKey;
    if (!fileKey)
        return null;
    const encodedNodeId = encodeURIComponent(node.id.replace(':', '-'));
    return `https://www.figma.com/design/${fileKey}/?node-id=${encodedNodeId}`;
}
function buildImplementationPrompt(node) {
    const selectionUrl = getSelectionUrl(node);
    return selectionUrl
        ? `${IMPLEMENTATION_PROMPT_TEMPLATE}\n\nFigma selection: ${selectionUrl}`
        : IMPLEMENTATION_PROMPT_TEMPLATE;
}
function exportReferenceBytes(node_1) {
    return __awaiter(this, arguments, void 0, function* (node, scale = 2) {
        try {
            const bytes = yield node.exportAsync({
                format: 'PNG',
                constraint: {
                    type: 'SCALE',
                    value: scale
                }
            });
            return Array.from(bytes);
        }
        catch (error) {
            console.warn('Failed to export reference image:', error);
            return null;
        }
    });
}
let publishSequence = 0;
function publishCurrentSelection() {
    return __awaiter(this, void 0, void 0, function* () {
        const selection = figma.currentPage.selection;
        if (selection.length === 0)
            return;
        const currentSequence = ++publishSequence;
        // The plugin always publishes the first selected node as the layout root.
        const snapshot = createLayoutSnapshot(selection[0]);
        if (!snapshot)
            return;
        const referenceScale = 2;
        const referenceBytes = yield exportReferenceBytes(selection[0], referenceScale);
        if (currentSequence !== publishSequence) {
            return;
        }
        const payload = Object.assign(Object.assign({}, snapshot), { snapshotVersion: 2, referenceBytes, referenceScale: referenceBytes ? referenceScale : null, referenceBounds: referenceBytes ? snapshot.bounds : null, selectionUrl: getSelectionUrl(selection[0]), implementationPrompt: buildImplementationPrompt(selection[0]) });
        figma.ui.postMessage({
            type: 'snapshot',
            data: payload
        });
        console.log('Layout snapshot:', JSON.stringify({
            snapshot: Object.assign(Object.assign({}, snapshot), { referenceBytes: referenceBytes ? `[${referenceBytes.length} bytes]` : null, referenceScale: payload.referenceScale, referenceBounds: payload.referenceBounds }),
            stats: getSnapshotStats(snapshot)
        }, null, 2));
    });
}
figma.on('selectionchange', publishCurrentSelection);
publishCurrentSelection();
