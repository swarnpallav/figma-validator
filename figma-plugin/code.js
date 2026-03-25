"use strict";
function getNodeBounds(node) {
    if (!('absoluteBoundingBox' in node) || !node.absoluteBoundingBox) {
        return null;
    }
    const { x, y, width, height } = node.absoluteBoundingBox;
    return { x, y, width, height };
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
