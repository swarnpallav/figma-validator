"use strict";
// This plugin will open a tab that indicates that it will monitor the current
// selection on the page. It cannot change the document itself.
// This file holds the main code for plugins. Code in this file has access to
// the *figma document* via the figma global object.
// You can access browser APIs in the <script> tag inside "ui.html" which has a
// full browser environment (See https://www.figma.com/plugin-docs/how-plugins-run).
// This shows the HTML page in "ui.html".
figma.showUI(__html__);
// This monitors the selection changes and posts the selection to the UI
figma.on('selectionchange', () => {
    var _a, _b, _c, _d;
    figma.ui.postMessage(figma.currentPage.selection);
    const selection = figma.currentPage.selection;
    const styleSnapshot = {};
    if (selection.length > 0) {
        const node = selection[0];
        const styleSnapshot = {};
        // --- TYPOGRAPHY ---
        if (node.type === 'TEXT') {
            styleSnapshot.typography = {
                fontSize: typeof node.fontSize === 'number' ? node.fontSize : null,
                fontWeight: typeof node.fontWeight === 'number' ? node.fontWeight : null,
                lineHeight: typeof node.lineHeight === 'object' && 'value' in node.lineHeight
                    ? node.lineHeight.value
                    : null
            };
        }
        // --- BORDER RADIUS ---
        if ('cornerRadius' in node) {
            styleSnapshot.border = {
                radius: typeof node.cornerRadius === 'number' ? node.cornerRadius : null
            };
        }
        // --- PADDING (ONLY FOR AUTO LAYOUT FRAMES) ---
        if ('paddingTop' in node) {
            styleSnapshot.spacing = {
                paddingTop: (_a = node.paddingTop) !== null && _a !== void 0 ? _a : null,
                paddingRight: (_b = node.paddingRight) !== null && _b !== void 0 ? _b : null,
                paddingBottom: (_c = node.paddingBottom) !== null && _c !== void 0 ? _c : null,
                paddingLeft: (_d = node.paddingLeft) !== null && _d !== void 0 ? _d : null
            };
        }
        // --- COLORS ---
        if ('fills' in node && Array.isArray(node.fills) && node.fills.length > 0) {
            const fill = node.fills[0];
            if (fill.type === 'SOLID') {
                const { r, g, b } = fill.color;
                styleSnapshot.colors = {
                    background: {
                        r: Math.round(r * 255),
                        g: Math.round(g * 255),
                        b: Math.round(b * 255)
                    }
                };
            }
        }
        figma.ui.postMessage({
            type: 'snapshot',
            data: styleSnapshot
        });
        console.log('Style snapshot:', styleSnapshot);
    }
});
// figma.closePlugin()
