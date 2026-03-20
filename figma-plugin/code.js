"use strict";
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
    const lineHeightValue = typeof node.lineHeight === 'object' && 'value' in node.lineHeight
        ? node.lineHeight.value
        : typeof node.lineHeight === 'number'
            ? node.lineHeight
            : null;
    return {
        fontSize: typeof node.fontSize === 'number' ? node.fontSize : null,
        fontWeight: typeof node.fontWeight === 'number' ? node.fontWeight : null,
        lineHeight: lineHeightValue
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
    return {
        radius: typeof node.cornerRadius === 'number' ? node.cornerRadius : null
    };
}
function getColorStyles(node) {
    const background = getSolidFillColor(node);
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
    const border = getBorderStyles(node);
    const colors = getColorStyles(node);
    const styles = {};
    if (typography)
        styles.typography = typography;
    if (spacing)
        styles.spacing = spacing;
    if (border)
        styles.border = border;
    if (colors)
        styles.colors = colors;
    return Object.keys(styles).length > 0 ? styles : undefined;
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
figma.showUI(__html__);
function publishCurrentSelection() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0)
        return;
    // The plugin always publishes the first selected node as the layout root.
    const snapshot = createLayoutSnapshot(selection[0]);
    if (!snapshot)
        return;
    figma.ui.postMessage({
        type: 'snapshot',
        data: snapshot
    });
}
figma.on('selectionchange', publishCurrentSelection);
publishCurrentSelection();
