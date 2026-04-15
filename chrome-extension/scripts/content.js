async function getFigmaSnapshot() {
  return new Promise(resolve => {
    chrome.storage.local.get(['figmaSnapshot'], result => {
      resolve(result.figmaSnapshot || null)
    })
  })
}

function cloneSnapshot(data) {
  return JSON.parse(JSON.stringify(data))
}

let highlightedElements = []
let elementBadges = []
let activeFocusBadge = null
let activeFocusMeta = null
let activeFocusTargets = []
let activeInfoTooltip = null
let annotationFrameId = null
let latestRawValidation = null
let latestValidationContext = null
let activePanelView = 'visual'
let activeDevPanelMode = 'enhanced'
let latestRenderToken = 0
let pickerModeActive = false
let pickerHoverState = null
let pickerLauncher = null
let activeVisualQaSelection = {
  openIssueId: null,
  viewMode: 'focused',
  overlayOpacity: 0.88
}
const comparisonSettings = {
  width: false,
  height: true
}
const QA_RELATION_TOLERANCE = 2
const QA_MAX_SUMMARY_LENGTH = 36
const VISUAL_QA_MAX_DIMENSION = 520
const VISUAL_QA_DIFF_BLOCK_SIZE = 8
const VISUAL_QA_DIFF_THRESHOLD = 28
const VISUAL_QA_MIN_CLUSTER_BLOCKS = 3
const VISUAL_QA_MAX_ISSUES = 6
const MOBILE_VIEWPORT_MAX_WIDTH = 768

function requestVisibleTabCapture() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'FIGMA_VALIDATOR_CAPTURE_VISIBLE_TAB'
      },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }

        if (!response?.ok || !response.dataUrl) {
          reject(
            new Error(response?.error || 'Visible-tab capture returned no image.')
          )
          return
        }

        resolve(response.dataUrl)
      }
    )
  })
}

function waitForNextPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve)
    })
  })
}

async function withValidatorChromeHidden(task) {
  const managedElements = [
    document.getElementById('figma-validator-overlay'),
    document.getElementById('figma-validator-picker-trigger'),
    document.getElementById('figma-validator-picker-hint')
  ].filter(element => element instanceof HTMLElement)

  const priorStates = managedElements.map(element => ({
    element,
    display: element.style.display
  }))

  const hadTooltip = Boolean(activeInfoTooltip)
  const tooltip = activeInfoTooltip
  if (tooltip) {
    hideInfoTooltip()
  }

  priorStates.forEach(({ element }) => {
    element.style.display = 'none'
  })

  try {
    await waitForNextPaint()
    return await task()
  } finally {
    priorStates.forEach(({ element, display }) => {
      element.style.display = display
    })

    if (hadTooltip && tooltip instanceof HTMLElement && document.body.contains(tooltip)) {
      activeInfoTooltip = tooltip
    }
  }
}

async function captureVisibleTabForContainer(containerElement) {
  return withValidatorChromeHidden(async () => {
    if (!(containerElement instanceof Element)) {
      throw new Error('Visual QA needs a valid selected browser region.')
    }

    const rect = containerElement.getBoundingClientRect()
    const viewport = window.visualViewport
    const dataUrl = await requestVisibleTabCapture()

    return {
      dataUrl,
      viewportBounds: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      },
      viewportMetrics: {
        width: viewport?.width || window.innerWidth,
        height: viewport?.height || window.innerHeight,
        offsetLeft: viewport?.offsetLeft || 0,
        offsetTop: viewport?.offsetTop || 0
      }
    }
  })
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new Error('Failed to decode an image required for Visual QA.'))
    image.src = dataUrl
  })
}

function createCanvasContext(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d', {
    willReadFrequently: true
  })

  if (!context) {
    throw new Error('Unable to create a canvas context for Visual QA.')
  }

  return { canvas, context }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function isMobileViewport() {
  return window.innerWidth <= MOBILE_VIEWPORT_MAX_WIDTH
}

function roundToPrecision(value, precision = 2) {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function isElementFullyInViewport(element) {
  if (!(element instanceof Element)) return false

  const rect = element.getBoundingClientRect()
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  )
}

function normalizeRectToContainer(rect, containerRect) {
  if (!rect || !containerRect || !containerRect.width || !containerRect.height) {
    return null
  }

  return {
    x: (rect.x - containerRect.x) / containerRect.width,
    y: (rect.y - containerRect.y) / containerRect.height,
    width: rect.width / containerRect.width,
    height: rect.height / containerRect.height
  }
}

function denormalizeRectFromContainer(rect, containerRect) {
  if (!rect || !containerRect) return null

  return {
    x: containerRect.x + rect.x * containerRect.width,
    y: containerRect.y + rect.y * containerRect.height,
    width: rect.width * containerRect.width,
    height: rect.height * containerRect.height
  }
}

function getRectArea(rect) {
  if (!rect) return 0
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

function intersectRects(a, b) {
  if (!a || !b) return null

  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)

  if (right <= x || bottom <= y) return null

  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  }
}

function getOverlapRatio(a, b) {
  const intersection = intersectRects(a, b)
  if (!intersection) return 0

  const intersectionArea = getRectArea(intersection)
  const denominator = Math.min(getRectArea(a), getRectArea(b))
  return denominator > 0 ? intersectionArea / denominator : 0
}

function unionRects(a, b) {
  if (!a) return b
  if (!b) return a

  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)

  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  }
}

function expandNormalizedBounds(bounds, padding = 0.08) {
  if (!bounds) {
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1
    }
  }

  return {
    x: clamp(bounds.x - padding, 0, 1),
    y: clamp(bounds.y - padding, 0, 1),
    width: clamp(bounds.width + padding * 2, 0, 1),
    height: clamp(bounds.height + padding * 2, 0, 1)
  }
}

function getVisualAxisFromRect(rect) {
  if (!rect) return 'both'
  if (rect.width > rect.height * 1.35) return 'x'
  if (rect.height > rect.width * 1.35) return 'y'
  return 'both'
}

function getVisualIssueSuggestion(kind, axis = 'both') {
  if (kind === 'text') {
    return 'Check the visible text content, truncation, and source string in this area.'
  }

  if (kind === 'typography') {
    return 'Check the text style values in this area and match the Figma typography settings exactly.'
  }

  if (kind === 'visual_style') {
    return 'Check typography, color, border radius, shadows, and fills in this area.'
  }

  if (kind === 'size' && axis === 'x') {
    return 'Check width constraints, max-width, flex growth, and parent sizing around this area.'
  }

  if (kind === 'size' && axis === 'y') {
    return 'Check height constraints, padding, min-height, and content expansion in this area.'
  }

  if (axis === 'x') {
    return 'Check horizontal spacing, left/right alignment, and container width behavior in this area.'
  }

  if (axis === 'y') {
    return 'Check vertical spacing, top alignment, and stack positioning in this area.'
  }

  return 'Check spacing, alignment, and visual styling in this area.'
}

function getVisualRegionLabel(element, containerElement) {
  if (!(element instanceof Element)) return 'this area'

  return (
    getElementDirectTextLabel(element, 5, 28) ||
    getElementAccessibleLabel(element) ||
    getElementSemanticLabel(element, containerElement) ||
    'content block'
  )
}

function isMeaningfulVisualElement(element, containerElement) {
  if (!(element instanceof Element) || element === containerElement) return false

  const rect = element.getBoundingClientRect()
  if (rect.width < 6 || rect.height < 6) return false

  const style = window.getComputedStyle(element)
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number.parseFloat(style.opacity) === 0
  ) {
    return false
  }

  const hasVisualSignal =
    Boolean(normalizeText(element.textContent)) ||
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    style.borderTopWidth !== '0px' ||
    style.boxShadow !== 'none' ||
    element.querySelector('svg, img') !== null ||
    ['button', 'input', 'textarea', 'select', 'a'].includes(
      element.tagName.toLowerCase()
    )

  return hasVisualSignal
}

function collectVisualQaRegions(containerElement) {
  if (!(containerElement instanceof Element)) return []

  const containerRect = containerElement.getBoundingClientRect()
  const regions = []
  const candidates = [
    containerElement,
    ...containerElement.querySelectorAll('*')
  ]

  candidates.forEach(element => {
    if (!isMeaningfulVisualElement(element, containerElement) && element !== containerElement) {
      return
    }

    const rect = element.getBoundingClientRect()
    const normalizedBounds = normalizeRectToContainer(
      {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      {
        x: containerRect.x,
        y: containerRect.y,
        width: containerRect.width,
        height: containerRect.height
      }
    )

    if (!normalizedBounds) return

    regions.push({
      element,
      label:
        element === containerElement
          ? getVisualRegionLabel(element, containerElement) || 'selected area'
          : getVisualRegionLabel(element, containerElement),
      bounds: normalizedBounds,
      area: getRectArea(normalizedBounds),
      isTextLike:
        Boolean(normalizeText(element.textContent)) &&
        !element.querySelector('svg, img'),
      isContainer: element === containerElement
    })
  })

  return regions
    .sort((left, right) => left.area - right.area)
    .filter((region, index, array) => {
      return !array.some((otherRegion, otherIndex) => {
        if (otherIndex === index || otherRegion.element === region.element) return false
        return (
          otherRegion.label === region.label &&
          getOverlapRatio(otherRegion.bounds, region.bounds) > 0.96 &&
          otherRegion.area <= region.area
        )
      })
    })
}

function clearHighlights() {
  highlightedElements.forEach(({ element, outline, outlineOffset, boxShadow }) => {
    if (!element || !element.style) return
    element.style.outline = outline
    element.style.outlineOffset = outlineOffset
    element.style.boxShadow = boxShadow
  })

  highlightedElements = []
}

function clearBadges() {
  resetFocusState()
  elementBadges.forEach(({ marker }) => marker.remove())
  elementBadges = []

  if (activeFocusBadge) {
    activeFocusBadge.remove()
    activeFocusBadge = null
  }

  activeFocusMeta = null
  activeFocusTargets = []
}

function cleanupAnnotations() {
  if (activeInfoTooltip) {
    activeInfoTooltip.remove()
    activeInfoTooltip = null
  }
  clearHighlights()
  clearBadges()
}

function clearBrowserSelection() {
  const selection = window.getSelection?.()
  if (selection && selection.rangeCount > 0) {
    selection.removeAllRanges()
  }
}

function setPickerSelectionSuppression(enabled) {
  const value = enabled ? 'none' : ''
  document.documentElement.style.userSelect = value
  document.documentElement.style.webkitUserSelect = value
  document.body.style.userSelect = value
  document.body.style.webkitUserSelect = value
}

function clearPickerHoverState() {
  if (!pickerHoverState?.element?.style) {
    pickerHoverState = null
    return
  }

  pickerHoverState.element.style.outline = pickerHoverState.outline
  pickerHoverState.element.style.outlineOffset = pickerHoverState.outlineOffset
  pickerHoverState.element.style.boxShadow = pickerHoverState.boxShadow
  pickerHoverState = null
}

function isOverlayOwnedElement(element) {
  if (!(element instanceof Element)) return false

  return Boolean(
    element.closest('#figma-validator-overlay') ||
      element.closest('#figma-validator-picker-trigger') ||
      element.closest('#figma-validator-picker-hint')
  )
}

function resolvePickerTarget(target) {
  const element =
    target instanceof Element ? target : target?.parentElement instanceof Element ? target.parentElement : null
  if (!(element instanceof Element)) return null
  if (isOverlayOwnedElement(element)) return null

  const resolved = element.closest('*')
  if (!(resolved instanceof Element)) return null
  if (['HTML', 'BODY'].includes(resolved.tagName)) return null
  if (resolved.getBoundingClientRect().width < 6 || resolved.getBoundingClientRect().height < 6) {
    return null
  }

  return resolved
}

function applyPickerHover(element) {
  if (!(element instanceof Element)) {
    clearPickerHoverState()
    return
  }

  if (pickerHoverState?.element === element) return
  clearPickerHoverState()

  pickerHoverState = {
    element,
    outline: element.style.outline,
    outlineOffset: element.style.outlineOffset,
    boxShadow: element.style.boxShadow
  }

  element.style.outline = '3px solid #22d3ee'
  element.style.outlineOffset = '3px'
  element.style.boxShadow = '0 0 0 5px rgba(34, 211, 238, 0.22), 0 10px 24px rgba(15, 23, 42, 0.18)'
}

function updatePickerLauncher() {
  if (!(pickerLauncher instanceof HTMLElement)) return

  pickerLauncher.textContent = pickerModeActive ? 'Cancel Pick Area' : 'Pick Area'
  pickerLauncher.style.background = pickerModeActive
    ? 'rgba(34, 211, 238, 0.28)'
    : 'rgba(15, 23, 42, 0.94)'
  pickerLauncher.style.borderColor = pickerModeActive
    ? 'rgba(34, 211, 238, 0.8)'
    : 'rgba(255,255,255,0.16)'
}

function disablePickerMode() {
  pickerModeActive = false
  clearPickerHoverState()
  clearBrowserSelection()
  setPickerSelectionSuppression(false)
  updatePickerLauncher()
}

function enablePickerMode() {
  pickerModeActive = true
  clearBrowserSelection()
  setPickerSelectionSuppression(true)
  const overlay = document.getElementById('figma-validator-overlay')
  if (overlay) overlay.remove()
  cleanupAnnotations()
  updatePickerLauncher()
}

function ensurePickerLauncher() {
  if (pickerLauncher instanceof HTMLElement && document.body.contains(pickerLauncher)) {
    updatePickerLauncher()
    return pickerLauncher
  }

  const button = document.createElement('button')
  button.id = 'figma-validator-picker-trigger'
  button.type = 'button'
  button.style.position = 'fixed'
  button.style.right = '16px'
  button.style.bottom = isMobileViewport() ? '16px' : '20px'
  button.style.zIndex = '999997'
  button.style.padding = isMobileViewport() ? '10px 14px' : '8px 12px'
  button.style.borderRadius = '999px'
  button.style.border = '1px solid rgba(255,255,255,0.16)'
  button.style.color = '#fff'
  button.style.font = '12px/1.4 monospace'
  button.style.cursor = 'pointer'
  button.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.35)'
  button.style.backdropFilter = 'blur(10px)'
  button.onclick = event => {
    event.preventDefault()
    event.stopPropagation()
    if (pickerModeActive) {
      disablePickerMode()
    } else {
      enablePickerMode()
    }
  }

  document.body.appendChild(button)
  pickerLauncher = button
  updatePickerLauncher()
  return button
}

async function selectValidationTarget(element) {
  const figmaSnapshot = await getFigmaSnapshot()

  if (!figmaSnapshot) {
    disablePickerMode()
    renderMissingSnapshotOverlay()
    return
  }

  activePanelView = 'visual'
  activeDevPanelMode = 'enhanced'
  activeVisualQaSelection = {
    openIssueId: null,
    viewMode: 'focused',
    overlayOpacity: 0.88
  }
  latestValidationContext = {
    figmaSnapshot,
    containerElement: element,
    tolerance: 2,
    cache: {}
  }
  latestRawValidation = null
  disablePickerMode()
  await renderValidationUI()
}

function getStatusColor(status) {
  if (status === 'match') return '#22c55e'
  if (status === 'unmatched') return '#f59e0b'
  return '#ef4444'
}

function getActiveMetrics() {
  if (comparisonSettings.width && comparisonSettings.height) {
    return ['width', 'height']
  }

  if (comparisonSettings.width) return ['width']
  if (comparisonSettings.height) return ['height']
  return ['width', 'height']
}

function getDerivedStatus(result) {
  // Mapping happens before metric filtering. Width/height toggles only change
  // how a matched node is evaluated, not which DOM element it maps to.
  if (result.mappingStatus === 'unmatched') return 'unmatched'

  const activeMetrics = getActiveMetrics()
  const isMatch = activeMetrics.every(metric => result.comparisons?.[metric] !== false)
  return isMatch ? 'match' : 'mismatch'
}

function buildDerivedValidation(rawValidation) {
  let index = 0
  const derivedMatches = []

  function walkWithMatches(result) {
    const nextResult = {
      ...result,
      status: getDerivedStatus(result),
      children: []
    }

    const match = rawValidation.matches[index]
    if (match) {
      derivedMatches.push({
        ...match,
        status: nextResult.status,
        mappingStatus: nextResult.mappingStatus
      })
    }
    index += 1

    nextResult.children = (result.children || []).map(child => walkWithMatches(child))
    return nextResult
  }

  return {
    strategy: rawValidation.strategy || 'suggested',
    result: walkWithMatches(rawValidation.result),
    matches: derivedMatches
  }
}

function getDisplayLabel(entry) {
  return entry.kind === 'container' ? 'Container' : `Level ${entry.depth}`
}

function placeMarker(element, marker) {
  const rect = element.getBoundingClientRect()
  marker.style.position = 'fixed'
  marker.style.left = `${Math.max(rect.left - 8, 8)}px`
  marker.style.top = `${Math.max(rect.top - 8, 8)}px`
}

function getFocusBadgeAnchorRect(meta) {
  const preferredElement = latestValidationContext?.containerElement

  if (preferredElement instanceof Element && document.contains(preferredElement)) {
    return preferredElement.getBoundingClientRect()
  }

  if (meta?.element instanceof Element && document.contains(meta.element)) {
    return meta.element.getBoundingClientRect()
  }

  return null
}

function placeFocusBadge(meta, badge) {
  const rect = getFocusBadgeAnchorRect(meta)
  if (!rect) return

  badge.style.position = 'fixed'
  const badgeWidth = Math.min(badge.offsetWidth || 320, 320)
  const left = Math.min(Math.max(rect.left, 8), window.innerWidth - badgeWidth - 8)
  const top = rect.top - 40 >= 8 ? rect.top - 40 : Math.min(rect.bottom + 10, window.innerHeight - 40)

  badge.style.left = `${left}px`
  badge.style.top = `${top}px`
}

function showFocusBadge(meta) {
  if (activeFocusBadge) {
    activeFocusBadge.remove()
    activeFocusBadge = null
  }

  if (!meta?.element) return

  const badge = document.createElement('div')
  badge.textContent = meta.badgeText
  badge.style.zIndex = '999998'
  badge.style.maxWidth = '320px'
  badge.style.padding = '6px 10px'
  badge.style.borderRadius = '999px'
  badge.style.background = 'rgba(15, 23, 42, 0.96)'
  badge.style.border = `1px solid ${meta.borderColor || '#38bdf8'}`
  badge.style.color = '#fff'
  badge.style.font = '11px/1.4 monospace'
  badge.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.35)'
  badge.style.pointerEvents = 'none'
  placeFocusBadge(meta, badge)

  document.body.appendChild(badge)
  activeFocusBadge = badge
  activeFocusMeta = meta
}

function clearFocusBadge() {
  if (activeFocusBadge) {
    activeFocusBadge.remove()
    activeFocusBadge = null
  }

  activeFocusMeta = null
}

function hideInfoTooltip() {
  if (activeInfoTooltip) {
    activeInfoTooltip.remove()
    activeInfoTooltip = null
  }
}

function showInfoTooltip(target, text) {
  if (!(target instanceof Element) || !text) return

  hideInfoTooltip()

  const tooltip = document.createElement('div')
  tooltip.textContent = text
  tooltip.style.position = 'fixed'
  tooltip.style.zIndex = '1000000'
  tooltip.style.maxWidth = '260px'
  tooltip.style.padding = '7px 9px'
  tooltip.style.borderRadius = '10px'
  tooltip.style.background = 'rgba(15, 23, 42, 0.98)'
  tooltip.style.border = '1px solid rgba(148, 163, 184, 0.45)'
  tooltip.style.color = '#fff'
  tooltip.style.font = '11px/1.4 monospace'
  tooltip.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.35)'
  tooltip.style.pointerEvents = 'none'

  document.body.appendChild(tooltip)

  const rect = target.getBoundingClientRect()
  const tooltipRect = tooltip.getBoundingClientRect()
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - tooltipRect.width / 2, 8),
    window.innerWidth - tooltipRect.width - 8
  )
  const top = rect.top - tooltipRect.height - 10 >= 8
    ? rect.top - tooltipRect.height - 10
    : Math.min(rect.bottom + 10, window.innerHeight - tooltipRect.height - 8)

  tooltip.style.left = `${left}px`
  tooltip.style.top = `${top}px`
  activeInfoTooltip = tooltip
}

function attachInfoTooltip(element, description) {
  if (!(element instanceof Element) || !description) return

  element.style.cursor = 'help'
  element.onmouseenter = () => showInfoTooltip(element, description)
  element.onmouseleave = () => hideInfoTooltip()
  element.onclick = event => {
    event.preventDefault()
    event.stopPropagation()

    if (activeInfoTooltip) {
      hideInfoTooltip()
    } else {
      showInfoTooltip(element, description)
    }
  }
}

function resetFocusState() {
  activeFocusTargets.forEach(({ element, boxShadow, outline, outlineOffset }) => {
    if (!element || !element.style) return
    element.style.boxShadow = boxShadow
    element.style.outline = outline
    element.style.outlineOffset = outlineOffset
  })

  activeFocusTargets = []
  clearFocusBadge()
}

function applyFocusTargets(targets, badgeText, borderColor) {
  const seenElements = new Set()
  const validTargets = targets.filter(target => {
    if (!target?.element || seenElements.has(target.element)) return false
    seenElements.add(target.element)
    return true
  })
  if (!validTargets.length) return

  resetFocusState()
  showFocusBadge({
    element: validTargets[0].element,
    badgeText,
    borderColor
  })

  validTargets.forEach(target => {
    activeFocusTargets.push({
      element: target.element,
      boxShadow: target.element.style.boxShadow,
      outline: target.element.style.outline,
      outlineOffset: target.element.style.outlineOffset
    })
    target.element.style.outline = `3px solid ${target.borderColor || target.color}`
    target.element.style.outlineOffset = '3px'
    target.element.style.boxShadow = `0 0 0 5px ${target.color}, 0 10px 24px rgba(15, 23, 42, 0.2)`
  })
}

function focusEntry(entry) {
  if (!entry?.element) return

  const prefix = entry.markerNumber ? `${entry.markerNumber}. ` : ''
  applyFocusTargets(
    [
      {
        element: entry.element,
        borderColor: getStatusColor(entry.status),
        color:
          entry.status === 'match'
            ? 'rgba(34, 197, 94, 0.24)'
            : entry.status === 'unmatched'
              ? 'rgba(245, 158, 11, 0.28)'
              : 'rgba(239, 68, 68, 0.28)'
      }
    ],
    `${prefix}${getDisplayLabel(entry)} • ${entry.nodeName} • ${entry.status}`,
    getStatusColor(entry.status)
  )
}

function focusQaIssue(issue) {
  if (!issue?.primaryElement) return

  const targets = [
    {
      element: issue.primaryElement,
      color: 'rgba(14, 165, 233, 0.34)',
      borderColor: '#38bdf8'
    }
  ]

  if (issue.secondaryElement && issue.secondaryElement !== issue.primaryElement) {
    targets.push({
      element: issue.secondaryElement,
      color: 'rgba(249, 115, 22, 0.34)',
      borderColor: '#fb923c'
    })
  }

  const prefix = issue.markerNumber ? `${issue.markerNumber}. ` : ''
  const deltaText = typeof issue.delta === 'number' ? ` • ${getNumericDeltaLabel(issue.delta)}` : ''

  applyFocusTargets(targets, `${prefix}${issue.summary}${deltaText}`, '#38bdf8')
}

function focusVisualQaIssue(issue) {
  if (issue?.linkedQaIssue) {
    focusQaIssue(issue.linkedQaIssue)
    return
  }

  const targets = []

  if (issue?.primaryElement) {
    targets.push({
      element: issue.primaryElement,
      color: 'rgba(236, 72, 153, 0.34)',
      borderColor: '#ec4899'
    })
  }

  if (
    issue?.secondaryElement &&
    issue.secondaryElement !== issue.primaryElement
  ) {
    targets.push({
      element: issue.secondaryElement,
      color: 'rgba(249, 115, 22, 0.34)',
      borderColor: '#fb923c'
    })
  }

  if (!targets.length && latestValidationContext?.containerElement) {
    targets.push({
      element: latestValidationContext.containerElement,
      color: 'rgba(236, 72, 153, 0.24)',
      borderColor: '#ec4899'
    })
  }

  const prefix = issue.markerNumber ? `${issue.markerNumber}. ` : ''
  applyFocusTargets(targets, `${prefix}${issue.summary}`, '#ec4899')
}

function highlightValidationEntries(validation) {
  cleanupAnnotations()

  const entries = validation.matches || []
  const uniqueEntriesByElement = new Map()
  let mismatchCounter = 0

  entries.forEach(entry => {
    if (!entry?.element) return
    // Unmatched nodes are intentionally not drawn on the page because there is
    // no trustworthy DOM element to annotate.
    if (entry.mappingStatus === 'unmatched') return

    const existingEntry = uniqueEntriesByElement.get(entry.element)
    const existingPriority =
      existingEntry?.status === 'mismatch' ? 2 : existingEntry?.status === 'match' ? 1 : 0
    const nextPriority = entry.status === 'mismatch' ? 2 : entry.status === 'match' ? 1 : 0

    if (!existingEntry || nextPriority > existingPriority) {
      uniqueEntriesByElement.set(entry.element, entry)
    }
  })

  Array.from(uniqueEntriesByElement.values()).forEach(entry => {
    const color = getStatusColor(entry.status)
    const markerNumber =
      entry.status === 'mismatch' ? String(++mismatchCounter) : null

    entry.markerNumber = markerNumber

    highlightedElements.push({
      element: entry.element,
      outline: entry.element.style.outline,
      outlineOffset: entry.element.style.outlineOffset,
      boxShadow: entry.element.style.boxShadow
    })

    entry.element.style.outline = `2px solid ${color}`
    entry.element.style.outlineOffset = '2px'

    if (!markerNumber) return

    const marker = document.createElement('button')
    marker.type = 'button'
    marker.textContent = markerNumber
    marker.setAttribute('aria-label', `${entry.nodeName} mismatch marker`)
    marker.style.zIndex = '999998'
    marker.style.width = '22px'
    marker.style.height = '22px'
    marker.style.border = '0'
    marker.style.borderRadius = '999px'
    marker.style.background = '#ef4444'
    marker.style.color = '#fff'
    marker.style.font = '11px/1 monospace'
    marker.style.fontWeight = '700'
    marker.style.cursor = 'pointer'
    marker.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.28)'

    placeMarker(entry.element, marker)

    marker.onmouseenter = () => focusEntry(entry)
    marker.onmouseleave = () => resetFocusState()

    document.body.appendChild(marker)
    elementBadges.push({
      element: entry.element,
      marker
    })
  })
}

function highlightQaIssues(validation) {
  cleanupAnnotations()

  const visibleIssues = (validation.qaIssues || []).filter(
    issue => issue.severity === 'fail' && issue.primaryElement
  )

  visibleIssues.forEach((issue, index) => {
    issue.markerNumber = String(index + 1)

    const marker = document.createElement('button')
    marker.type = 'button'
    marker.textContent = issue.markerNumber
    marker.setAttribute('aria-label', `${issue.summary} issue marker`)
    marker.style.zIndex = '999998'
    marker.style.width = '22px'
    marker.style.height = '22px'
    marker.style.border = '0'
    marker.style.borderRadius = '999px'
    marker.style.background = '#0ea5e9'
    marker.style.color = '#fff'
    marker.style.font = '11px/1 monospace'
    marker.style.fontWeight = '700'
    marker.style.cursor = 'pointer'
    marker.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.28)'

    placeMarker(issue.primaryElement, marker)

    marker.onmouseenter = () => focusQaIssue(issue)
    marker.onmouseleave = () => resetFocusState()

    document.body.appendChild(marker)
    elementBadges.push({
      element: issue.primaryElement,
      marker
    })
  })
}

function highlightEnhancedDevIssues(validation) {
  cleanupAnnotations()

  const primaryIssueEntries = (validation.entries || []).filter(
    entry => entry.match?.element && Array.isArray(entry.devPrimaryIssues) && entry.devPrimaryIssues.length
  )

  primaryIssueEntries.forEach((entry, index) => {
    const representativeIssue = entry.devPrimaryIssues[0]
    if (!representativeIssue?.primaryElement) return

    representativeIssue.markerNumber = String(index + 1)

    const marker = document.createElement('button')
    marker.type = 'button'
    marker.textContent = representativeIssue.markerNumber
    marker.setAttribute('aria-label', `${representativeIssue.summary} issue marker`)
    marker.style.zIndex = '999998'
    marker.style.width = '22px'
    marker.style.height = '22px'
    marker.style.border = '0'
    marker.style.borderRadius = '999px'
    marker.style.background = representativeIssue.kind === 'text' ? '#7c3aed' : '#0f766e'
    marker.style.color = '#fff'
    marker.style.font = '11px/1 monospace'
    marker.style.fontWeight = '700'
    marker.style.cursor = 'pointer'
    marker.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.28)'

    placeMarker(representativeIssue.primaryElement, marker)

    marker.onmouseenter = () => focusQaIssue(representativeIssue)
    marker.onmouseleave = () => resetFocusState()

    document.body.appendChild(marker)
    elementBadges.push({
      element: representativeIssue.primaryElement,
      marker
    })
  })
}

function highlightVisualQaIssues(validation) {
  cleanupAnnotations()

  const issues = (validation.visualQa?.issues || []).filter(
    issue => issue.severity === 'fail' && (issue.primaryElement || latestValidationContext?.containerElement)
  )

  issues.forEach((issue, index) => {
    issue.markerNumber = String(index + 1)
    const markerAnchor = issue.primaryElement || latestValidationContext?.containerElement
    if (!(markerAnchor instanceof Element)) return

    const marker = document.createElement('button')
    marker.type = 'button'
    marker.textContent = issue.markerNumber
    marker.setAttribute('aria-label', `${issue.summary} issue marker`)
    marker.style.zIndex = '999998'
    marker.style.width = '22px'
    marker.style.height = '22px'
    marker.style.border = '0'
    marker.style.borderRadius = '999px'
    marker.style.background = '#ec4899'
    marker.style.color = '#fff'
    marker.style.font = '11px/1 monospace'
    marker.style.fontWeight = '700'
    marker.style.cursor = 'pointer'
    marker.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.28)'

    placeMarker(markerAnchor, marker)

    marker.onmouseenter = () => focusVisualQaIssue(issue)
    marker.onmouseleave = () => resetFocusState()

    document.body.appendChild(marker)
    elementBadges.push({
      element: markerAnchor,
      marker
    })
  })
}

function updateAnnotationPositions() {
  elementBadges.forEach(({ element, marker }) => {
    if (!element || !marker) return
    placeMarker(element, marker)
  })

  if (activeFocusBadge && activeFocusMeta?.element) {
    placeFocusBadge(activeFocusMeta, activeFocusBadge)
  }
}

function scheduleAnnotationPositionUpdate() {
  if (annotationFrameId != null) return

  annotationFrameId = window.requestAnimationFrame(() => {
    annotationFrameId = null
    updateAnnotationPositions()
  })
}

function formatPixelValue(value, options = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--'

  const rounded = Math.round(value * 100) / 100
  const absoluteValue = Math.abs(rounded)
  const numericText = Number.isInteger(absoluteValue)
    ? String(absoluteValue)
    : absoluteValue.toFixed(2).replace(/\.?0+$/, '')

  if (options.signed) {
    const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : ''
    return `${sign}${numericText}px`
  }

  return `${rounded}px`
}

function getGeometryDelta(figmaValue, browserValue) {
  if (typeof figmaValue !== 'number' || typeof browserValue !== 'number') {
    return null
  }

  return browserValue - figmaValue
}

function getAxisDirection(axis, delta) {
  if (axis === 'x') return delta > 0 ? 'farther right' : 'farther left'
  return delta > 0 ? 'lower' : 'higher'
}

function createInsightSection(titleText, bodyText, accentColor) {
  const section = document.createElement('div')
  section.style.marginTop = '10px'
  section.style.padding = '9px 10px'
  section.style.borderRadius = '10px'
  section.style.background = 'rgba(255,255,255,0.04)'
  section.style.border = `1px solid ${accentColor}`

  const title = document.createElement('div')
  title.textContent = titleText
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  title.style.color = accentColor
  title.style.marginBottom = '3px'

  const body = document.createElement('div')
  body.textContent = bodyText
  body.style.fontSize = '11px'
  body.style.opacity = '0.86'

  section.appendChild(title)
  section.appendChild(body)
  return section
}

function buildTextDiffSegments(sourceText, targetText) {
  const source = typeof sourceText === 'string' ? sourceText : ''
  const target = typeof targetText === 'string' ? targetText : ''

  if (source === target) {
    return {
      sourceSegments: [{ text: source || '--', changed: false }],
      targetSegments: [{ text: target || '--', changed: false }]
    }
  }

  const sourceChars = Array.from(source)
  const targetChars = Array.from(target)
  const matrix = Array.from({ length: sourceChars.length + 1 }, () =>
    new Array(targetChars.length + 1).fill(0)
  )

  for (let sourceIndex = sourceChars.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    for (let targetIndex = targetChars.length - 1; targetIndex >= 0; targetIndex -= 1) {
      matrix[sourceIndex][targetIndex] =
        sourceChars[sourceIndex] === targetChars[targetIndex]
          ? matrix[sourceIndex + 1][targetIndex + 1] + 1
          : Math.max(matrix[sourceIndex + 1][targetIndex], matrix[sourceIndex][targetIndex + 1])
    }
  }

  const sourceSegments = []
  const targetSegments = []
  let sourceIndex = 0
  let targetIndex = 0

  function appendSegment(segments, text, changed) {
    if (!text) return

    const previous = segments[segments.length - 1]
    if (previous && previous.changed === changed) {
      previous.text += text
      return
    }

    segments.push({ text, changed })
  }

  while (sourceIndex < sourceChars.length && targetIndex < targetChars.length) {
    if (sourceChars[sourceIndex] === targetChars[targetIndex]) {
      appendSegment(sourceSegments, sourceChars[sourceIndex], false)
      appendSegment(targetSegments, targetChars[targetIndex], false)
      sourceIndex += 1
      targetIndex += 1
      continue
    }

    if (matrix[sourceIndex + 1][targetIndex] >= matrix[sourceIndex][targetIndex + 1]) {
      appendSegment(sourceSegments, sourceChars[sourceIndex], true)
      sourceIndex += 1
    } else {
      appendSegment(targetSegments, targetChars[targetIndex], true)
      targetIndex += 1
    }
  }

  while (sourceIndex < sourceChars.length) {
    appendSegment(sourceSegments, sourceChars[sourceIndex], true)
    sourceIndex += 1
  }

  while (targetIndex < targetChars.length) {
    appendSegment(targetSegments, targetChars[targetIndex], true)
    targetIndex += 1
  }

  if (!sourceSegments.length) {
    sourceSegments.push({ text: '--', changed: false })
  }

  if (!targetSegments.length) {
    targetSegments.push({ text: '--', changed: false })
  }

  return {
    sourceSegments,
    targetSegments
  }
}

function createTextDiffValue(segments, accentColor, backgroundColor) {
  const value = document.createElement('div')
  value.style.whiteSpace = 'pre-wrap'
  value.style.wordBreak = 'break-word'
  value.style.fontSize = '11px'
  value.style.padding = '8px 10px'
  value.style.borderRadius = '8px'
  value.style.background = 'rgba(255,255,255,0.03)'
  value.style.lineHeight = '1.55'

  segments.forEach(segment => {
    const span = document.createElement('span')
    span.textContent = segment.text
    if (segment.changed) {
      span.style.background = backgroundColor
      span.style.color = accentColor
      span.style.borderRadius = '4px'
      span.style.boxShadow = `0 0 0 1px ${backgroundColor}`
    }
    value.appendChild(span)
  })

  return value
}

function createTextDiffComparisonSection(figmaText, browserText) {
  const normalizedFigma = typeof figmaText === 'string' ? figmaText : ''
  const normalizedBrowser = typeof browserText === 'string' ? browserText : ''
  const diff = buildTextDiffSegments(normalizedFigma, normalizedBrowser)

  const wrapper = document.createElement('div')
  wrapper.style.display = 'grid'
  wrapper.style.gap = '8px'

  const title = document.createElement('div')
  title.textContent = 'Text diff'
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  wrapper.appendChild(title)

  ;[
    {
      label: 'Figma source',
      segments: diff.sourceSegments,
      accentColor: '#22c55e',
      backgroundColor: 'rgba(34, 197, 94, 0.18)'
    },
    {
      label: 'Browser render',
      segments: diff.targetSegments,
      accentColor: '#f87171',
      backgroundColor: 'rgba(248, 113, 113, 0.18)'
    }
  ].forEach(item => {
    const section = document.createElement('div')
    section.style.display = 'grid'
    section.style.gap = '4px'

    const label = document.createElement('div')
    label.textContent = item.label
    label.style.fontSize = '11px'
    label.style.opacity = '0.7'

    section.appendChild(label)
    section.appendChild(
      createTextDiffValue(item.segments, item.accentColor, item.backgroundColor)
    )
    wrapper.appendChild(section)
  })

  return wrapper
}

function createCompactSectionTitle(text) {
  const title = document.createElement('div')
  title.textContent = text
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  title.style.marginBottom = '8px'
  return title
}

function createMetricToggleControls() {
  const wrapper = document.createElement('div')
  wrapper.style.display = 'grid'
  wrapper.style.gap = '6px'

  const label = document.createElement('div')
  label.textContent = 'Compare by'
  label.style.fontSize = '11px'
  label.style.fontWeight = '700'
  label.style.opacity = '0.82'
  wrapper.appendChild(label)

  const metricControls = document.createElement('div')
  metricControls.style.display = 'flex'
  metricControls.style.gap = '8px'
  metricControls.style.flexWrap = 'wrap'

  ;[
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' }
  ].forEach(option => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = option.label
    button.style.border = '1px solid rgba(255,255,255,0.14)'
    button.style.borderRadius = '999px'
    button.style.padding = '5px 10px'
    button.style.cursor = 'pointer'
    button.style.color = '#fff'
    button.style.background = comparisonSettings[option.key]
      ? 'rgba(59, 130, 246, 0.35)'
      : 'rgba(255,255,255,0.06)'

    button.onclick = () => {
      const nextValue = !comparisonSettings[option.key]
      const otherKey = option.key === 'width' ? 'height' : 'width'

      if (!nextValue && !comparisonSettings[otherKey]) {
        return
      }

      comparisonSettings[option.key] = nextValue
      renderValidationUI()
    }

    metricControls.appendChild(button)
  })

  wrapper.appendChild(metricControls)
  return wrapper
}

const GEOMETRY_INSIGHT_RULES = {
  combined: {
    issue: [
      'Element differs from Figma in both width ({widthAmount}) and height ({heightAmount}). Parent or container sizing constraints likely differ from the design.{contextIssue}',
      'Width ({widthAmount}) and height ({heightAmount}) are both off, which usually points to a container-level sizing mismatch.{contextIssue}',
      'This element is misaligned in both dimensions: width {widthAmount}, height {heightAmount}. The parent sizing model is likely different from Figma.{contextIssue}'
    ],
    suggestion: [
      'Check parent dimensions, flex or grid sizing, and surrounding padding or spacing constraints.{contextSuggestion}',
      'Review the parent container width and height behavior, along with any flex, grid, or spacing rules around this element.{contextSuggestion}',
      'Inspect the container constraints first: parent size, layout rules, and nearby spacing are the most likely causes.{contextSuggestion}'
    ]
  },
  'width:positive': {
    issue: [
      'Element is {direction} than expected by {amount}. Possible overflow, stretched flex behavior, or an incorrect container width constraint.{contextIssue}',
      'Width is larger than Figma by {amount}. This often happens when the element is allowed to grow beyond the intended container width.{contextIssue}',
      'Element appears {direction} than designed by {amount}. A missing width cap or expanding layout rule may be stretching it.{contextIssue}'
    ],
    suggestion: [
      'Check parent container width, missing max-width, flex growth, or content overflow constraints.{contextSuggestion}',
      'Review width constraints such as max-width, flex-grow, and any overflowing content pushing the element outward.{contextSuggestion}',
      'Inspect the parent width model and confirm the element is not expanding because of flex, intrinsic content, or missing caps.{contextSuggestion}'
    ]
  },
  'width:negative': {
    issue: [
      'Element is {direction} than expected by {amount}. It may be shrinking too much or inheriting a tighter width constraint than intended.{contextIssue}',
      'Width is smaller than Figma by {amount}. The element may be compressed by parent constraints or shrink behavior.{contextIssue}',
      'Element looks {direction} than designed by {amount}. A restrictive width rule or limited horizontal space may be squeezing it.{contextIssue}'
    ],
    suggestion: [
      'Check flex-shrink, fixed width rules, parent width constraints, or missing horizontal space.{contextSuggestion}',
      'Review shrink behavior, fixed widths, and parent sizing rules that could be compressing the element horizontally.{contextSuggestion}',
      'Inspect whether the parent is limiting available width or whether this element is shrinking more than intended.{contextSuggestion}'
    ]
  },
  'height:positive': {
    issue: [
      'Element is {direction} than expected by {amount}. Extra padding, text wrapping, line-height, or min-height may be increasing the final size.{contextIssue}',
      'Height is larger than Figma by {amount}. Additional spacing or wrapped content may be making the element taller than expected.{contextIssue}',
      'Element appears {direction} than designed by {amount}. Padding, line-height, or content expansion may be inflating its height.{contextIssue}'
    ],
    suggestion: [
      'Check padding, line-height, text wrapping, and min-height or content expansion around this element.{contextSuggestion}',
      'Review vertical padding, text wrapping, and any min-height rule that could be stretching the element downward.{contextSuggestion}',
      'Inspect content flow and vertical spacing to confirm the element is not growing because of wrapping or extra padding.{contextSuggestion}'
    ]
  },
  'height:negative': {
    issue: [
      'Element is {direction} than expected by {amount}. Content may be clipped or the container may be collapsing below the intended height.{contextIssue}',
      'Height is smaller than Figma by {amount}. Missing padding, clipped content, or a collapsed container could be reducing its size.{contextIssue}',
      'Element looks {direction} than designed by {amount}. The final height may be reduced by clipping, tight spacing, or missing vertical room.{contextIssue}'
    ],
    suggestion: [
      'Check padding, min-height, line-height, and any overflow or clipping rules affecting this element.{contextSuggestion}',
      'Review vertical spacing, min-height, and overflow behavior to see whether the element is being compressed.{contextSuggestion}',
      'Inspect padding and content height rules to confirm the container is not collapsing or clipping its contents.{contextSuggestion}'
    ]
  }
}

const GEOMETRY_CONTEXT_RULES = [
  {
    key: 'isFlexContainer',
    issue: () => ' Parent uses flex layout, so flex sizing may be influencing the final box.',
    suggestion: ({ primaryMetric, primaryDelta }) =>
      primaryMetric === 'width'
        ? ` Check flex-${primaryDelta > 0 ? 'grow' : 'shrink'} and flex-basis on this item and its siblings.`
        : ' Check cross-axis sizing, align-items, and flex-basis in the parent flex container.'
  },
  {
    key: 'isGridContainer',
    issue: () => ' Parent uses grid layout, so track sizing may be affecting the final dimensions.',
    suggestion: () =>
      ' Review grid-template tracks, auto sizing, and item alignment in the parent grid.'
  },
  {
    key: 'hasOverflowHidden',
    issue: ({ primaryDelta }) =>
      primaryDelta < 0 ? ' Overflow is clipped here, which can hide content and make the box read smaller.' : '',
    suggestion: () =>
      ' Inspect overflow, clipping, and whether content is being visually cut off.'
  },
  {
    key: 'isTextElement',
    issue: ({ primaryMetric }) =>
      primaryMetric === 'height'
        ? ' This appears to be text, so wrapping and line-height are strong suspects.'
        : ' This appears to be text, so wrapping and intrinsic content width may be affecting the box.',
    suggestion: ({ primaryMetric }) =>
      primaryMetric === 'height'
        ? ' Compare line-height, white-space, and wrapping behavior against the design.'
        : ' Check white-space, wrapping, and whether text content is forcing a different width.'
  },
  {
    key: 'hasPadding',
    issue: () => ' Existing padding on the element may be contributing to the size difference.',
    suggestion: () =>
      ' Compare the applied padding values with Figma and confirm box-sizing is behaving as expected.'
  },
  {
    key: 'isInlineElement',
    issue: () => ' Inline layout can size the element from content flow instead of a fixed box.',
    suggestion: () =>
      ' Verify whether inline display is intentional or if a block or inline-block box is expected.'
  }
]

let insightPickCounter = 0

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return ''

  const index = insightPickCounter % arr.length
  insightPickCounter += 1
  return arr[index]
}

function fillTemplate(template, variables) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ''
  )
}

function getContextSignals(element) {
  if (!(element instanceof Element)) {
    return {
      isFlexContainer: false,
      isGridContainer: false,
      hasOverflowHidden: false,
      isTextElement: false,
      hasPadding: false,
      isInlineElement: false
    }
  }

  const style = window.getComputedStyle(element)
  const parentStyle = element.parentElement
    ? window.getComputedStyle(element.parentElement)
    : null
  const tagName = element.tagName?.toLowerCase() || ''
  const display = style.display || ''
  const overflowValues = [
    style.overflow,
    style.overflowX,
    style.overflowY,
    parentStyle?.overflow,
    parentStyle?.overflowX,
    parentStyle?.overflowY
  ]
  const paddingValues = [
    style.paddingTop,
    style.paddingRight,
    style.paddingBottom,
    style.paddingLeft
  ]
  const textTags = new Set([
    'span',
    'p',
    'label',
    'a',
    'strong',
    'em',
    'small',
    'b',
    'i',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6'
  ])

  return {
    isFlexContainer: Boolean(parentStyle?.display?.includes('flex')),
    isGridContainer: Boolean(parentStyle?.display?.includes('grid')),
    hasOverflowHidden: overflowValues.some(value => value === 'hidden' || value === 'clip'),
    isTextElement:
      textTags.has(tagName) ||
      (element.childElementCount === 0 && (element.textContent || '').trim().length > 0),
    hasPadding: paddingValues.some(value => parseFloat(value) > 0),
    isInlineElement:
      display === 'inline' ||
      display === 'inline-block' ||
      display === 'inline-flex' ||
      display === 'inline-grid'
  }
}

function buildContextMessageFragments(signals, context) {
  const issue = []
  const suggestion = []

  GEOMETRY_CONTEXT_RULES.forEach(rule => {
    if (!signals?.[rule.key]) return

    const issuePart = rule.issue?.(context) || ''
    const suggestionPart = rule.suggestion?.(context) || ''

    if (issuePart) issue.push(issuePart.trim())
    if (suggestionPart) suggestion.push(suggestionPart.trim())
  })

  return {
    issue: issue.length ? ` ${issue.join(' ')}` : '',
    suggestion: suggestion.length ? ` ${suggestion.join(' ')}` : ''
  }
}

function getMismatchDirection(metricKey, deltaValue) {
  const largerText = metricKey === 'width' ? 'wider' : 'taller'
  const smallerText = metricKey === 'width' ? 'narrower' : 'shorter'
  return deltaValue > 0 ? largerText : smallerText
}

function buildGeometryInsight(result, element) {
  if (result.status !== 'mismatch' || result.mappingStatus !== 'matched') {
    return null
  }

  const activeMismatches = getActiveMetrics()
    .filter(metric => result.comparisons?.[metric] === false)
    .map(metric => ({
      metric,
      delta: getGeometryDelta(result.figma?.[metric], result.browser?.[metric])
    }))
    .filter(entry => typeof entry.delta === 'number')

  if (!activeMismatches.length) return null

  const widthEntry = activeMismatches.find(entry => entry.metric === 'width') || null
  const heightEntry = activeMismatches.find(entry => entry.metric === 'height') || null
  const primaryEntry = activeMismatches[0]
  const signals = getContextSignals(element)
  const scenarioKey =
    activeMismatches.length === 2
      ? 'combined'
      : `${primaryEntry.metric}:${primaryEntry.delta > 0 ? 'positive' : 'negative'}`
  const rule = GEOMETRY_INSIGHT_RULES[scenarioKey]

  if (!rule) {
    return {
      issueTitle: 'Likely issue',
      issueBody: 'Geometry differs from Figma and may be caused by layout constraints around this element.',
      suggestionTitle: 'Suggestion',
      suggestionBody: 'Inspect the parent container, sizing rules, and nearby spacing that influence this element.'
    }
  }

  const contextFragments = buildContextMessageFragments(signals, {
    primaryMetric: primaryEntry.metric,
    primaryDelta: primaryEntry.delta,
    activeMismatches
  })
  const variables = {
    amount: formatPixelValue(primaryEntry.delta, { signed: true }),
    direction: getMismatchDirection(primaryEntry.metric, primaryEntry.delta),
    widthAmount: formatPixelValue(widthEntry?.delta, { signed: true }),
    heightAmount: formatPixelValue(heightEntry?.delta, { signed: true }),
    contextIssue: contextFragments.issue,
    contextSuggestion: contextFragments.suggestion
  }

  return {
    issueTitle: 'Likely issue',
    issueBody: fillTemplate(pickRandom(rule.issue), variables),
    suggestionTitle: 'Suggestion',
    suggestionBody: fillTemplate(pickRandom(rule.suggestion), variables)
  }
}

function createMetricRow(
  label,
  figmaValue,
  browserValue,
  isActive,
  comparisonValue,
  mappingStatus,
  deltaValue
) {
  const row = document.createElement('div')
  row.style.display = 'grid'
  row.style.gridTemplateColumns = '56px 1fr 1fr 76px'
  row.style.gap = '8px'
  row.style.alignItems = 'center'
  row.style.padding = '6px 0'
  row.style.borderTop = '1px solid rgba(255, 255, 255, 0.08)'
  row.style.opacity = isActive ? '1' : '0.45'

  const name = document.createElement('div')
  name.textContent = label
  name.style.opacity = '0.7'

  const figma = document.createElement('div')
  figma.textContent = formatPixelValue(figmaValue)
  figma.style.color = '#fde68a'

  const browser = document.createElement('div')
  browser.textContent = formatPixelValue(browserValue)
  browser.style.color = '#bfdbfe'

  const status = document.createElement('div')
  if (mappingStatus === 'unmatched') {
    status.textContent = 'Unmapped'
    status.style.color = '#fcd34d'
  } else if (!isActive) {
    status.textContent = 'Off'
    status.style.color = 'rgba(255,255,255,0.45)'
  } else {
    status.textContent = comparisonValue
      ? 'Match'
      : typeof deltaValue === 'number'
        ? formatPixelValue(deltaValue, { signed: true })
        : 'Diff'
    status.style.color = comparisonValue ? '#86efac' : '#fca5a5'
  }
  status.style.textAlign = 'right'

  row.appendChild(name)
  row.appendChild(figma)
  row.appendChild(browser)
  row.appendChild(status)

  return row
}

function formatStyleValue(value) {
  if (value == null) return '--'
  if (typeof value === 'number') return `${value}px`
  if (typeof value === 'object' && 'r' in value) {
    return `rgb(${value.r}, ${value.g}, ${value.b})`
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '--'
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, nestedValue]) => nestedValue != null)
      .map(([key, nestedValue]) => `${key}: ${nestedValue}`)
      .join(', ')
  }
  return String(value)
}

function hasStyleDiffs(result) {
  const diffs = result?.styleComparison?.diffs || {}

  return Object.values(diffs).some(group =>
    Object.values(group || {}).some(Boolean)
  )
}

function createStyleDetails(result) {
  if (result.mappingStatus === 'matched' && !hasStyleDiffs(result)) {
    return null
  }

  const wrapper = document.createElement('details')
  wrapper.style.marginTop = '10px'
  wrapper.style.borderTop = '1px solid rgba(255,255,255,0.08)'
  wrapper.style.paddingTop = '8px'

  const summary = document.createElement('summary')
  summary.textContent = 'Style details'
  summary.style.cursor = 'pointer'
  summary.style.fontSize = '11px'
  summary.style.fontWeight = '700'
  summary.style.opacity = '0.88'
  wrapper.appendChild(summary)

  const body = document.createElement('div')
  body.style.marginTop = '8px'
  body.style.display = 'grid'
  body.style.gap = '8px'

  if (result.mappingStatus === 'unmatched') {
    const note = document.createElement('div')
    note.textContent =
      'Style details unavailable: no trusted DOM mapping. Figma styles shown below.'
    note.style.fontSize = '11px'
    note.style.color = '#fcd34d'
    body.appendChild(note)
  }

  const source =
    result.mappingStatus === 'matched' ? result.styleComparison : { figma: result.figmaStyles }
  const groups = source?.figma || {}

  Object.entries(groups).forEach(([groupKey, groupValues]) => {
    const properties = Object.entries(groupValues || {}).filter(([, value]) => value != null)
    if (properties.length === 0) return

    const section = document.createElement('div')
    section.style.display = 'grid'
    section.style.gap = '4px'

    const heading = document.createElement('div')
    heading.textContent = groupKey
    heading.style.fontSize = '11px'
    heading.style.fontWeight = '700'
    heading.style.opacity = '0.82'
    section.appendChild(heading)

    properties.forEach(([propertyKey, figmaValue]) => {
      const row = document.createElement('div')
      row.style.display = 'grid'
      // Wide enough for long keys (e.g. counterAxisAlignItems); minmax prevents overlap with value columns.
      row.style.gridTemplateColumns =
        result.mappingStatus === 'matched'
          ? 'minmax(120px, 38%) minmax(0, 1fr) minmax(0, 1fr) 48px'
          : 'minmax(120px, 38%) minmax(0, 1fr)'
      row.style.gap = '8px'
      row.style.alignItems = 'start'
      row.style.fontSize = '11px'
      row.style.opacity = '0.86'

      const property = document.createElement('div')
      property.textContent = propertyKey
      property.style.opacity = '0.7'
      property.style.wordBreak = 'break-word'
      property.style.overflowWrap = 'break-word'
      property.style.minWidth = '0'
      property.style.paddingRight = '4px'
      property.style.lineHeight = '1.35'
      row.appendChild(property)

      const figma = document.createElement('div')
      figma.textContent = formatStyleValue(figmaValue)
      figma.style.color = '#fde68a'
      figma.style.minWidth = '0'
      row.appendChild(figma)

      if (result.mappingStatus === 'matched') {
        const browserValue = source.browser?.[groupKey]?.[propertyKey]
        const diff = source.diffs?.[groupKey]?.[propertyKey]

        const browser = document.createElement('div')
        browser.textContent = formatStyleValue(browserValue)
        browser.style.color = '#bfdbfe'
        browser.style.minWidth = '0'
        browser.style.wordBreak = 'break-word'
        row.appendChild(browser)

        const status = document.createElement('div')
        status.textContent = diff ? 'Diff' : 'Match'
        status.style.color = diff ? '#fca5a5' : '#86efac'
        status.style.textAlign = 'right'
        row.appendChild(status)
      }

      section.appendChild(row)
    })

    body.appendChild(section)
  })

  if (!body.children.length) {
    const empty = document.createElement('div')
    empty.textContent =
      result.mappingStatus === 'matched'
        ? 'No Figma style properties available for this node.'
        : 'No Figma style properties available for this unmatched node.'
    empty.style.fontSize = '11px'
    empty.style.opacity = '0.7'
    body.appendChild(empty)
  }

  wrapper.appendChild(body)
  return wrapper
}

function createTextDetails(result) {
  if (typeof result.figmaText !== 'string') return null
  if (result.mappingStatus === 'matched' && result.textComparison?.matches === true) {
    return null
  }

  const wrapper = document.createElement('div')
  wrapper.style.marginTop = '10px'
  wrapper.style.borderTop = '1px solid rgba(255,255,255,0.08)'
  wrapper.style.paddingTop = '8px'
  wrapper.style.display = 'grid'
  wrapper.style.gap = '8px'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  header.style.gap = '8px'

  const title = document.createElement('div')
  title.textContent = 'Text content'
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  title.style.opacity = '0.88'

  const pill = document.createElement('div')
  const textMatches = result.textComparison?.matches === true
  pill.textContent =
    result.mappingStatus === 'unmatched'
      ? 'UNMAPPED'
      : textMatches
        ? 'MATCH'
        : 'MISMATCH'
  pill.style.padding = '2px 8px'
  pill.style.borderRadius = '999px'
  pill.style.fontSize = '10px'
  pill.style.fontWeight = '700'
  pill.style.letterSpacing = '0.08em'
  pill.style.color = '#fff'
  pill.style.background =
    result.mappingStatus === 'unmatched'
      ? '#92400e'
      : textMatches
        ? '#166534'
        : '#991b1b'

  header.appendChild(title)
  header.appendChild(pill)
  wrapper.appendChild(header)

  if (result.mappingStatus === 'unmatched') {
    const note = document.createElement('div')
    note.textContent =
      'Text comparison unavailable: no trusted DOM mapping. Figma text shown below.'
    note.style.fontSize = '11px'
    note.style.color = '#fcd34d'
    wrapper.appendChild(note)
  }

  if (result.mappingStatus === 'matched') {
    wrapper.appendChild(
      createTextDiffComparisonSection(
        result.figmaText,
        result.textComparison?.browser ?? ''
      )
    )
  } else {
    const section = document.createElement('div')
    section.style.display = 'grid'
    section.style.gap = '4px'

    const label = document.createElement('div')
    label.textContent = 'Figma'
    label.style.fontSize = '11px'
    label.style.opacity = '0.7'

    const body = document.createElement('div')
    body.textContent = result.figmaText || '--'
    body.style.whiteSpace = 'pre-wrap'
    body.style.wordBreak = 'break-word'
    body.style.fontSize = '11px'
    body.style.color = '#fde68a'
    body.style.padding = '6px 8px'
    body.style.borderRadius = '8px'
    body.style.background = 'rgba(255,255,255,0.03)'

    section.appendChild(label)
    section.appendChild(body)
    wrapper.appendChild(section)
  }

  return wrapper
}

function createSuggestedCandidatesDetails(result) {
  if (!Array.isArray(result.topCandidates) || result.topCandidates.length === 0) {
    return null
  }

  const topCandidate = result.topCandidates[0] || null
  const hasAmbiguousGap = typeof topCandidate?.confidenceGap === 'number' && topCandidate.confidenceGap <= 1
  const shouldShow =
    result.mappingStatus === 'unmatched' ||
    result.confidenceLevel === 'low' ||
    (result.confidenceLevel === 'medium' && hasAmbiguousGap)

  if (!shouldShow) {
    return null
  }

  const wrapper = document.createElement('details')
  wrapper.style.marginTop = '10px'
  wrapper.style.borderTop = '1px solid rgba(255,255,255,0.08)'
  wrapper.style.paddingTop = '8px'

  const summary = document.createElement('summary')
  summary.textContent = 'Candidate review'
  summary.style.cursor = 'pointer'
  summary.style.fontSize = '11px'
  summary.style.fontWeight = '700'
  summary.style.opacity = '0.88'
  wrapper.appendChild(summary)

  const body = document.createElement('div')
  body.style.display = 'grid'
  body.style.gap = '6px'
  body.style.marginTop = '8px'

  result.topCandidates.forEach((candidate, index) => {
    const row = document.createElement('div')
    row.style.padding = '6px 8px'
    row.style.borderRadius = '8px'
    row.style.background = 'rgba(255,255,255,0.03)'
    row.style.fontSize = '11px'

    const title = document.createElement('div')
    title.textContent = `${index + 1}. ${candidate.nodeName} • score ${candidate.score}`
    title.style.fontWeight = '700'

    const meta = document.createElement('div')
    meta.style.opacity = '0.76'
    meta.textContent = `bounds ${Math.round(candidate.bounds.width)}×${Math.round(candidate.bounds.height)} at (${Math.round(candidate.bounds.x)}, ${Math.round(candidate.bounds.y)})${
      typeof candidate.confidenceGap === 'number' ? ` • gap ${candidate.confidenceGap}` : ''
    }`

    row.appendChild(title)
    row.appendChild(meta)
    body.appendChild(row)
  })

  wrapper.appendChild(body)
  return wrapper
}

function buildValidationEntries(validation) {
  const rows = []
  let index = 0

  function walk(result, depth, label, parentId = null) {
    const currentId = index
    const match = validation.matches[currentId] || null
    const row = {
      id: currentId,
      result,
      depth,
      label,
      match,
      parentId,
      childIds: []
    }

    rows.push(row)
    index += 1

    ;(result.children || []).forEach(child => {
      const childId = walk(child, depth + 1, `Nested child • level ${depth + 1}`, currentId)
      row.childIds.push(childId)
    })

    return currentId
  }

  walk(validation.result, 0, 'Selected container')
  return rows
}

function buildEntryMap(entries) {
  return entries.reduce((map, entry) => {
    map.set(entry.id, entry)
    return map
  }, new Map())
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(value, maxLength = QA_MAX_SUMMARY_LENGTH) {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function cleanupLabelText(value) {
  const normalized = normalizeText(value)
  if (!normalized) return ''
  if (normalized.length > 72 && !/\s/.test(normalized.slice(0, 48))) return ''
  if (/[a-z][A-Z]/.test(normalized) && normalized.split(/\s+/).length <= 2 && normalized.length > 28) {
    return ''
  }

  return normalized.replace(/(.{3,}?)\1{1,}/g, '$1')
}

function getReadableLabelText(value, maxWords = 6, maxChars = 34) {
  const cleaned = cleanupLabelText(value)
  if (!cleaned) return ''

  const words = cleaned.split(/\s+/).filter(Boolean)
  const shortened =
    words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : cleaned

  return truncateText(shortened, maxChars)
}

function getElementOwnVisibleText(element) {
  if (!(element instanceof Element)) return ''

  const rawText = normalizeText(element.textContent)
  if (!rawText) return ''

  const childTexts = Array.from(element.children || [])
    .map(child => normalizeText(child.textContent))
    .filter(Boolean)

  if (childTexts.length === 0) return rawText

  let ownText = rawText
  childTexts.forEach(text => {
    ownText = ownText.replace(text, ' ')
  })

  return normalizeText(ownText) || rawText
}

function getElementAccessibleLabel(element) {
  if (!(element instanceof Element)) return ''

  const attributeCandidates = [
    element.getAttribute('aria-label'),
    element.getAttribute('alt'),
    element.getAttribute('title'),
    element.getAttribute('placeholder'),
    'value' in element ? element.value : ''
  ]

  for (const candidate of attributeCandidates) {
    const label = getReadableLabelText(candidate)
    if (label) return label
  }

  return ''
}

function getElementDirectTextLabel(element, maxWords = 6, maxChars = 34) {
  if (!(element instanceof Element)) return ''

  const ownTextLabel = getReadableLabelText(getElementOwnVisibleText(element), maxWords, maxChars)
  if (ownTextLabel) return ownTextLabel

  return getReadableLabelText(element.innerText || element.textContent || '', maxWords, maxChars)
}

function getElementSemanticLabel(element, containerElement) {
  if (!(element instanceof Element)) return 'content block'

  const containerRect =
    containerElement instanceof Element
      ? containerElement.getBoundingClientRect()
      : element.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const offsetX =
    rect.x + rect.width / 2 - (containerRect.x + containerRect.width / 2)
  const offsetY =
    rect.y + rect.height / 2 - (containerRect.y + containerRect.height / 2)
  const prefix =
    Math.abs(offsetX) > Math.abs(offsetY) * 1.25
      ? offsetX < 0
        ? 'left '
        : 'right '
      : Math.abs(offsetY) > Math.abs(offsetX) * 1.25
        ? offsetY < 0
          ? 'top '
          : 'bottom '
        : ''
  const tagName = element.tagName?.toLowerCase() || ''
  const semanticText = `${tagName} ${element.getAttribute('role') || ''} ${
    element.getAttribute('data-testid') || ''
  } ${typeof element.className === 'string' ? element.className : ''}`.toLowerCase()

  if (element.querySelector('svg, img') || tagName === 'img' || tagName === 'svg') {
    return `${prefix}icon block`.trim()
  }

  if (['button', 'a', 'input'].includes(tagName) || /button|cta/.test(semanticText)) {
    return `${prefix}button`.trim()
  }

  if (/chip|tag|badge|pill/.test(semanticText)) {
    return `${prefix}tag chip`.trim()
  }

  if (/title|heading|headline/.test(semanticText)) {
    return `${prefix}title text`.trim()
  }

  if (/label|copy|text|content|body/.test(semanticText) || normalizeText(element.textContent)) {
    return `${prefix}text stack`.trim()
  }

  return `${prefix}content block`.trim() || 'content block'
}

function getNumericDeltaLabel(delta) {
  return typeof delta === 'number' ? formatPixelValue(delta, { signed: true }) : '--'
}

function getFixPropertyLabel(property) {
  if (property === 'row-gap') return 'row gap'
  if (property === 'column-gap') return 'column gap'
  if (property === 'gap') return 'gap'
  if (property === 'padding-top') return 'top inset'
  if (property === 'padding-left') return 'left inset'
  if (property === 'padding-right') return 'right inset'
  if (property === 'padding-bottom') return 'bottom inset'
  if (property === 'align-items') return 'alignment'
  if (property === 'width') return 'width'
  if (property === 'height') return 'height'
  if (property === 'font-size') return 'font size'
  if (property === 'font-weight') return 'font weight'
  if (property === 'font-family') return 'font family'
  if (property === 'line-height') return 'line height'
  if (property === 'letter-spacing') return 'letter spacing'
  if (property === 'border-radius') return 'border radius'
  if (property === 'border-top-left-radius') return 'top-left radius'
  if (property === 'border-top-right-radius') return 'top-right radius'
  if (property === 'border-bottom-right-radius') return 'bottom-right radius'
  if (property === 'border-bottom-left-radius') return 'bottom-left radius'
  if (property === 'stroke-width') return 'stroke width'
  if (property === 'stroke-color') return 'stroke color'
  if (property === 'text-color') return 'text color'
  if (property === 'background-color') return 'background color'
  if (property === 'opacity') return 'opacity'
  if (property === 'blend-mode') return 'blend mode'
  if (property === 'shadow') return 'shadow'
  return String(property || 'property')
}

function formatFixValue(value, property = '') {
  if (value == null) return '--'
  if (typeof value === 'object' && 'r' in value) {
    const toHex = channel => Number(channel).toString(16).padStart(2, '0').toUpperCase()
    return `#${toHex(value.r)}${toHex(value.g)}${toHex(value.b)}`
  }
  if (typeof value === 'number') {
    if (property === 'font-weight') return String(Math.round(value))
    if (property === 'opacity') return String(Math.round(value * 1000) / 1000)
    return formatPixelValue(value)
  }
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '--'
  }
  return String(value)
}

function createRecommendedFix({
  confidence,
  kind,
  instruction,
  expectedValue = null,
  actualValue = null,
  likelyProperty = '',
  likelyElementLabel = '',
  reason = ''
}) {
  return {
    confidence,
    kind,
    instruction,
    expectedValue,
    actualValue,
    likelyProperty,
    likelyElementLabel,
    reason
  }
}

// QA mode translates raw node-level validation into visible issue cards that
// anchor on one or two rendered regions instead of blaming the Figma tree.
function buildQaInterpretation(entries) {
  const entryMap = buildEntryMap(entries)
  const qaIssueMap = new Map()
  const devNotes = []
  const notesByEntryId = new Map()
  const textLabelCache = new Map()
  const scopeLabelCache = new Map()
  const subtreeTextCache = new Map()

  function getParentEntry(entry) {
    return entry?.parentId != null ? entryMap.get(entry.parentId) || null : null
  }

  function getBounds(entry, source) {
    return source === 'browser' ? entry?.result.browserBounds : entry?.result.figmaBounds
  }

  function getEdge(bounds, axis, edge) {
    if (!bounds) return null
    if (axis === 'x') {
      if (edge === 'start') return bounds.x
      if (edge === 'end') return bounds.x + bounds.width
      if (edge === 'center') return bounds.x + bounds.width / 2
      return bounds.width
    }

    if (edge === 'start') return bounds.y
    if (edge === 'end') return bounds.y + bounds.height
    if (edge === 'center') return bounds.y + bounds.height / 2
    return bounds.height
  }

  function compareDistance(figmaValue, browserValue) {
    if (typeof figmaValue !== 'number' || typeof browserValue !== 'number') return null
    return browserValue - figmaValue
  }

  function isMeaningfulNodeName(name) {
    return !/^(frame|group|rectangle|instance|component|layout|auto layout)\b/i.test(
      String(name || '').trim()
    )
  }

  function getReadableSnippet(value, maxWords = 7, maxChars = 44) {
    return getReadableLabelText(value, maxWords, maxChars)
  }

  function getElementTextSnippet(element) {
    if (!(element instanceof Element)) return ''

    return getElementDirectTextLabel(element, 6, 34) || getElementAccessibleLabel(element)
  }

  function getLabelQualityRank(quality) {
    if (quality === 'high') return 3
    if (quality === 'medium') return 2
    return 1
  }

  function getEntryLabelInfo(entry, options = {}) {
    if (!entry) {
      return {
        label: options.scope ? 'selected area' : 'content block',
        quality: 'fallback'
      }
    }

    const cacheKey = `${entry.id}:${options.scope ? 'scope' : 'node'}`
    if (textLabelCache.has(cacheKey)) {
      return textLabelCache.get(cacheKey)
    }

    const element = entry.match?.element
    const figmaText = getDescendantFigmaText(entry)
    const directDomText = getElementDirectTextLabel(element, options.scope ? 7 : 5, options.scope ? 36 : 28)
    const accessibleLabel = getElementAccessibleLabel(element)
    let info = null

    if (directDomText) {
      info = {
        label: directDomText,
        quality: 'high'
      }
    } else if (figmaText) {
      info = {
        label: getReadableSnippet(figmaText, options.scope ? 7 : 5, options.scope ? 36 : 28),
        quality: 'medium'
      }
    } else if (accessibleLabel) {
      info = {
        label: accessibleLabel,
        quality: 'medium'
      }
    } else if (options.scope && isMeaningfulNodeName(entry.result.nodeName)) {
      info = {
        label: getReadableSnippet(entry.result.nodeName, 5, 28),
        quality: 'fallback'
      }
    } else {
      info = {
        label: getElementSemanticLabel(element, latestValidationContext?.containerElement),
        quality: 'fallback'
      }
    }

    if (!info.label) {
      info = {
        label: options.scope ? 'selected area' : 'content block',
        quality: 'fallback'
      }
    }

    textLabelCache.set(cacheKey, info)
    return info
  }

  function getDescendantFigmaText(entry) {
    if (!entry) return ''
    if (subtreeTextCache.has(entry.id)) return subtreeTextCache.get(entry.id)

    const ownText = getReadableSnippet(entry.result.figmaText)
    if (ownText) {
      subtreeTextCache.set(entry.id, ownText)
      return ownText
    }

    let childText = ''
    entry.childIds.some(childId => {
      childText = getDescendantFigmaText(entryMap.get(childId))
      return Boolean(childText)
    })

    subtreeTextCache.set(entry.id, childText)
    return childText
  }

  function getRelativeRegionPrefix(entry, parentEntry) {
    const bounds = getBounds(entry, 'browser') || getBounds(entry, 'figma')
    const parentBounds = getBounds(parentEntry, 'browser') || getBounds(parentEntry, 'figma')
    if (!bounds || !parentBounds) return ''

    const offsetX = getEdge(bounds, 'x', 'center') - getEdge(parentBounds, 'x', 'center')
    const offsetY = getEdge(bounds, 'y', 'center') - getEdge(parentBounds, 'y', 'center')

    if (Math.abs(offsetX) > Math.abs(offsetY) * 1.25) {
      return offsetX < 0 ? 'left ' : 'right '
    }

    if (Math.abs(offsetY) > Math.abs(offsetX) * 1.25) {
      return offsetY < 0 ? 'top ' : 'bottom '
    }

    return ''
  }

  function looksIconRegion(entry) {
    const element = entry?.match?.element
    const nodeName = String(entry?.result.nodeName || '').toLowerCase()
    const bounds = getBounds(entry, 'browser') || getBounds(entry, 'figma')

    return (
      /icon|avatar|image|logo/.test(nodeName) ||
      Boolean(element?.querySelector('svg, img')) ||
      (bounds &&
        bounds.width <= 56 &&
        bounds.height <= 56 &&
        !getElementTextSnippet(element) &&
        !getDescendantFigmaText(entry))
    )
  }

  function looksInteractiveRegion(entry) {
    const element = entry?.match?.element
    const tagName = element?.tagName?.toLowerCase() || ''
    const role = element?.getAttribute?.('role') || ''
    const nodeName = String(entry?.result.nodeName || '').toLowerCase()

    return (
      tagName === 'button' ||
      tagName === 'a' ||
      role === 'button' ||
      /button|cta|chip|tag|badge|pill|link/.test(nodeName)
    )
  }

  function getEntryLabel(entry, options = {}) {
    const info = getEntryLabelInfo(entry, options)
    return info.label
  }

  function getScopeLabel(entry) {
    if (!entry) return 'selected area'
    if (scopeLabelCache.has(entry.id)) return scopeLabelCache.get(entry.id)

    let label =
      getEntryLabelInfo(entry, { scope: true }).label ||
      getElementTextSnippet(entry.match?.element) ||
      getDescendantFigmaText(entry)

    if (!label) {
      label =
        entry.depth === 0
          ? 'selected area'
          : isMeaningfulNodeName(entry.result.nodeName)
            ? truncateText(entry.result.nodeName)
            : 'this section'
    }

    scopeLabelCache.set(entry.id, label)
    return label
  }

  function getIssueSuggestion(kind, axis) {
    if (kind === 'shape') {
      return 'Check the border radius values on this element and match the Figma shape treatment.'
    }

    if (kind === 'stroke') {
      return 'Check the stroke width on this element and match the Figma border treatment.'
    }

    if (kind === 'color') {
      return 'Check the explicit color value on this element and match the Figma color token or hex code.'
    }

    if (kind === 'style') {
      return 'Check the explicit style properties for this element and match the Figma visual settings.'
    }

    if (kind === 'typography') {
      return 'Check the typography property values on this text element and match the Figma text settings.'
    }

    if (kind === 'text') {
      return 'Check the source string, truncation, and any rendering fallback for this text.'
    }

    if (kind === 'size' && axis === 'x') {
      return 'Check width constraints, max-width, flex-grow, and parent sizing around this region.'
    }

    if (kind === 'size' && axis === 'y') {
      return 'Check height constraints, min-height, padding, and content expansion in this region.'
    }

    if (kind === 'alignment' && axis === 'x') {
      return 'Check left or right alignment, column sizing, and horizontal positioning of these regions.'
    }

    if (kind === 'alignment' && axis === 'y') {
      return 'Check top alignment and vertical positioning of these regions.'
    }

    if (axis === 'x') {
      return 'Check margin-left, padding-left/right, column gap, and horizontal alignment in this area.'
    }

    return 'Check margin-top, padding-top/bottom, row gap, and vertical alignment in this area.'
  }

  function getAxisDirection(axis, delta) {
    if (axis === 'x') return delta > 0 ? 'farther right' : 'farther left'
    return delta > 0 ? 'lower' : 'higher'
  }

  function buildRecommendedFixForPair({
    kind,
    axis,
    primaryEntry,
    secondaryEntry,
    scopeEntry,
    figmaValue,
    browserValue,
    delta,
    relationEdge = 'start'
  }) {
    if (
      !primaryEntry?.match?.element ||
      typeof figmaValue !== 'number' ||
      typeof browserValue !== 'number'
    ) {
      return null
    }

    const primaryLabel = getEntryLabel(primaryEntry)
    const secondaryLabel = secondaryEntry ? getEntryLabel(secondaryEntry) : getScopeLabel(scopeEntry)

    if (kind === 'spacing' && secondaryEntry && secondaryEntry.id !== scopeEntry.id) {
      const property = axis === 'x' ? 'column-gap' : 'row-gap'
      return createRecommendedFix({
        confidence: 'high',
        kind: 'spacing',
        instruction: `Set the ${getFixPropertyLabel(property)} between ${primaryLabel} and ${secondaryLabel} to ${formatFixValue(
          figmaValue,
          property
        )} instead of ${formatFixValue(browserValue, property)}.`,
        expectedValue: figmaValue,
        actualValue: browserValue,
        likelyProperty: property,
        likelyElementLabel: `${primaryLabel} / ${secondaryLabel}`,
        reason: `The relation engine measured the rendered ${getFixPropertyLabel(property)} directly from Figma and browser bounds.`
      })
    }

    if (kind === 'spacing') {
      const property =
        axis === 'x'
          ? relationEdge === 'end'
            ? 'padding-right'
            : 'padding-left'
          : relationEdge === 'end'
            ? 'padding-bottom'
            : 'padding-top'
      return createRecommendedFix({
        confidence: 'high',
        kind: 'inset',
        instruction: `Set the ${getFixPropertyLabel(property)} for ${primaryLabel} to ${formatFixValue(
          figmaValue,
          property
        )} instead of ${formatFixValue(browserValue, property)}.`,
        expectedValue: figmaValue,
        actualValue: browserValue,
        likelyProperty: property,
        likelyElementLabel: primaryLabel,
        reason: `The child inset inside ${getScopeLabel(scopeEntry)} is measured directly from Figma and browser geometry.`
      })
    }

    if (kind === 'alignment') {
      const expectedEdge = axis === 'y' ? 'top' : 'left'
      return createRecommendedFix({
        confidence: 'high',
        kind: 'alignment',
        instruction: `Make ${primaryLabel} ${expectedEdge}-aligned with ${secondaryLabel}. Remove the ${formatFixValue(
          Math.abs(delta),
          axis === 'y' ? 'padding-top' : 'padding-left'
        )} offset.`,
        expectedValue: figmaValue,
        actualValue: browserValue,
        likelyProperty: 'align-items',
        likelyElementLabel: primaryLabel,
        reason: `Figma expects aligned ${expectedEdge} edges, but the browser render is offset by ${getNumericDeltaLabel(
          delta
        )}.`
      })
    }

    return null
  }

  function buildRecommendedFixForSize(entry, axis, figmaValue, browserValue, delta) {
    if (
      !entry?.match?.element ||
      typeof figmaValue !== 'number' ||
      typeof browserValue !== 'number'
    ) {
      return null
    }

    const property = axis === 'x' ? 'width' : 'height'
    return createRecommendedFix({
      confidence: 'high',
      kind: 'size',
      instruction: `Set ${getEntryLabel(entry)} ${getFixPropertyLabel(property)} to ${formatFixValue(
        figmaValue,
        property
      )} instead of ${formatFixValue(browserValue, property)}.`,
      expectedValue: figmaValue,
      actualValue: browserValue,
      likelyProperty: property,
      likelyElementLabel: getEntryLabel(entry),
      reason: `This mapped box differs by ${getNumericDeltaLabel(delta)} from the Figma dimension.`
    })
  }

  function getTypographyUnits(styleComparison, propertyKey) {
    if (propertyKey === 'lineHeight') {
      return {
        figmaUnit: styleComparison?.figma?.typography?.lineHeightUnit || null,
        browserUnit: styleComparison?.browser?.typography?.lineHeightUnit || null,
        unitDiff: Boolean(styleComparison?.diffs?.typography?.lineHeightUnit)
      }
    }

    if (propertyKey === 'letterSpacing') {
      return {
        figmaUnit: styleComparison?.figma?.typography?.letterSpacingUnit || null,
        browserUnit: styleComparison?.browser?.typography?.letterSpacingUnit || null,
        unitDiff: Boolean(styleComparison?.diffs?.typography?.letterSpacingUnit)
      }
    }

    return {
      figmaUnit: null,
      browserUnit: null,
      unitDiff: false
    }
  }

  function formatTypographyValue(value, unit, cssProperty) {
    if (value == null && !unit) return '--'
    if (cssProperty === 'font-family') return formatFixValue(value, cssProperty)
    if (unit === 'AUTO') return 'AUTO'
    if (typeof value === 'number') {
      if (unit === 'PERCENT') {
        return `${Math.round(value * 100) / 100}%`
      }
      if (unit === 'NUMBER') {
        return String(Math.round(value * 100) / 100)
      }
      return formatFixValue(value, cssProperty)
    }
    return formatFixValue(value, cssProperty)
  }

  function createTypographyIssue(entry, parentEntry, propertyKey) {
    const figmaValue = entry.result.styleComparison?.figma?.typography?.[propertyKey]
    const browserValue = entry.result.styleComparison?.browser?.typography?.[propertyKey]
    const isDiff = entry.result.styleComparison?.diffs?.typography?.[propertyKey]
    const { figmaUnit, browserUnit, unitDiff } = getTypographyUnits(
      entry.result.styleComparison,
      propertyKey
    )

    if ((!isDiff && !unitDiff) || (figmaValue == null && browserValue == null)) return

    const label = getEntryLabel(entry)
    const scopeLabel = getScopeLabel(parentEntry || entry)
    const cssProperty =
      propertyKey === 'fontFamily'
        ? 'font-family'
        : propertyKey === 'fontSize'
        ? 'font-size'
        : propertyKey === 'fontWeight'
          ? 'font-weight'
          : propertyKey === 'lineHeight'
            ? 'line-height'
            : 'letter-spacing'
    const expectedDisplay = formatTypographyValue(figmaValue, figmaUnit, cssProperty)
    const actualDisplay = formatTypographyValue(browserValue, browserUnit, cssProperty)
    const deltaValue =
      typeof figmaValue === 'number' && typeof browserValue === 'number' && !unitDiff
        ? browserValue - figmaValue
        : null

    upsertIssue({
      key: `typography:${propertyKey}:${entry.id}`,
      kind: 'typography',
      severity: 'fail',
      axis: 'both',
      summary: `${getFixPropertyLabel(cssProperty)} for ${label} should be ${expectedDisplay}; browser is ${actualDisplay} in ${scopeLabel}`,
      details: `Figma ${getFixPropertyLabel(cssProperty)}: ${expectedDisplay} • Browser ${getFixPropertyLabel(
        cssProperty
      )}: ${actualDisplay}`,
      suggestion: getIssueSuggestion('typography', 'both'),
      scopeLabel,
      primaryAnchorNodeId: entry.result.nodeId || String(entry.id),
      primaryElement: entry.match?.element || null,
      secondaryElement: null,
      figmaValue: expectedDisplay,
      browserValue: actualDisplay,
      delta: deltaValue,
      sourceNodeIds: [entry.result.nodeId || String(entry.id)],
      primaryEntryId: entry.id,
      priority: 3,
      labelQuality: getEntryLabelInfo(entry).quality,
      recommendedFix: createRecommendedFix({
        confidence: 'high',
        kind: 'typography',
        instruction: `Set ${getFixPropertyLabel(cssProperty)} for ${label} to ${expectedDisplay} instead of ${actualDisplay}.`,
        expectedValue: expectedDisplay,
        actualValue: actualDisplay,
        likelyProperty: cssProperty,
        likelyElementLabel: label,
        reason: unitDiff
          ? `The mapped text element differs from Figma in both ${getFixPropertyLabel(
              cssProperty
            )} value and unit interpretation.`
          : `The mapped text element has an explicit ${getFixPropertyLabel(cssProperty)} style diff against the Figma snapshot.`
      })
    })
  }

  function getColorPropertyConfig(groupKey, propertyKey) {
    const configMap = {
      colors: {
        text: { cssProperty: 'text-color', label: 'color', allowVisualQa: false },
        background: {
          cssProperty: 'background-color',
          label: 'color',
          allowVisualQa: false
        }
      },
      border: {
        strokeColor: { cssProperty: 'stroke-color', label: 'color', allowVisualQa: false }
      }
    }

    return configMap[groupKey]?.[propertyKey] || null
  }

  function createColorIssue(entry, parentEntry, groupKey, propertyKey) {
    const config = getColorPropertyConfig(groupKey, propertyKey)
    if (!config) return

    const figmaValue = entry.result.styleComparison?.figma?.[groupKey]?.[propertyKey]
    const browserValue = entry.result.styleComparison?.browser?.[groupKey]?.[propertyKey]
    const isDiff = entry.result.styleComparison?.diffs?.[groupKey]?.[propertyKey]

    if (!isDiff || !figmaValue || !browserValue) return

    const label = getEntryLabel(entry)
    const scopeLabel = getScopeLabel(parentEntry || entry)
    const expectedDisplay = formatFixValue(figmaValue, config.cssProperty)
    const actualDisplay = formatFixValue(browserValue, config.cssProperty)

    upsertIssue({
      key: `color:${groupKey}:${propertyKey}:${entry.id}`,
      kind: 'color',
      severity: 'fail',
      axis: 'both',
      summary: `${getFixPropertyLabel(config.cssProperty)} for ${label} should be ${expectedDisplay}; browser is ${actualDisplay} in ${scopeLabel}`,
      details: `Figma ${getFixPropertyLabel(config.cssProperty)}: ${expectedDisplay} • Browser ${getFixPropertyLabel(
        config.cssProperty
      )}: ${actualDisplay}`,
      suggestion: getIssueSuggestion('color', 'both'),
      scopeLabel,
      primaryAnchorNodeId: entry.result.nodeId || String(entry.id),
      primaryElement: entry.match?.element || null,
      secondaryElement: null,
      figmaValue: expectedDisplay,
      browserValue: actualDisplay,
      delta: null,
      sourceNodeIds: [entry.result.nodeId || String(entry.id)],
      primaryEntryId: entry.id,
      priority: 3,
      devOnly: !config.allowVisualQa,
      labelQuality: getEntryLabelInfo(entry).quality,
      recommendedFix: createRecommendedFix({
        confidence: 'high',
        kind: 'color',
        instruction: `Set ${getFixPropertyLabel(config.cssProperty)} for ${label} to ${expectedDisplay} instead of ${actualDisplay}.`,
        expectedValue: expectedDisplay,
        actualValue: actualDisplay,
        likelyProperty: config.cssProperty,
        likelyElementLabel: label,
        reason: `The mapped element has an explicit ${getFixPropertyLabel(
          config.cssProperty
        )} diff against the Figma snapshot.`
      })
    })
  }

  function getStylePropertyConfig(groupKey, propertyKey) {
    const configMap = {
      border: {
        radius: { cssProperty: 'border-radius', kind: 'shape', allowVisualQa: false },
        topLeftRadius: {
          cssProperty: 'border-top-left-radius',
          kind: 'shape',
          allowVisualQa: false
        },
        topRightRadius: {
          cssProperty: 'border-top-right-radius',
          kind: 'shape',
          allowVisualQa: false
        },
        bottomRightRadius: {
          cssProperty: 'border-bottom-right-radius',
          kind: 'shape',
          allowVisualQa: false
        },
        bottomLeftRadius: {
          cssProperty: 'border-bottom-left-radius',
          kind: 'shape',
          allowVisualQa: false
        },
        strokeWidth: { cssProperty: 'stroke-width', kind: 'stroke', allowVisualQa: false },
        strokeColor: null
      },
      compositing: {
        opacity: { cssProperty: 'opacity', kind: 'style', allowVisualQa: false },
        blendMode: { cssProperty: 'blend-mode', kind: 'style', allowVisualQa: false }
      },
      effects: {
        shadow: { cssProperty: 'shadow', kind: 'style', allowVisualQa: false }
      }
    }

    return configMap[groupKey]?.[propertyKey] || null
  }

  function createStylePropertyIssue(entry, parentEntry, groupKey, propertyKey) {
    const config = getStylePropertyConfig(groupKey, propertyKey)
    if (!config) return

    const figmaValue = entry.result.styleComparison?.figma?.[groupKey]?.[propertyKey]
    const browserValue = entry.result.styleComparison?.browser?.[groupKey]?.[propertyKey]
    const isDiff = entry.result.styleComparison?.diffs?.[groupKey]?.[propertyKey]

    if (!isDiff || figmaValue == null || browserValue == null) return

    const label = getEntryLabel(entry)
    const scopeLabel = getScopeLabel(parentEntry || entry)
    const expectedDisplay = formatFixValue(figmaValue, config.cssProperty)
    const actualDisplay = formatFixValue(browserValue, config.cssProperty)
    const deltaValue =
      typeof figmaValue === 'number' && typeof browserValue === 'number'
        ? browserValue - figmaValue
        : null

    upsertIssue({
      key: `style:${groupKey}:${propertyKey}:${entry.id}`,
      kind: config.kind,
      severity: 'fail',
      axis: 'both',
      summary: `${getFixPropertyLabel(config.cssProperty)} for ${label} should be ${expectedDisplay}; browser is ${actualDisplay} in ${scopeLabel}`,
      details: `Figma ${getFixPropertyLabel(config.cssProperty)}: ${expectedDisplay} • Browser ${getFixPropertyLabel(
        config.cssProperty
      )}: ${actualDisplay}`,
      suggestion: getIssueSuggestion(config.kind, 'both'),
      scopeLabel,
      primaryAnchorNodeId: entry.result.nodeId || String(entry.id),
      primaryElement: entry.match?.element || null,
      secondaryElement: null,
      figmaValue: expectedDisplay,
      browserValue: actualDisplay,
      delta: deltaValue,
      sourceNodeIds: [entry.result.nodeId || String(entry.id)],
      primaryEntryId: entry.id,
      priority: 2,
      devOnly: !config.allowVisualQa,
      labelQuality: getEntryLabelInfo(entry).quality,
      recommendedFix: createRecommendedFix({
        confidence: 'medium',
        kind: config.kind,
        instruction: `Set ${getFixPropertyLabel(config.cssProperty)} for ${label} to ${expectedDisplay} instead of ${actualDisplay}.`,
        expectedValue: expectedDisplay,
        actualValue: actualDisplay,
        likelyProperty: config.cssProperty,
        likelyElementLabel: label,
        reason: `The mapped element has an explicit ${getFixPropertyLabel(
          config.cssProperty
        )} style diff against the Figma snapshot.`
      })
    })
  }

  function hasVisibleClipping(element) {
    if (!(element instanceof Element)) return false

    const style = window.getComputedStyle(element)
    const hasClipping = [style.overflow, style.overflowX, style.overflowY].some(value =>
      ['hidden', 'clip', 'scroll', 'auto'].includes(value)
    )

    return (
      hasClipping &&
      (element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1)
    )
  }

  function upsertIssue(issue) {
    if (issue.devOnly) {
      devNotes.push(issue)

      const entryNotes = notesByEntryId.get(issue.primaryEntryId) || []
      entryNotes.push(issue)
      notesByEntryId.set(issue.primaryEntryId, entryNotes)
      return
    }

    const existing = qaIssueMap.get(issue.key)
    if (!existing) {
      qaIssueMap.set(issue.key, issue)
      return
    }

    if (
      issue.priority > existing.priority ||
      (issue.priority === existing.priority &&
        Math.abs(issue.delta || 0) > Math.abs(existing.delta || 0))
    ) {
      qaIssueMap.set(issue.key, issue)
    }
  }

  function createPairIssue({
    scopeEntry,
    primaryEntry,
    secondaryEntry,
    axis,
    kind,
    priority,
    summary,
    details,
    figmaValue,
    browserValue,
    delta,
    relationType = '',
    relationEdge = 'start',
    highlightAnchor = 'primary'
  }) {
    const pairKey = [primaryEntry.id, secondaryEntry.id].sort((a, b) => a - b).join(':')

    const recommendedFix = buildRecommendedFixForPair({
      kind,
      axis,
      primaryEntry,
      secondaryEntry,
      scopeEntry,
      figmaValue,
      browserValue,
      delta,
      relationEdge
    })

    upsertIssue({
      key: `${scopeEntry.id}:${axis}:${pairKey}`,
      kind,
      severity: 'fail',
      axis,
      summary,
      details,
      suggestion: getIssueSuggestion(kind, axis),
      scopeLabel: getScopeLabel(scopeEntry),
      primaryAnchorNodeId: primaryEntry.result.nodeId || String(primaryEntry.id),
      secondaryAnchorNodeId: secondaryEntry.result.nodeId || String(secondaryEntry.id),
      primaryElement: primaryEntry.match?.element || null,
      secondaryElement: secondaryEntry.match?.element || null,
      figmaValue,
      browserValue,
      delta,
      sourceNodeIds: [
        primaryEntry.result.nodeId || String(primaryEntry.id),
        secondaryEntry.result.nodeId || String(secondaryEntry.id)
      ],
      primaryEntryId: primaryEntry.id,
      secondaryEntryId: secondaryEntry.id,
      priority,
      recommendedFix,
      relationType,
      relationEdge,
      highlightAnchor,
      labelQuality:
        getLabelQualityRank(getEntryLabelInfo(primaryEntry).quality) <
        getLabelQualityRank(getEntryLabelInfo(secondaryEntry).quality)
          ? getEntryLabelInfo(primaryEntry).quality
          : getEntryLabelInfo(secondaryEntry).quality
    })
  }

  function createSizeOrNoteIssue(entry, axis, delta, parentEntry, widthEquivalent = false) {
    const metric = axis === 'x' ? 'width' : 'height'
    const label = getEntryLabel(entry)
    const scopeLabel = getScopeLabel(parentEntry || entry)
    const summary =
      axis === 'x'
        ? `${label} is ${Math.abs(Math.round(delta * 100) / 100)}px ${
            delta > 0 ? 'wider' : 'narrower'
          } than expected inside ${scopeLabel}`
        : `${label} is ${Math.abs(Math.round(delta * 100) / 100)}px ${
            delta > 0 ? 'taller' : 'shorter'
          } than expected inside ${scopeLabel}`

    const issue = {
      key: `size:${axis}:${entry.id}`,
      kind: 'size',
      severity: widthEquivalent ? 'note' : 'fail',
      axis,
      summary,
      details: `Figma ${metric}: ${formatPixelValue(
        entry.result.figma[metric]
      )} • Browser ${metric}: ${formatPixelValue(entry.result.browser[metric])}`,
      suggestion: widthEquivalent
        ? 'Box width differs, but the visible alignment and spacing still match Figma.'
        : getIssueSuggestion('size', axis),
      scopeLabel,
      primaryAnchorNodeId: entry.result.nodeId || String(entry.id),
      primaryElement: entry.match?.element || null,
      secondaryElement: null,
      figmaValue: entry.result.figma[metric],
      browserValue: entry.result.browser[metric],
      delta,
      sourceNodeIds: [entry.result.nodeId || String(entry.id)],
      primaryEntryId: entry.id,
      devOnly: widthEquivalent,
      priority: widthEquivalent ? 0 : 1,
      labelQuality: getEntryLabelInfo(entry).quality,
      recommendedFix: widthEquivalent
        ? null
        : buildRecommendedFixForSize(
            entry,
            axis,
            entry.result.figma[metric],
            entry.result.browser[metric],
            delta
          )
    }

    upsertIssue(issue)
  }

  function createTextIssue(entry, parentEntry) {
    const scopeLabel = getScopeLabel(parentEntry || entry)
    const label = getEntryLabel(entry)
    const figmaText = normalizeText(entry.result.figmaText)
    const browserText = normalizeText(entry.result.textComparison?.browser)

    upsertIssue({
      key: `text:${entry.id}`,
      kind: 'text',
      source: 'mapped_text',
      severity: 'fail',
      axis: 'both',
      summary: `${label} text does not match Figma`,
      details: `Figma: "${truncateText(figmaText, 56)}" • Browser: "${truncateText(
        browserText,
        56
      )}"`,
      suggestion: getIssueSuggestion('text', 'both'),
      scopeLabel,
      primaryAnchorNodeId: entry.result.nodeId || String(entry.id),
      primaryElement: entry.match?.element || null,
      secondaryElement: null,
      figmaValue: figmaText,
      browserValue: browserText || null,
      delta: null,
      sourceNodeIds: [entry.result.nodeId || String(entry.id)],
      primaryEntryId: entry.id,
      priority: 4,
      labelQuality: getEntryLabelInfo(entry).quality,
      recommendedFix: createRecommendedFix({
        confidence: 'medium',
        kind: 'text',
        instruction: `Update the text for ${label} to match Figma.`,
        expectedValue: figmaText,
        actualValue: browserText || null,
        likelyProperty: 'text-content',
        likelyElementLabel: label,
        reason: 'The mapped text content differs directly from the Figma source string.'
      })
    })
  }

  function buildSingleChildInsetIssue(scopeEntry, childEntry, axis) {
    const scopeFigma = getBounds(scopeEntry, 'figma')
    const scopeBrowser = getBounds(scopeEntry, 'browser')
    const childFigma = getBounds(childEntry, 'figma')
    const childBrowser = getBounds(childEntry, 'browser')

    if (!scopeFigma || !scopeBrowser || !childFigma || !childBrowser) return

    const startDelta = compareDistance(
      getEdge(childFigma, axis, 'start') - getEdge(scopeFigma, axis, 'start'),
      getEdge(childBrowser, axis, 'start') - getEdge(scopeBrowser, axis, 'start')
    )
    const endDelta = compareDistance(
      getEdge(scopeFigma, axis, 'end') - getEdge(childFigma, axis, 'end'),
      getEdge(scopeBrowser, axis, 'end') - getEdge(childBrowser, axis, 'end')
    )

    const chosenDelta =
      Math.abs(startDelta || 0) >= Math.abs(endDelta || 0) ? startDelta : endDelta

    if (typeof chosenDelta !== 'number' || Math.abs(chosenDelta) <= QA_RELATION_TOLERANCE) {
      return
    }

    const childLabel = getEntryLabel(childEntry)
    const scopeLabel = getScopeLabel(scopeEntry)
    const summary =
      axis === 'y'
        ? `${childLabel} sits ${Math.abs(chosenDelta)}px ${getAxisDirection(
            axis,
            chosenDelta
          )} than expected inside ${scopeLabel}`
        : `${childLabel} sits ${Math.abs(chosenDelta)}px ${getAxisDirection(
            axis,
            chosenDelta
          )} than expected inside ${scopeLabel}`

    createPairIssue({
      scopeEntry,
      primaryEntry: childEntry,
      secondaryEntry: scopeEntry,
      axis,
      kind: 'spacing',
      priority: 1,
      summary,
      details:
        axis === 'y'
          ? `Inset drift inside ${scopeLabel}: ${getNumericDeltaLabel(chosenDelta)}`
          : `Inset drift inside ${scopeLabel}: ${getNumericDeltaLabel(chosenDelta)}`,
      figmaValue:
        Math.abs(startDelta || 0) >= Math.abs(endDelta || 0)
          ? getEdge(childFigma, axis, 'start') - getEdge(scopeFigma, axis, 'start')
          : getEdge(scopeFigma, axis, 'end') - getEdge(childFigma, axis, 'end'),
      browserValue:
        Math.abs(startDelta || 0) >= Math.abs(endDelta || 0)
          ? getEdge(childBrowser, axis, 'start') - getEdge(scopeBrowser, axis, 'start')
          : getEdge(scopeBrowser, axis, 'end') - getEdge(childBrowser, axis, 'end'),
      delta: chosenDelta,
      relationType: 'inset',
      relationEdge: Math.abs(startDelta || 0) >= Math.abs(endDelta || 0) ? 'start' : 'end',
      highlightAnchor: 'primary'
    })
  }

  function getFigmaSiblingGap(scopeEntry, axis, leftFigma, rightFigma) {
    const layout = scopeEntry.result.figmaStyles && scopeEntry.result.figmaStyles.layout
    const useAuthoritativeGap =
      layout &&
      typeof layout.itemSpacing === 'number' &&
      layout.primaryAxisAlignItems !== 'SPACE_BETWEEN' &&
      ((axis === 'x' && layout.layoutMode === 'HORIZONTAL') ||
        (axis === 'y' && layout.layoutMode === 'VERTICAL'))

    if (useAuthoritativeGap) {
      return layout.itemSpacing
    }

    return getEdge(rightFigma, axis, 'start') - getEdge(leftFigma, axis, 'end')
  }

  function buildSiblingIssues(scopeEntry, axis, matchedChildren) {
    const sortedChildren = [...matchedChildren].sort((left, right) => {
      const leftCenter = getEdge(getBounds(left, 'figma'), axis, 'center')
      const rightCenter = getEdge(getBounds(right, 'figma'), axis, 'center')
      return leftCenter - rightCenter
    })

    for (let index = 0; index < sortedChildren.length - 1; index += 1) {
      const leftEntry = sortedChildren[index]
      const rightEntry = sortedChildren[index + 1]
      const leftFigma = getBounds(leftEntry, 'figma')
      const rightFigma = getBounds(rightEntry, 'figma')
      const leftBrowser = getBounds(leftEntry, 'browser')
      const rightBrowser = getBounds(rightEntry, 'browser')

      if (!leftFigma || !rightFigma || !leftBrowser || !rightBrowser) continue

      const figmaGap = getFigmaSiblingGap(scopeEntry, axis, leftFigma, rightFigma)
      const browserGap =
        getEdge(rightBrowser, axis, 'start') - getEdge(leftBrowser, axis, 'end')
      const gapDelta = compareDistance(figmaGap, browserGap)

      if (typeof gapDelta === 'number' && Math.abs(gapDelta) > QA_RELATION_TOLERANCE) {
        createPairIssue({
          scopeEntry,
          primaryEntry: leftEntry,
          secondaryEntry: rightEntry,
          axis,
          kind: 'spacing',
          priority: 2,
          summary: `Gap between ${getEntryLabel(leftEntry)} and ${getEntryLabel(
            rightEntry
          )} is ${Math.abs(gapDelta)}px ${
            gapDelta > 0 ? 'larger' : 'smaller'
          } than expected in ${getScopeLabel(scopeEntry)}`,
          details: `Figma gap: ${formatPixelValue(figmaGap)} • Browser gap: ${formatPixelValue(
            browserGap
          )}`,
          figmaValue: figmaGap,
          browserValue: browserGap,
          delta: gapDelta,
          relationType: 'sibling_gap',
          relationEdge: 'start',
          highlightAnchor: 'secondary'
        })
      }

      const alignmentMetrics =
        axis === 'y'
          ? [
              { key: 'top', label: 'top edges', edge: 'start' },
              { key: 'bottom', label: 'bottom edges', edge: 'end' },
              { key: 'center', label: 'vertical centers', edge: 'center' }
            ]
          : [
              { key: 'left', label: 'left edges', edge: 'start' },
              { key: 'right', label: 'right edges', edge: 'end' },
              { key: 'center', label: 'horizontal centers', edge: 'center' }
            ]

      const candidateAlignments = alignmentMetrics
        .map(metric => {
          const figmaAlignmentDelta = compareDistance(
            getEdge(leftFigma, axis, metric.edge),
            getEdge(rightFigma, axis, metric.edge)
          )
          const browserAlignmentDelta = compareDistance(
            getEdge(leftBrowser, axis, metric.edge),
            getEdge(rightBrowser, axis, metric.edge)
          )

          return {
            metric,
            figmaAlignmentDelta,
            browserAlignmentDelta
          }
        })
        .filter(
          candidate =>
            typeof candidate.figmaAlignmentDelta === 'number' &&
            Math.abs(candidate.figmaAlignmentDelta) <= QA_RELATION_TOLERANCE &&
            typeof candidate.browserAlignmentDelta === 'number' &&
            Math.abs(candidate.browserAlignmentDelta) > QA_RELATION_TOLERANCE
        )
        .sort(
          (left, right) =>
            Math.abs(right.browserAlignmentDelta) - Math.abs(left.browserAlignmentDelta)
        )

      if (candidateAlignments.length === 0) continue

      const bestAlignment = candidateAlignments[0]
      const delta = bestAlignment.browserAlignmentDelta
      const primaryEntry = delta > 0 ? leftEntry : rightEntry
      const secondaryEntry = delta > 0 ? rightEntry : leftEntry

      createPairIssue({
        scopeEntry,
        primaryEntry,
        secondaryEntry,
        axis,
        kind: 'alignment',
        priority: 3,
        summary:
          axis === 'y'
            ? `${getEntryLabel(primaryEntry)} sits ${Math.abs(delta)}px ${getAxisDirection(
                axis,
                delta
              )} than ${getEntryLabel(secondaryEntry)} in ${getScopeLabel(scopeEntry)}`
            : `${getEntryLabel(primaryEntry)} sits ${Math.abs(delta)}px ${getAxisDirection(
                axis,
                delta
              )} than ${getEntryLabel(secondaryEntry)} in ${getScopeLabel(scopeEntry)}`,
        details: `Expected aligned ${bestAlignment.metric.label}. Browser offset: ${getNumericDeltaLabel(
          delta
        )}`,
        figmaValue: 0,
        browserValue: delta,
        delta,
        relationType: 'alignment',
        relationEdge: bestAlignment.metric.edge,
        highlightAnchor: 'primary'
      })
    }
  }

  function hasHorizontalVisualDrift(entry, matchedChildren) {
    if (hasVisibleClipping(entry.match?.element)) return true

    if (matchedChildren.length <= 1) {
      const onlyChild = matchedChildren[0]
      if (!onlyChild) return false

      const parentFigma = getBounds(entry, 'figma')
      const parentBrowser = getBounds(entry, 'browser')
      const childFigma = getBounds(onlyChild, 'figma')
      const childBrowser = getBounds(onlyChild, 'browser')
      if (!parentFigma || !parentBrowser || !childFigma || !childBrowser) return false

      const leftDelta = compareDistance(
        getEdge(childFigma, 'x', 'start') - getEdge(parentFigma, 'x', 'start'),
        getEdge(childBrowser, 'x', 'start') - getEdge(parentBrowser, 'x', 'start')
      )
      const rightDelta = compareDistance(
        getEdge(parentFigma, 'x', 'end') - getEdge(childFigma, 'x', 'end'),
        getEdge(parentBrowser, 'x', 'end') - getEdge(childBrowser, 'x', 'end')
      )

      return (
        Math.abs(leftDelta || 0) > QA_RELATION_TOLERANCE ||
        Math.abs(rightDelta || 0) > QA_RELATION_TOLERANCE
      )
    }

    const sortedChildren = [...matchedChildren].sort(
      (left, right) => getEdge(getBounds(left, 'figma'), 'x', 'center') - getEdge(getBounds(right, 'figma'), 'x', 'center')
    )

    for (let index = 0; index < sortedChildren.length - 1; index += 1) {
      const leftEntry = sortedChildren[index]
      const rightEntry = sortedChildren[index + 1]
      const leftFigma = getBounds(leftEntry, 'figma')
      const rightFigma = getBounds(rightEntry, 'figma')
      const leftBrowser = getBounds(leftEntry, 'browser')
      const rightBrowser = getBounds(rightEntry, 'browser')
      if (!leftFigma || !rightFigma || !leftBrowser || !rightBrowser) continue

      const figmaGap = getFigmaSiblingGap(entry, 'x', leftFigma, rightFigma)
      const browserGap =
        getEdge(rightBrowser, 'x', 'start') - getEdge(leftBrowser, 'x', 'end')

      if (Math.abs(compareDistance(figmaGap, browserGap) || 0) > QA_RELATION_TOLERANCE) {
        return true
      }

      const leftAlignmentDelta = compareDistance(
        getEdge(leftFigma, 'x', 'start'),
        getEdge(rightFigma, 'x', 'start')
      )
      const browserAlignmentDelta = compareDistance(
        getEdge(leftBrowser, 'x', 'start'),
        getEdge(rightBrowser, 'x', 'start')
      )

      if (
        Math.abs(leftAlignmentDelta || 0) <= QA_RELATION_TOLERANCE &&
        Math.abs(browserAlignmentDelta || 0) > QA_RELATION_TOLERANCE
      ) {
        return true
      }
    }

    return false
  }

  entries.forEach(entry => {
    const parentEntry = getParentEntry(entry)
    const matchedChildren = entry.childIds
      .map(childId => entryMap.get(childId))
      .filter(
        child =>
          child &&
          child.result.mappingStatus === 'matched' &&
          child.match?.element &&
          child.result.figmaBounds &&
          child.result.browserBounds
      )

    if (matchedChildren.length > 1) {
      if (comparisonSettings.height) buildSiblingIssues(entry, 'y', matchedChildren)
      if (comparisonSettings.width) buildSiblingIssues(entry, 'x', matchedChildren)
    } else if (matchedChildren.length === 1) {
      if (comparisonSettings.height) buildSingleChildInsetIssue(entry, matchedChildren[0], 'y')
      if (comparisonSettings.width) buildSingleChildInsetIssue(entry, matchedChildren[0], 'x')
    }

    if (typeof entry.result.figmaText === 'string') {
      const hasTextMismatch =
        entry.result.mappingStatus === 'matched' &&
        entry.result.textComparison?.matches === false
      if (hasTextMismatch && entry.match?.element) {
        createTextIssue(entry, parentEntry)
      }
    }

    if (entry.result.mappingStatus === 'matched' && entry.match?.element) {
      ;['fontFamily', 'letterSpacing', 'fontSize', 'fontWeight', 'lineHeight'].forEach(propertyKey => {
        createTypographyIssue(entry, parentEntry, propertyKey)
      })
      ;[
        ['colors', 'text'],
        ['colors', 'background'],
        ['border', 'strokeColor']
      ].forEach(([groupKey, propertyKey]) => {
        createColorIssue(entry, parentEntry, groupKey, propertyKey)
      })
      ;[
        ['border', 'radius'],
        ['border', 'topLeftRadius'],
        ['border', 'topRightRadius'],
        ['border', 'bottomRightRadius'],
        ['border', 'bottomLeftRadius'],
        ['border', 'strokeWidth'],
        ['compositing', 'opacity'],
        ['compositing', 'blendMode'],
        ['effects', 'shadow']
      ].forEach(([groupKey, propertyKey]) => {
        createStylePropertyIssue(entry, parentEntry, groupKey, propertyKey)
      })
    }

    if (entry.result.mappingStatus !== 'matched' || !entry.match?.element) return

    if (comparisonSettings.height && entry.result.comparisons?.height === false) {
      if (matchedChildren.length === 0 || entry.result.nodeType === 'TEXT') {
        createSizeOrNoteIssue(
          entry,
          'y',
          getGeometryDelta(entry.result.figma.height, entry.result.browser.height),
          parentEntry,
          false
        )
      }
    }

    if (comparisonSettings.width && entry.result.comparisons?.width === false) {
      // Suppress width-only drift in QA when the rendered horizontal layout still
      // looks equivalent; keep it as a Dev note instead.
      const widthEquivalent =
        entry.result.comparisons?.height !== false &&
        !hasHorizontalVisualDrift(entry, matchedChildren) &&
        !hasVisibleClipping(entry.match?.element) &&
        entry.result.textComparison?.matches !== false

      if (widthEquivalent || matchedChildren.length === 0 || entry.result.nodeType === 'TEXT') {
        createSizeOrNoteIssue(
          entry,
          'x',
          getGeometryDelta(entry.result.figma.width, entry.result.browser.width),
          parentEntry,
          widthEquivalent
        )
      }
    }
  })

  const qaIssues = Array.from(qaIssueMap.values()).sort((left, right) => {
    const leftDelta = Math.abs(left.delta || 0)
    const rightDelta = Math.abs(right.delta || 0)

    if (left.severity !== right.severity) {
      return left.severity === 'fail' ? -1 : 1
    }

    if (right.priority !== left.priority) {
      return right.priority - left.priority
    }

    return rightDelta - leftDelta
  })

  qaIssues.forEach((issue, index) => {
    issue.id = `qa-${index + 1}`
  })

  const issuesByPrimaryEntryId = new Map()
  const issuesBySecondaryEntryId = new Map()

  qaIssues.forEach(issue => {
    if (issue.severity !== 'fail') return

    if (typeof issue.primaryEntryId === 'number') {
      const primaryIssues = issuesByPrimaryEntryId.get(issue.primaryEntryId) || []
      primaryIssues.push(issue)
      issuesByPrimaryEntryId.set(issue.primaryEntryId, primaryIssues)
    }

    if (typeof issue.secondaryEntryId === 'number') {
      const secondaryIssues = issuesBySecondaryEntryId.get(issue.secondaryEntryId) || []
      secondaryIssues.push(issue)
      issuesBySecondaryEntryId.set(issue.secondaryEntryId, secondaryIssues)
    }
  })

  devNotes.sort(
    (left, right) => Math.abs(right.delta || 0) - Math.abs(left.delta || 0)
  )

  return {
    qaIssues,
    devNotes,
    notesByEntryId,
    issuesByPrimaryEntryId,
    issuesBySecondaryEntryId
  }
}

function buildDisplayValidation(rawValidation) {
  const derivedValidation = buildDerivedValidation(rawValidation)
  const entries = buildValidationEntries(derivedValidation)
  const qaInterpretation = buildQaInterpretation(entries)

  entries.forEach(entry => {
    entry.devVisualNotes = qaInterpretation.notesByEntryId.get(entry.id) || []
    entry.devPrimaryIssues = qaInterpretation.issuesByPrimaryEntryId.get(entry.id) || []
    entry.devSecondaryIssues = qaInterpretation.issuesBySecondaryEntryId.get(entry.id) || []
  })

  return {
    ...derivedValidation,
    entries,
    qaIssues: qaInterpretation.qaIssues,
    devVisualNotes: qaInterpretation.devNotes,
    devIssueMap: {
      primary: qaInterpretation.issuesByPrimaryEntryId,
      secondary: qaInterpretation.issuesBySecondaryEntryId
    }
  }
}

async function cropVisibleTabCaptureToContainer(
  captureDataUrl,
  containerElement,
  viewportBounds = null,
  viewportMetrics = null
) {
  const captureImage = await loadImageFromDataUrl(captureDataUrl)
  const rect =
    viewportBounds || (containerElement instanceof Element
      ? containerElement.getBoundingClientRect()
      : null)
  if (!rect) {
    throw new Error('Visual QA could not resolve the selected browser region bounds.')
  }

  const left = typeof rect.left === 'number' ? rect.left : rect.x
  const top = typeof rect.top === 'number' ? rect.top : rect.y
  const width = rect.width
  const height = rect.height
  const viewportWidth = Math.max(
    1,
    viewportMetrics?.width || window.visualViewport?.width || window.innerWidth
  )
  const viewportHeight = Math.max(
    1,
    viewportMetrics?.height || window.visualViewport?.height || window.innerHeight
  )
  const offsetLeft = viewportMetrics?.offsetLeft || window.visualViewport?.offsetLeft || 0
  const offsetTop = viewportMetrics?.offsetTop || window.visualViewport?.offsetTop || 0
  const scaleX = captureImage.naturalWidth / viewportWidth
  const scaleY = captureImage.naturalHeight / viewportHeight

  const sourceX = clamp(
    Math.round((left - offsetLeft) * scaleX),
    0,
    captureImage.naturalWidth - 1
  )
  const sourceY = clamp(
    Math.round((top - offsetTop) * scaleY),
    0,
    captureImage.naturalHeight - 1
  )
  const sourceWidth = Math.max(
    1,
    Math.min(
      Math.round(width * scaleX),
      captureImage.naturalWidth - sourceX
    )
  )
  const sourceHeight = Math.max(
    1,
    Math.min(
      Math.round(height * scaleY),
      captureImage.naturalHeight - sourceY
    )
  )

  const { canvas, context } = createCanvasContext(sourceWidth, sourceHeight)
  context.drawImage(
    captureImage,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight
  )

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: sourceWidth,
    height: sourceHeight,
    viewportBounds: {
      x: left,
      y: top,
      width,
      height
    }
  }
}

async function createNormalizedImageData(dataUrl, targetWidth, targetHeight) {
  const image = await loadImageFromDataUrl(dataUrl)
  const { context } = createCanvasContext(targetWidth, targetHeight)
  context.drawImage(image, 0, 0, targetWidth, targetHeight)
  return context.getImageData(0, 0, targetWidth, targetHeight)
}

async function createCompositedImageDataUrl(dataUrl, backgroundColor = '#ffffff') {
  const image = await loadImageFromDataUrl(dataUrl)
  const { canvas, context } = createCanvasContext(
    image.naturalWidth,
    image.naturalHeight
  )
  context.fillStyle = backgroundColor
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0)
  return canvas.toDataURL('image/png')
}

function buildVisualDiffClusters(referenceImageData, browserImageData) {
  const width = referenceImageData.width
  const height = referenceImageData.height
  const blockSize = VISUAL_QA_DIFF_BLOCK_SIZE
  const cols = Math.ceil(width / blockSize)
  const rows = Math.ceil(height / blockSize)
  const grid = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null)
  )

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const startX = col * blockSize
      const startY = row * blockSize
      const endX = Math.min(startX + blockSize, width)
      const endY = Math.min(startY + blockSize, height)
      let totalDiff = 0
      let sampleCount = 0

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const index = (y * width + x) * 4
          totalDiff +=
            (Math.abs(referenceImageData.data[index] - browserImageData.data[index]) +
              Math.abs(referenceImageData.data[index + 1] - browserImageData.data[index + 1]) +
              Math.abs(referenceImageData.data[index + 2] - browserImageData.data[index + 2])) /
            3
          sampleCount += 1
        }
      }

      const averageDiff = sampleCount ? totalDiff / sampleCount : 0
      grid[row][col] = {
        row,
        col,
        averageDiff,
        active: averageDiff >= VISUAL_QA_DIFF_THRESHOLD
      }
    }
  }

  const clusters = []
  const visited = new Set()

  function visitCluster(startRow, startCol) {
    const queue = [[startRow, startCol]]
    const cells = []
    let totalDiff = 0
    let minCol = startCol
    let maxCol = startCol
    let minRow = startRow
    let maxRow = startRow

    while (queue.length) {
      const [row, col] = queue.shift()
      const key = `${row}:${col}`
      if (visited.has(key)) continue
      visited.add(key)

      const cell = grid[row]?.[col]
      if (!cell?.active) continue

      cells.push(cell)
      totalDiff += cell.averageDiff
      minCol = Math.min(minCol, col)
      maxCol = Math.max(maxCol, col)
      minRow = Math.min(minRow, row)
      maxRow = Math.max(maxRow, row)

      ;[
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1]
      ].forEach(([nextRow, nextCol]) => {
        if (
          nextRow >= 0 &&
          nextRow < rows &&
          nextCol >= 0 &&
          nextCol < cols &&
          !visited.has(`${nextRow}:${nextCol}`)
        ) {
          queue.push([nextRow, nextCol])
        }
      })
    }

    if (cells.length === 0) return null

    const bounds = {
      x: minCol * blockSize,
      y: minRow * blockSize,
      width: Math.min(width, (maxCol + 1) * blockSize) - minCol * blockSize,
      height: Math.min(height, (maxRow + 1) * blockSize) - minRow * blockSize
    }
    const blockAreaRatio =
      (cells.length * blockSize * blockSize) / Math.max(1, width * height)
    const averageDiff = totalDiff / cells.length

    if (
      cells.length < VISUAL_QA_MIN_CLUSTER_BLOCKS &&
      averageDiff < VISUAL_QA_DIFF_THRESHOLD * 1.8
    ) {
      return null
    }

    return {
      id: `cluster-${clusters.length + 1}`,
      bounds,
      normalizedBounds: {
        x: bounds.x / width,
        y: bounds.y / height,
        width: bounds.width / width,
        height: bounds.height / height
      },
      averageDiff: roundToPrecision(averageDiff, 2),
      areaRatio: roundToPrecision(blockAreaRatio, 4),
      dominantAxis: getVisualAxisFromRect(bounds),
      score: roundToPrecision(averageDiff * blockAreaRatio * 100, 2)
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!grid[row][col]?.active || visited.has(`${row}:${col}`)) continue
      const cluster = visitCluster(row, col)
      if (cluster) {
        clusters.push(cluster)
      }
    }
  }

  return clusters
    .sort((left, right) => right.score - left.score)
    .slice(0, VISUAL_QA_MAX_ISSUES)
}

function getVisualIssueBounds(issue, containerElement) {
  const containerRect = containerElement.getBoundingClientRect()
  const primaryRect =
    issue.primaryElement instanceof Element
      ? normalizeRectToContainer(
          issue.primaryElement.getBoundingClientRect(),
          containerRect
        )
      : null
  const secondaryRect =
    issue.secondaryElement instanceof Element
      ? normalizeRectToContainer(
          issue.secondaryElement.getBoundingClientRect(),
          containerRect
        )
      : null

  return unionRects(primaryRect, secondaryRect) || primaryRect || secondaryRect
}

function getVisualIssueFocusBounds(issue) {
  if (!issue) {
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1
    }
  }

  return (
    unionRects(
      unionRects(issue.expectedBounds, issue.actualBounds),
      issue.secondaryBounds
    ) ||
    unionRects(issue.primaryBounds, issue.secondaryBounds) ||
    issue.actualBounds ||
    issue.expectedBounds ||
    issue.primaryBounds ||
    issue.clusterBounds || {
      x: 0,
      y: 0,
      width: 1,
      height: 1
    }
  )
}

function shiftNormalizedBounds(bounds, axis, normalizedDelta) {
  if (!bounds || !normalizedDelta) return bounds || null

  if (axis === 'x') {
    return {
      ...bounds,
      x: clamp(bounds.x + normalizedDelta, 0, Math.max(0, 1 - bounds.width))
    }
  }

  if (axis === 'y') {
    return {
      ...bounds,
      y: clamp(bounds.y + normalizedDelta, 0, Math.max(0, 1 - bounds.height))
    }
  }

  return bounds
}

function resizeNormalizedBounds(bounds, axis, nextSize) {
  if (!bounds || typeof nextSize !== 'number' || nextSize <= 0) return bounds || null

  if (axis === 'x') {
    return {
      ...bounds,
      width: clamp(nextSize, 0.01, 1)
    }
  }

  if (axis === 'y') {
    return {
      ...bounds,
      height: clamp(nextSize, 0.01, 1)
    }
  }

  return bounds
}

function getNormalizedRectEdge(bounds, axis, edge) {
  if (!bounds) return null
  if (axis === 'x') {
    if (edge === 'start') return bounds.x
    if (edge === 'end') return bounds.x + bounds.width
    return bounds.x + bounds.width / 2
  }

  if (edge === 'start') return bounds.y
  if (edge === 'end') return bounds.y + bounds.height
  return bounds.y + bounds.height / 2
}

function setNormalizedRectEdge(bounds, axis, edge, value) {
  if (!bounds || typeof value !== 'number') return null

  if (axis === 'x') {
    if (edge === 'start') return { ...bounds, x: value }
    if (edge === 'end') return { ...bounds, x: value - bounds.width }
    return { ...bounds, x: value - bounds.width / 2 }
  }

  if (edge === 'start') return { ...bounds, y: value }
  if (edge === 'end') return { ...bounds, y: value - bounds.height }
  return { ...bounds, y: value - bounds.height / 2 }
}

function deriveExpectedActualHighlight(issue, primaryBounds, secondaryBounds) {
  const containerElement = latestValidationContext?.containerElement
  const containerRect =
    containerElement instanceof Element
      ? containerElement.getBoundingClientRect()
      : null

  if (!primaryBounds || !containerRect) {
    return {
      highlightMode: 'changed_area',
      highlightConfidence: 'fallback',
      expectedBounds: null,
      actualBounds: null
    }
  }

  if (
    issue.relationType === 'alignment' &&
    secondaryBounds &&
    (issue.axis === 'x' || issue.axis === 'y') &&
    ['start', 'end', 'center'].includes(issue.relationEdge)
  ) {
    const alignedEdgeValue = getNormalizedRectEdge(
      secondaryBounds,
      issue.axis,
      issue.relationEdge
    )
    const expectedBounds = setNormalizedRectEdge(
      primaryBounds,
      issue.axis,
      issue.relationEdge,
      alignedEdgeValue
    )

    if (expectedBounds) {
      return {
        highlightMode: 'expected_actual',
        highlightConfidence: 'exact',
        expectedBounds,
        actualBounds: primaryBounds
      }
    }
  }

  if (
    issue.relationType === 'sibling_gap' &&
    primaryBounds &&
    secondaryBounds &&
    typeof issue.figmaValue === 'number' &&
    (issue.axis === 'x' || issue.axis === 'y')
  ) {
    const expectedStart =
      issue.axis === 'x'
        ? primaryBounds.x + primaryBounds.width + issue.figmaValue / containerRect.width
        : primaryBounds.y + primaryBounds.height + issue.figmaValue / containerRect.height
    const expectedBounds = setNormalizedRectEdge(secondaryBounds, issue.axis, 'start', expectedStart)

    if (expectedBounds) {
      return {
        highlightMode: 'expected_actual',
        highlightConfidence: 'exact',
        expectedBounds,
        actualBounds: secondaryBounds
      }
    }
  }

  if (
    (issue.kind === 'alignment' || issue.kind === 'spacing') &&
    typeof issue.delta === 'number' &&
    (issue.axis === 'x' || issue.axis === 'y')
  ) {
    const containerSize =
      issue.axis === 'x' ? containerRect.width : containerRect.height
    if (containerSize > 0) {
      const normalizedDelta = issue.delta / containerSize
      return {
        highlightMode: 'expected_actual',
        highlightConfidence: issue.relationType === 'inset' ? 'good' : 'fallback',
        expectedBounds: shiftNormalizedBounds(
          primaryBounds,
          issue.axis,
          -normalizedDelta
        ),
        actualBounds: primaryBounds
      }
    }
  }

  if (
    issue.kind === 'size' &&
    typeof issue.figmaValue === 'number' &&
    typeof issue.browserValue === 'number' &&
    issue.browserValue > 0 &&
    (issue.axis === 'x' || issue.axis === 'y')
  ) {
    const ratio = issue.figmaValue / issue.browserValue
    const currentSize = issue.axis === 'x' ? primaryBounds.width : primaryBounds.height
    return {
      highlightMode: 'expected_actual',
      highlightConfidence: 'good',
      expectedBounds: resizeNormalizedBounds(
        primaryBounds,
        issue.axis,
        currentSize * ratio
      ),
      actualBounds: primaryBounds
    }
  }

  return {
    highlightMode: 'changed_area',
    highlightConfidence: 'fallback',
    expectedBounds: null,
    actualBounds: null
  }
}

function buildVisualIssueFromQaIssue(cluster, issue, scopeLabel) {
  const containerElement = latestValidationContext?.containerElement
  const primaryBounds =
    containerElement instanceof Element && issue.primaryElement instanceof Element
      ? normalizeRectToContainer(
          issue.primaryElement.getBoundingClientRect(),
          containerElement.getBoundingClientRect()
        )
      : null
  const secondaryBounds =
    containerElement instanceof Element && issue.secondaryElement instanceof Element
      ? normalizeRectToContainer(
          issue.secondaryElement.getBoundingClientRect(),
          containerElement.getBoundingClientRect()
        )
      : null
  const primaryLabel =
    getVisualRegionLabel(issue.primaryElement, latestValidationContext?.containerElement) ||
    'this region'
  const secondaryLabel =
    issue.secondaryElement && issue.secondaryElement !== issue.primaryElement
      ? getVisualRegionLabel(
          issue.secondaryElement,
          latestValidationContext?.containerElement
        )
      : null
  const kind =
    issue.kind === 'text'
      ? 'text'
      : issue.kind === 'typography'
        ? 'typography'
      : issue.kind === 'visual_style'
        ? 'visual_style'
      : issue.kind === 'size'
        ? 'size'
        : 'spacing_alignment'
  const axis = issue.axis || cluster.dominantAxis
  let summary = `${primaryLabel} looks different from Figma in ${scopeLabel}`
  let details = 'Visual QA found a visible difference in this area of the rendered UI.'
  const roundedDelta =
    typeof issue.delta === 'number' ? Math.abs(Math.round(issue.delta * 10) / 10) : null

  if (issue.kind === 'text') {
    summary = `${primaryLabel} text looks different from Figma in ${scopeLabel}`
    details =
      'Visual QA detected a text-region difference between the Figma reference render and the captured browser region.'
  } else if (issue.kind === 'typography') {
    summary = issue.summary
    details =
      'Visual QA found a visible typography mismatch and matched it to an explicit text style difference.'
  } else if (issue.kind === 'visual_style') {
    summary = issue.summary || `${primaryLabel} looks visually different from Figma in ${scopeLabel}`
    details =
      'Visual QA found a visible style mismatch and linked it to an explicit mapped visual difference.'
  } else if (issue.kind === 'size') {
    summary =
      issue.summary ||
      (roundedDelta != null
        ? `${primaryLabel} is ${roundedDelta}px ${
            typeof issue.delta === 'number' && issue.delta < 0 ? 'smaller' : 'larger'
          } than expected in ${scopeLabel}`
        : `${primaryLabel} looks ${
            typeof issue.delta === 'number' && issue.delta < 0 ? 'smaller' : 'larger'
          } than the Figma reference in ${scopeLabel}`)
    details =
      axis === 'y'
        ? 'Visual QA detected a visible height difference in this rendered region.'
        : 'Visual QA detected a visible width difference in this rendered region.'
  } else if (issue.kind === 'alignment' && secondaryLabel) {
    summary =
      issue.summary ||
      (roundedDelta != null
        ? `${primaryLabel} sits ${roundedDelta}px ${getAxisDirection(axis, issue.delta)} than ${secondaryLabel} in ${scopeLabel}`
        : `${primaryLabel} and ${secondaryLabel} do not line up the same way as Figma in ${scopeLabel}`)
    details =
      axis === 'y'
        ? 'Visual QA detected a visible vertical alignment shift between these rendered regions.'
        : 'Visual QA detected a visible horizontal alignment shift between these rendered regions.'
  } else if (issue.kind === 'spacing' && secondaryLabel) {
    summary =
      issue.summary ||
      (roundedDelta != null
        ? `Gap between ${primaryLabel} and ${secondaryLabel} is ${roundedDelta}px ${
            issue.delta > 0 ? 'larger' : 'smaller'
          } than Figma in ${scopeLabel}`
        : `The spacing between ${primaryLabel} and ${secondaryLabel} looks different from Figma in ${scopeLabel}`)
    details =
      axis === 'y'
        ? 'Visual QA detected a visible vertical spacing difference between these rendered regions.'
        : 'Visual QA detected a visible horizontal spacing difference between these rendered regions.'
  } else if (issue.kind === 'spacing') {
    summary =
      issue.summary ||
      (roundedDelta != null
        ? `${primaryLabel} sits ${roundedDelta}px ${getAxisDirection(axis, issue.delta)} than expected inside ${scopeLabel}`
        : `${primaryLabel} sits differently inside ${scopeLabel} than it does in Figma`)
    details =
      axis === 'y'
        ? 'Visual QA detected a visible vertical inset or placement difference in this rendered region.'
        : 'Visual QA detected a visible horizontal inset or placement difference in this rendered region.'
  }

  const highlightData = deriveExpectedActualHighlight(issue, primaryBounds, secondaryBounds)

  return {
    key: `visual:${issue.id}`,
    kind,
    severity: 'fail',
    axis,
    summary,
    details,
    suggestion: getVisualIssueSuggestion(kind, axis),
    scopeLabel: issue.scopeLabel || scopeLabel,
    primaryElement: issue.primaryElement || null,
    secondaryElement: issue.secondaryElement || null,
    figmaValue: issue.figmaValue,
    browserValue: issue.browserValue,
    delta: issue.delta,
    clusterBounds: cluster.normalizedBounds,
    primaryBounds,
    secondaryBounds,
    expectedBounds: highlightData.expectedBounds,
    actualBounds: highlightData.actualBounds,
    highlightMode: highlightData.highlightMode,
    highlightConfidence: highlightData.highlightConfidence,
    linkedQaIssue: issue,
    technicalHint: issue.details,
    sourceNodeIds: issue.sourceNodeIds || [],
    recommendedFix: issue.recommendedFix || null,
    labelQuality: issue.labelQuality || 'fallback',
    source: issue.kind === 'text' ? 'mapped_text' : 'visual_cluster',
    score: cluster.score,
    view: 'visual'
  }
}

function buildGenericVisualQaIssue(cluster, base, primaryRegion, secondaryRegion) {
  const axis = cluster.dominantAxis
  let kind = 'visual_style'
  let summary = `${primaryRegion?.label || 'This area'} looks visually different from Figma`
  let details = `Visual difference detected in ${base.scopeLabel}.`

  if (secondaryRegion && axis !== 'both') {
    kind = 'spacing_alignment'
    summary =
      axis === 'y'
        ? `${primaryRegion.label} does not line up vertically with ${secondaryRegion.label} in ${base.scopeLabel}`
        : `${primaryRegion.label} does not line up horizontally with ${secondaryRegion.label} in ${base.scopeLabel}`
    details =
      axis === 'y'
        ? 'Visible vertical alignment or spacing drift was detected between these regions.'
        : 'Visible horizontal alignment or spacing drift was detected between these regions.'
  } else if (primaryRegion?.isTextLike && cluster.areaRatio <= 0.08) {
    kind = 'text'
    summary = `${primaryRegion.label} text looks different from Figma`
    details = 'A visible text-region difference was detected in this area.'
  } else if (axis !== 'both') {
    kind = 'layout_shift'
    summary = `${primaryRegion?.label || 'This area'} layout looks different from Figma in ${base.scopeLabel}`
    details =
      axis === 'y'
        ? 'Visible vertical layout drift was detected in this area.'
        : 'Visible horizontal layout drift was detected in this area.'
  }

  return {
    key: `visual:${cluster.id}`,
    kind,
    severity: 'fail',
    axis,
    summary,
    details,
    suggestion: getVisualIssueSuggestion(kind, axis),
    scopeLabel: base.scopeLabel,
    primaryElement: primaryRegion?.element || base.containerElement,
    secondaryElement: secondaryRegion?.element || null,
    figmaValue: `${Math.round(cluster.areaRatio * 100)}% area`,
    browserValue: `${cluster.averageDiff} diff score`,
    delta: null,
    clusterBounds: cluster.normalizedBounds,
    primaryBounds: primaryRegion?.bounds || null,
    secondaryBounds: secondaryRegion?.bounds || null,
    expectedBounds: null,
    actualBounds: null,
    highlightMode: 'changed_area',
    highlightConfidence: 'fallback',
    labelQuality: primaryRegion?.label === 'content block' ? 'fallback' : 'medium',
    source: 'visual_cluster',
    score: cluster.score,
    view: 'visual'
  }
}

function buildRootSizeVisualIssues(base, displayValidation) {
  const issues = []
  const rootResult = displayValidation.result
  const scopeLabel = base.scopeLabel

  if (comparisonSettings.width && rootResult.comparisons?.width === false) {
    const widthDelta = getGeometryDelta(rootResult.figma.width, rootResult.browser.width)
    issues.push({
      key: 'visual:root:width',
      kind: 'size',
      severity: 'fail',
      axis: 'x',
      summary: `Selected area width should be ${formatPixelValue(
        rootResult.figma.width
      )}; browser is ${formatPixelValue(rootResult.browser.width)}`,
      details: 'This width mismatch comes from root geometry, not the normalized image overlay.',
      suggestion: getVisualIssueSuggestion('size', 'x'),
      scopeLabel,
      primaryElement: base.containerElement,
      secondaryElement: null,
      figmaValue: rootResult.figma.width,
      browserValue: rootResult.browser.width,
      delta: widthDelta,
      clusterBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      primaryBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      secondaryBounds: null,
      expectedBounds: {
        x: 0,
        y: 0,
        width: clamp(rootResult.figma.width / rootResult.browser.width, 0.01, 1),
        height: 1
      },
      actualBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      highlightMode: 'expected_actual',
      highlightConfidence: 'exact',
      source: 'root_geometry',
      recommendedFix: createRecommendedFix({
        confidence: 'high',
        kind: 'size',
        instruction: `Set the selected area width to ${formatFixValue(
          rootResult.figma.width,
          'width'
        )} instead of ${formatFixValue(rootResult.browser.width, 'width')}.`,
        expectedValue: rootResult.figma.width,
        actualValue: rootResult.browser.width,
        likelyProperty: 'width',
        likelyElementLabel: scopeLabel,
        reason: `The selected browser region width differs from the Figma root by ${getNumericDeltaLabel(widthDelta)}.`
      }),
      score: Math.abs(widthDelta),
      view: 'visual'
    })
  }

  if (comparisonSettings.height && rootResult.comparisons?.height === false) {
    const heightDelta = getGeometryDelta(rootResult.figma.height, rootResult.browser.height)
    issues.push({
      key: 'visual:root:height',
      kind: 'size',
      severity: 'fail',
      axis: 'y',
      summary: `Selected area height should be ${formatPixelValue(
        rootResult.figma.height
      )}; browser is ${formatPixelValue(rootResult.browser.height)}`,
      details: 'This height mismatch comes from root geometry, not the normalized image overlay.',
      suggestion: getVisualIssueSuggestion('size', 'y'),
      scopeLabel,
      primaryElement: base.containerElement,
      secondaryElement: null,
      figmaValue: rootResult.figma.height,
      browserValue: rootResult.browser.height,
      delta: heightDelta,
      clusterBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      primaryBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      secondaryBounds: null,
      expectedBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: clamp(rootResult.figma.height / rootResult.browser.height, 0.01, 1)
      },
      actualBounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      highlightMode: 'expected_actual',
      highlightConfidence: 'exact',
      source: 'root_geometry',
      recommendedFix: createRecommendedFix({
        confidence: 'high',
        kind: 'size',
        instruction: `Set the selected area height to ${formatFixValue(
          rootResult.figma.height,
          'height'
        )} instead of ${formatFixValue(rootResult.browser.height, 'height')}.`,
        expectedValue: rootResult.figma.height,
        actualValue: rootResult.browser.height,
        likelyProperty: 'height',
        likelyElementLabel: scopeLabel,
        reason: `The selected browser region height differs from the Figma root by ${getNumericDeltaLabel(heightDelta)}.`
      }),
      score: Math.abs(heightDelta),
      view: 'visual'
    })
  }

  return issues
}

function buildVisualQaIssuesFromBase(base, displayValidation) {
  if (base.status !== 'ready') {
    return {
      ...base,
      issues: []
    }
  }

  const failQaIssues = (displayValidation.qaIssues || []).filter(
    issue => issue.severity === 'fail'
  )
  const mappedTextIssues = failQaIssues.filter(issue => issue.kind === 'text')
  const linkedAssignments = new Map()
  const usedClusterIds = new Set()

  base.clusters.forEach(cluster => {
    let bestLinkedIssue = null
    let bestOverlap = 0

    mappedTextIssues.forEach(issue => {
      const issueBounds = getVisualIssueBounds(issue, base.containerElement)
      if (!issueBounds) return

      const overlap = getOverlapRatio(cluster.normalizedBounds, issueBounds)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestLinkedIssue = issue
      }
    })

    if (bestLinkedIssue && bestOverlap >= 0.12) {
      const existing = linkedAssignments.get(bestLinkedIssue.id)
      if (!existing || bestOverlap > existing.overlap) {
        linkedAssignments.set(bestLinkedIssue.id, {
          issue: bestLinkedIssue,
          cluster,
          overlap: bestOverlap
        })
      }
    }
  })

  const issues = buildRootSizeVisualIssues(base, displayValidation)

  linkedAssignments.forEach(({ issue, cluster }) => {
    usedClusterIds.add(cluster.id)
    issues.push(buildVisualIssueFromQaIssue(cluster, issue, base.scopeLabel))
  })

  base.clusters.forEach(cluster => {
    if (usedClusterIds.has(cluster.id)) return

    const relatedRegions = base.regions
      .map(region => ({
        ...region,
        overlap: getOverlapRatio(region.bounds, cluster.normalizedBounds)
      }))
      .filter(region => region.overlap > 0.08 || intersectRects(region.bounds, cluster.normalizedBounds))
      .sort((left, right) => right.overlap - left.overlap || left.area - right.area)

    const primaryRegion = relatedRegions[0] || {
      element: base.containerElement,
      label: base.scopeLabel,
      bounds: {
        x: 0,
        y: 0,
        width: 1,
        height: 1
      },
      isTextLike: false
    }
    const secondaryRegion = relatedRegions.find(
      region => region.element !== primaryRegion.element
    )

    issues.push(
      buildGenericVisualQaIssue(cluster, base, primaryRegion, secondaryRegion || null)
    )
  })

  const filteredIssues = issues.filter(issue => {
    if (issue.source === 'visual_cluster') return true
    if (issue.kind === 'text' || issue.kind === 'visual_style') return true
    if (issue.axis === 'x') return comparisonSettings.width
    if (issue.axis === 'y') return comparisonSettings.height
    return comparisonSettings.width || comparisonSettings.height
  })

  const dedupedIssues = Array.from(
    filteredIssues.reduce((map, issue) => {
      const existing = map.get(issue.key)
      if (!existing || (issue.score || 0) > (existing.score || 0)) {
        map.set(issue.key, issue)
      }
      return map
    }, new Map()).values()
  )

  const rankedIssues = dedupedIssues
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, VISUAL_QA_MAX_ISSUES)
  const selectedIssue =
    rankedIssues.find(issue => issue.key === activeVisualQaSelection.openIssueId) ||
    rankedIssues[0] ||
    null
  const viewMode =
    activeVisualQaSelection.viewMode === 'full' || !selectedIssue
      ? 'full'
      : 'focused'
  const selectedBounds =
    viewMode === 'focused' && selectedIssue
      ? expandNormalizedBounds(getVisualIssueFocusBounds(selectedIssue), 0.04)
      : {
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }

  return {
    ...base,
    issues: rankedIssues,
    selectedIssueId: selectedIssue?.key || null,
    stage: {
      referenceImage: base.referenceImage,
      browserImage: base.browserImage,
      selectedBounds,
      viewMode
    }
  }
}

async function getLatestVisualQa(displayValidation) {
  if (!latestValidationContext) {
    return {
      status: 'unavailable',
      reason: 'No validation context is available for Visual QA.'
    }
  }

  const figmaSnapshot = latestValidationContext.figmaSnapshot
  if (!figmaSnapshot?.referenceImage) {
    return {
      status: 'unavailable',
      reason:
        'Visual QA needs a rendered Figma reference. Re-select the root in the Figma plugin to publish a reference image.'
    }
  }

  const containerElement = latestValidationContext.containerElement
  if (!(containerElement instanceof Element)) {
    return {
      status: 'unavailable',
      reason: 'Visual QA needs a valid selected browser region.'
    }
  }

  if (!isElementFullyInViewport(containerElement)) {
    return {
      status: 'unavailable',
      reason:
        'Visual QA only captures the visible viewport. Scroll so the selected browser region is fully visible, then re-run validation.'
    }
  }

  if (!latestValidationContext.cache.visualQaBase) {
    try {
      const capturePayload =
        latestValidationContext.cache.visibleTabCapturePayload ||
        (await captureVisibleTabForContainer(containerElement))
      latestValidationContext.cache.visibleTabCapturePayload = capturePayload

      const browserCrop = await cropVisibleTabCaptureToContainer(
        capturePayload.dataUrl,
        containerElement,
        capturePayload.viewportBounds,
        capturePayload.viewportMetrics
      )

      const flattenedReferenceImage = await createCompositedImageDataUrl(
        figmaSnapshot.referenceImage,
        '#ffffff'
      )
      const referenceImage = await loadImageFromDataUrl(flattenedReferenceImage)
      const targetScale = Math.min(
        1,
        VISUAL_QA_MAX_DIMENSION /
          Math.max(referenceImage.naturalWidth, referenceImage.naturalHeight)
      )
      const targetWidth = Math.max(
        24,
        Math.round(referenceImage.naturalWidth * targetScale)
      )
      const targetHeight = Math.max(
        24,
        Math.round(referenceImage.naturalHeight * targetScale)
      )

      const [referenceImageData, browserImageData] = await Promise.all([
        createNormalizedImageData(flattenedReferenceImage, targetWidth, targetHeight),
        createNormalizedImageData(browserCrop.dataUrl, targetWidth, targetHeight)
      ])

      latestValidationContext.cache.visualQaBase = {
        status: 'ready',
        containerElement,
        scopeLabel: getVisualRegionLabel(containerElement, containerElement) || 'selected area',
        referenceImage: flattenedReferenceImage,
        browserImage: browserCrop.dataUrl,
        targetSize: {
          width: targetWidth,
          height: targetHeight
        },
        clusters: buildVisualDiffClusters(referenceImageData, browserImageData),
        regions: collectVisualQaRegions(containerElement)
      }
    } catch (error) {
      latestValidationContext.cache.visualQaBase = {
        status: 'error',
        reason:
          error instanceof Error
            ? error.message
            : 'Visual QA capture failed unexpectedly.'
      }
    }
  }

  return buildVisualQaIssuesFromBase(
    latestValidationContext.cache.visualQaBase,
    displayValidation
  )
}

function getEnhancedDevBadgeConfig(issue) {
  if (issue.kind === 'text') {
    return {
      label: 'TEXT ISSUE',
      color: '#9333ea'
    }
  }

  if (issue.kind === 'color') {
    return {
      label: 'COLOR ISSUE',
      color: '#b45309'
    }
  }

  if (issue.kind === 'shape') {
    return {
      label: 'SHAPE ISSUE',
      color: '#c026d3'
    }
  }

  if (issue.kind === 'stroke') {
    return {
      label: 'STROKE ISSUE',
      color: '#7c3aed'
    }
  }

  if (issue.kind === 'typography' || issue.kind === 'visual_style' || issue.kind === 'style') {
    return {
      label: 'STYLE ISSUE',
      color: '#db2777'
    }
  }

  if (issue.kind === 'size') {
    return {
      label: issue.severity === 'note' ? 'NOTE' : 'SIZE ISSUE',
      color: issue.severity === 'note' ? '#92400e' : '#d97706'
    }
  }

  return {
    label: issue.severity === 'note' ? 'NOTE' : 'LAYOUT ISSUE',
    color: issue.kind === 'alignment' ? '#2563eb' : '#0f766e'
  }
}

function getIssueKindLabel(kind) {
  if (kind === 'layout_shift') return 'Layout'
  if (kind === 'spacing_alignment') return 'Spacing / alignment'
  if (kind === 'visual_style') return 'Style'
  if (kind === 'typography') return 'Typography'
  if (kind === 'color') return 'Color'
  if (kind === 'shape') return 'Shape'
  if (kind === 'stroke') return 'Stroke'
  if (kind === 'style') return 'Style'
  if (kind === 'alignment') return 'Alignment'
  if (kind === 'spacing') return 'Spacing'
  if (kind === 'size') return 'Size'
  if (kind === 'text') return 'Text'
  return 'Issue'
}

function getIssueKindDescription(kind) {
  if (kind === 'layout_shift') {
    return 'Layout compares the overall visible placement of a region against the Figma reference render.'
  }

  if (kind === 'spacing_alignment') {
    return 'Spacing / alignment compares visible gaps and line-up between rendered regions.'
  }

  if (kind === 'visual_style') {
    return 'Style compares visible fills, typography, radius, and other visual appearance in this region.'
  }

  if (kind === 'typography') {
    return 'Typography compares explicit text style properties like letter spacing, font size, weight, and line height.'
  }

  if (kind === 'color') {
    return 'Color compares explicit text, background, or stroke colors against the Figma source value.'
  }

  if (kind === 'shape') {
    return 'Shape compares border radius values against the Figma corner treatment.'
  }

  if (kind === 'stroke') {
    return 'Stroke compares border width and border style against the Figma stroke treatment.'
  }

  if (kind === 'style') {
    return 'Style compares explicit non-text visual properties like stroke, radius, opacity, blend mode, and shadow.'
  }

  if (kind === 'alignment') {
    return 'Alignment compares whether two visible regions line up on the expected edge or center.'
  }

  if (kind === 'spacing') {
    return 'Spacing compares the visible distance between regions or the inset inside a parent region.'
  }

  if (kind === 'size') {
    return 'Size compares the rendered box dimensions against the Figma box.'
  }

  if (kind === 'text') {
    return 'Text compares visible rendered text content against the Figma source text.'
  }

  return 'Issue category.'
}

function isMappedTextIssue(issue) {
  return (
    issue?.kind === 'text' &&
    issue?.source === 'mapped_text' &&
    typeof issue.figmaValue === 'string' &&
    typeof issue.browserValue === 'string'
  )
}

function createInlineInfoIcon(description) {
  const info = document.createElement('span')
  info.textContent = 'i'
  info.setAttribute('aria-label', description)
  info.style.display = 'inline-flex'
  info.style.alignItems = 'center'
  info.style.justifyContent = 'center'
  info.style.width = '14px'
  info.style.height = '14px'
  info.style.borderRadius = '999px'
  info.style.border = '1px solid rgba(255,255,255,0.45)'
  info.style.fontSize = '9px'
  info.style.fontWeight = '700'
  info.style.opacity = '0.88'
  info.style.flexShrink = '0'
  attachInfoTooltip(info, description)
  return info
}

function getIssueFactItems(issue) {
  if (isMappedTextIssue(issue)) {
    return [
      { label: 'Figma source', value: issue.figmaValue || '--' },
      { label: 'Browser render', value: issue.browserValue || '--' }
    ]
  }

  if (issue.kind === 'typography') {
    return [
      {
        label: 'Expected',
        value:
          typeof issue.figmaValue === 'number'
            ? formatPixelValue(issue.figmaValue)
            : issue.figmaValue || '--'
      },
      {
        label: 'Actual',
        value:
          typeof issue.browserValue === 'number'
            ? formatPixelValue(issue.browserValue)
            : issue.browserValue || '--'
      }
    ]
  }

  if (issue.kind === 'color') {
    return [
      { label: 'Expected', value: issue.figmaValue || '--' },
      { label: 'Actual', value: issue.browserValue || '--' }
    ]
  }

  if (issue.kind === 'shape' || issue.kind === 'stroke') {
    return [
      { label: 'Expected', value: issue.figmaValue || '--' },
      { label: 'Actual', value: issue.browserValue || '--' }
    ]
  }

  if (issue.kind === 'style') {
    return [
      { label: 'Expected', value: issue.figmaValue || '--' },
      { label: 'Actual', value: issue.browserValue || '--' }
    ]
  }

  return [
    {
      label: 'Figma',
      value:
        typeof issue.figmaValue === 'number'
          ? formatPixelValue(issue.figmaValue)
          : issue.figmaValue || '--'
    },
    {
      label: 'Browser',
      value:
        typeof issue.browserValue === 'number'
          ? formatPixelValue(issue.browserValue)
          : issue.browserValue || '--'
    },
    { label: 'Delta', value: getNumericDeltaLabel(issue.delta) }
  ]
}

function hasMeaningfulNumericValues(issue) {
  if (issue.kind === 'text') return false

  if (issue.kind === 'typography') {
    return issue.figmaValue != null && issue.browserValue != null
  }

  if (issue.kind === 'color') {
    return issue.figmaValue != null && issue.browserValue != null
  }

  if (issue.kind === 'shape' || issue.kind === 'stroke') {
    return issue.figmaValue != null && issue.browserValue != null
  }

  if (issue.kind === 'style') {
    return issue.figmaValue != null && issue.browserValue != null
  }

  return (
    ['alignment', 'spacing', 'size', 'spacing_alignment'].includes(issue.kind) &&
    typeof issue.figmaValue === 'number' &&
    typeof issue.browserValue === 'number' &&
    (typeof issue.delta === 'number' || issue.kind === 'size')
  )
}

function createIssuePresentation(issue, options = {}) {
  const { view = 'visual' } = options
  const hasFix = Boolean(issue.recommendedFix?.instruction)
  const hasWhy = Boolean(issue.recommendedFix?.reason)
  const showTextDiff = isMappedTextIssue(issue)
  const showValues =
    !showTextDiff &&
    (hasMeaningfulNumericValues(issue) ||
      (view === 'visual' &&
        !hasFix &&
        ['visual_style', 'layout_shift'].includes(issue.kind) &&
        typeof issue.figmaValue === 'number' &&
        typeof issue.browserValue === 'number'))
  const showDetails =
    !showValues &&
    !showTextDiff &&
    Boolean(issue.details) &&
    issue.details !== issue.summary
  const showWhy = hasWhy && !showValues && !showTextDiff
  const showTechnicalHint =
    Boolean(issue.technicalHint) &&
    !showValues &&
    !hasFix &&
    !showTextDiff &&
    view !== 'visual'
  const showCheck =
    !hasFix &&
    Boolean(issue.suggestion) &&
    (!showValues || ['visual_style', 'layout_shift'].includes(issue.kind))
  const showVerify =
    hasFix && !showValues && !showTextDiff && Boolean(issue.suggestion)

  return {
    showValues,
    showFix: hasFix,
    showWhy,
    showTechnicalHint,
    showCheck,
    showVerify,
    showTextDiff,
    showDetails,
    primaryExplanation: showTextDiff
      ? 'text_diff'
      : showValues
        ? 'values'
        : 'changed_area'
  }
}

function createEnhancedDevFlagsSection(entry) {
  const primaryIssues = entry.devPrimaryIssues || []
  const secondaryIssues = entry.devSecondaryIssues || []
  const notes = entry.devVisualNotes || []

  if (!primaryIssues.length && !secondaryIssues.length && !notes.length) {
    return null
  }

  const wrapper = document.createElement('div')
  wrapper.style.marginTop = '10px'
  wrapper.style.display = 'grid'
  wrapper.style.gap = '8px'

  const title = document.createElement('div')
  title.style.display = 'inline-flex'
  title.style.alignItems = 'center'
  title.style.gap = '6px'
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  title.style.opacity = '0.88'
  title.appendChild(document.createTextNode('Issue flags'))
  wrapper.appendChild(title)

  function appendIssueGroup(labelText, issues, role) {
    if (!issues.length) return

    const group = document.createElement('div')
    group.style.display = 'grid'
    group.style.gap = '6px'

    const label = document.createElement('div')
    label.textContent = labelText
    label.style.fontSize = '10px'
    label.style.fontWeight = '700'
    label.style.letterSpacing = '0.08em'
    label.style.opacity = '0.66'
    group.appendChild(label)

    issues.forEach(issue => {
      const presentation = createIssuePresentation(issue, { view: 'dev' })
      const badgeConfig = getEnhancedDevBadgeConfig(issue)
      const row = document.createElement('div')
      row.style.padding = '8px 10px'
      row.style.borderRadius = '10px'
      row.style.background = 'rgba(255,255,255,0.04)'
      row.style.border = `1px solid ${badgeConfig.color}`
      row.style.display = 'grid'
      row.style.gap = '6px'
      row.style.cursor =
        issue.primaryElement || issue.secondaryElement ? 'pointer' : 'default'

      if (issue.primaryElement || issue.secondaryElement) {
        row.onmouseenter = () => focusQaIssue(issue)
        row.onmouseleave = () => resetFocusState()
      }

      const header = document.createElement('div')
      header.style.display = 'flex'
      header.style.justifyContent = 'space-between'
      header.style.alignItems = 'center'
      header.style.gap = '8px'

      const issueTitle = document.createElement('div')
      issueTitle.textContent = issue.summary
      issueTitle.style.fontSize = '11px'
      issueTitle.style.fontWeight = '700'

      const pill = document.createElement('div')
      pill.textContent = badgeConfig.label
      pill.style.padding = '2px 8px'
      pill.style.borderRadius = '999px'
      pill.style.fontSize = '10px'
      pill.style.fontWeight = '700'
      pill.style.letterSpacing = '0.08em'
      pill.style.background = badgeConfig.color
      pill.style.color = '#fff'

      header.appendChild(issueTitle)
      header.appendChild(pill)

      const meta = document.createElement('div')
      meta.style.display = 'flex'
      meta.style.alignItems = 'center'
      meta.style.gap = '6px'
      meta.style.fontSize = '11px'
      meta.style.opacity = '0.72'

      const metaText = document.createElement('span')
      metaText.textContent =
        role === 'primary'
          ? `${getIssueKindLabel(issue.kind)} • primary • ${issue.scopeLabel || 'this area'}`
          : role === 'secondary'
            ? `${getIssueKindLabel(issue.kind)} • related • ${issue.scopeLabel || 'this area'}`
            : `${getIssueKindLabel(issue.kind)} • note • ${issue.scopeLabel || 'this area'}`
      meta.appendChild(metaText)
      if (issue.kind === 'typography') {
        meta.appendChild(createInlineInfoIcon(getIssueKindDescription(issue.kind)))
      }

      const facts = presentation.showValues
        ? (() => {
            const factsNode = document.createElement('div')
            factsNode.style.display = 'grid'
            factsNode.style.gridTemplateColumns = '96px 1fr'
            factsNode.style.gap = '8px'
            factsNode.style.fontSize = '11px'

            getIssueFactItems(issue).forEach(item => {
              const factLabel = document.createElement('div')
              factLabel.textContent = item.label
              factLabel.style.opacity = '0.7'

              const factValue = document.createElement('div')
              factValue.textContent = item.value
              factValue.style.fontWeight = '700'
              factValue.style.fontSize = '12px'
              factValue.style.color =
                item.label === 'Figma' || item.label === 'Expected' || item.label === 'Figma source'
                  ? '#fde68a'
                  : item.label === 'Browser' || item.label === 'Actual' || item.label === 'Browser render'
                    ? '#bfdbfe'
                    : '#fca5a5'

              factsNode.appendChild(factLabel)
              factsNode.appendChild(factValue)
            })

            return factsNode
          })()
        : null

      const details =
        presentation.showDetails && issue.details && issue.details !== issue.summary
          ? document.createElement('div')
          : null
      if (details) {
        details.textContent = issue.details
        details.style.fontSize = '11px'
        details.style.opacity = '0.82'
      }

      const suggestion =
        presentation.showFix || presentation.showCheck || presentation.showVerify
          ? document.createElement('div')
          : null
      if (suggestion) {
        suggestion.textContent = issue.recommendedFix?.instruction || issue.suggestion
        suggestion.style.fontSize = '11px'
        suggestion.style.opacity = '0.78'
      }

      const reason = presentation.showWhy
        ? document.createElement('div')
        : null
      if (reason) {
        reason.textContent = issue.recommendedFix.reason
        reason.style.fontSize = '11px'
        reason.style.opacity = '0.72'
      }

      row.appendChild(header)
      row.appendChild(meta)
      if (presentation.showTextDiff) {
        row.appendChild(
          createTextDiffComparisonSection(
            typeof issue.figmaValue === 'string' ? issue.figmaValue : '',
            typeof issue.browserValue === 'string' ? issue.browserValue : ''
          )
        )
      }
      if (facts) {
        row.appendChild(facts)
      }
      if (presentation.showFix && suggestion) {
        const fixLabel = document.createElement('div')
        fixLabel.textContent = 'Fix'
        fixLabel.style.fontSize = '10px'
        fixLabel.style.fontWeight = '700'
        fixLabel.style.opacity = '0.72'
        row.appendChild(fixLabel)
      }
      if (presentation.showCheck && suggestion) {
        const checkLabel = document.createElement('div')
        checkLabel.textContent = 'Check'
        checkLabel.style.fontSize = '10px'
        checkLabel.style.fontWeight = '700'
        checkLabel.style.opacity = '0.72'
        row.appendChild(checkLabel)
      }
      if (presentation.showVerify && suggestion) {
        const verifyLabel = document.createElement('div')
        verifyLabel.textContent = 'Verify'
        verifyLabel.style.fontSize = '10px'
        verifyLabel.style.fontWeight = '700'
        verifyLabel.style.opacity = '0.72'
        row.appendChild(verifyLabel)
      }
      if (suggestion) {
        row.appendChild(suggestion)
      }
      if (reason) {
        const whyLabel = document.createElement('div')
        whyLabel.textContent = 'Why'
        whyLabel.style.fontSize = '10px'
        whyLabel.style.fontWeight = '700'
        whyLabel.style.opacity = '0.72'
        row.appendChild(whyLabel)
        row.appendChild(reason)
      }
      if (details) {
        row.appendChild(details)
      }
      group.appendChild(row)
    })

    wrapper.appendChild(group)
  }

  appendIssueGroup('SOURCE', primaryIssues, 'primary')
  appendIssueGroup('RELATED', secondaryIssues, 'secondary')
  appendIssueGroup('NOTES', notes, 'note')

  return wrapper
}

function createResultCard(entry, options = {}) {
  const { devMode = 'classic' } = options
  const { result, depth, label, match } = entry
  const widthDelta = getGeometryDelta(result.figma.width, result.browser.width)
  const heightDelta = getGeometryDelta(result.figma.height, result.browser.height)
  const geometryInsight = buildGeometryInsight(result, match?.element)
  const statusColor =
    result.status === 'match'
      ? 'rgba(34, 197, 94, 0.35)'
      : result.status === 'unmatched'
        ? 'rgba(245, 158, 11, 0.35)'
        : 'rgba(239, 68, 68, 0.35)'

  const card = document.createElement('section')
  card.style.border = `1px solid ${statusColor}`
  card.style.borderRadius = '10px'
  card.style.padding = '10px 12px'
  card.style.marginLeft = `${depth * 12}px`
  card.style.background =
    result.status === 'match'
      ? 'rgba(34, 197, 94, 0.08)'
      : result.status === 'unmatched'
        ? 'rgba(245, 158, 11, 0.08)'
        : 'rgba(239, 68, 68, 0.08)'
  card.style.cursor = match?.element ? 'pointer' : 'default'

  if (match?.element && result.mappingStatus !== 'unmatched') {
    card.onmouseenter = () => focusEntry(match)
    card.onmouseleave = () => resetFocusState()
  }

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  header.style.gap = '12px'
  header.style.marginBottom = '6px'

  const titleWrap = document.createElement('div')
  const title = document.createElement('div')
  title.style.display = 'flex'
  title.style.alignItems = 'center'
  title.style.gap = '8px'
  title.style.fontWeight = '700'

  if (match?.markerNumber) {
    const marker = document.createElement('span')
    marker.textContent = match.markerNumber
    marker.style.display = 'inline-flex'
    marker.style.alignItems = 'center'
    marker.style.justifyContent = 'center'
    marker.style.width = '18px'
    marker.style.height = '18px'
    marker.style.borderRadius = '999px'
    marker.style.background = '#ef4444'
    marker.style.color = '#fff'
    marker.style.fontSize = '10px'
    title.appendChild(marker)
  }

  const titleText = document.createElement('span')
  titleText.textContent = result.nodeName
  title.appendChild(titleText)

  const subtitle = document.createElement('div')
  subtitle.textContent = label
  subtitle.style.fontSize = '11px'
  subtitle.style.opacity = '0.7'

  titleWrap.appendChild(title)
  titleWrap.appendChild(subtitle)

  const pill = document.createElement('div')
  pill.textContent =
    result.status === 'match'
      ? 'MATCH'
      : result.status === 'unmatched'
        ? 'UNMATCHED'
        : 'MISMATCH'
  pill.style.padding = '2px 8px'
  pill.style.borderRadius = '999px'
  pill.style.fontSize = '10px'
  pill.style.fontWeight = '700'
  pill.style.letterSpacing = '0.08em'
  pill.style.background =
    result.status === 'match'
      ? '#166534'
      : result.status === 'unmatched'
        ? '#92400e'
        : '#991b1b'
  pill.style.color = '#fff'

  header.appendChild(titleWrap)
  header.appendChild(pill)

  const metricsHeader = document.createElement('div')
  metricsHeader.style.display = 'grid'
  metricsHeader.style.gridTemplateColumns = '56px 1fr 1fr 76px'
  metricsHeader.style.gap = '8px'
  metricsHeader.style.fontSize = '11px'
  metricsHeader.style.opacity = '0.65'
  metricsHeader.style.paddingBottom = '2px'

  ;['Metric', 'Figma', 'Browser', 'Diff'].forEach(text => {
    const col = document.createElement('div')
    col.textContent = text
    metricsHeader.appendChild(col)
  })

  const debug = document.createElement('div')
  debug.style.fontSize = '10px'
  debug.style.opacity = '0.68'
  debug.style.marginBottom = '6px'
  debug.textContent =
    result.mappingStatus === 'unmatched'
      ? `Suggested mapping: no confident DOM match • eligible ${result.debug?.eligibleCandidateCount ?? 0}${
          result.debug?.assignmentMethod ? ` • ${result.debug.assignmentMethod}` : ''
        }`
      : `Suggested mapping: ${result.matchKind || 'direct'} • ${
          result.confidenceLevel || 'low'
        } confidence${
          typeof result.confidenceScore === 'number'
            ? ` (${Math.round(result.confidenceScore * 100)}%)`
            : ''
        }${result.debug?.assignmentMethod ? ` • ${result.debug.assignmentMethod}` : ''}`

  card.appendChild(header)
  card.appendChild(debug)
  card.appendChild(metricsHeader)
  card.appendChild(
    createMetricRow(
      'Width',
      result.figma.width,
      result.browser.width,
      comparisonSettings.width,
      result.comparisons?.width,
      result.mappingStatus,
      widthDelta
    )
  )
  card.appendChild(
    createMetricRow(
      'Height',
      result.figma.height,
      result.browser.height,
      comparisonSettings.height,
      result.comparisons?.height,
      result.mappingStatus,
      heightDelta
    )
  )

  if (devMode === 'enhanced') {
    const flagsSection = createEnhancedDevFlagsSection(entry)
    if (flagsSection) {
      card.appendChild(flagsSection)
    }
  }

  if (geometryInsight) {
    card.appendChild(
      createInsightSection(
        geometryInsight.issueTitle,
        geometryInsight.issueBody,
        '#fca5a5'
      )
    )
    card.appendChild(
      createInsightSection(
        geometryInsight.suggestionTitle,
        geometryInsight.suggestionBody,
        '#93c5fd'
      )
    )
  }

  const candidateDetails = createSuggestedCandidatesDetails(result)
  if (candidateDetails) {
    card.appendChild(candidateDetails)
  }

  const textDetails = createTextDetails(result)
  if (textDetails) {
    card.appendChild(textDetails)
  }

  const styleDetails = createStyleDetails(result)
  if (styleDetails) {
    card.appendChild(styleDetails)
  }

  return card
}

function createSummaryChips(items) {
  const summary = document.createElement('div')
  summary.style.display = 'flex'
  summary.style.gap = '8px'
  summary.style.marginBottom = '10px'
  summary.style.flexWrap = 'wrap'

  items
    .filter(item => !(typeof item.value === 'number' && item.value === 0))
    .forEach(item => {
    const chip = document.createElement('div')
    chip.style.padding = '4px 8px'
    chip.style.borderRadius = '999px'
    chip.style.background = item.color
    chip.style.fontSize = '11px'
    chip.style.display = 'inline-flex'
    chip.style.alignItems = 'center'
    chip.style.gap = '6px'

    const label = document.createElement('span')
    label.textContent = `${item.label}: ${item.value}`
    chip.appendChild(label)

    if (item.description) {
      const info = document.createElement('span')
      info.textContent = 'i'
      info.setAttribute('aria-label', item.description)
      info.style.display = 'inline-flex'
      info.style.alignItems = 'center'
      info.style.justifyContent = 'center'
      info.style.width = '14px'
      info.style.height = '14px'
      info.style.borderRadius = '999px'
      info.style.border = '1px solid rgba(255,255,255,0.55)'
      info.style.fontSize = '9px'
      info.style.fontWeight = '700'
      info.style.opacity = '0.9'
      attachInfoTooltip(info, item.description)
      chip.appendChild(info)
    }

    summary.appendChild(chip)
    })

  return summary
}

function createEmptyState(message) {
  const empty = document.createElement('div')
  empty.textContent = message
  empty.style.padding = '12px'
  empty.style.borderRadius = '10px'
  empty.style.background = 'rgba(255,255,255,0.04)'
  empty.style.fontSize = '11px'
  empty.style.opacity = '0.82'
  return empty
}

function createDevNotesSection(notes) {
  if (!notes.length) return null

  const wrapper = document.createElement('details')
  wrapper.style.marginBottom = '12px'
  wrapper.style.borderTop = '1px solid rgba(255,255,255,0.08)'
  wrapper.style.paddingTop = '8px'

  const summary = document.createElement('summary')
  summary.textContent = `Visual-equivalent notes (${notes.length})`
  summary.style.cursor = 'pointer'
  summary.style.fontSize = '11px'
  summary.style.fontWeight = '700'
  summary.style.opacity = '0.88'
  wrapper.appendChild(summary)

  const body = document.createElement('div')
  body.style.display = 'grid'
  body.style.gap = '8px'
  body.style.marginTop = '8px'

  notes.forEach(note => {
    const row = document.createElement('div')
    row.style.padding = '8px 10px'
    row.style.borderRadius = '10px'
    row.style.background = 'rgba(245, 158, 11, 0.08)'
    row.style.border = '1px solid rgba(245, 158, 11, 0.25)'

    const title = document.createElement('div')
    title.textContent = note.summary
    title.style.fontSize = '11px'
    title.style.fontWeight = '700'

    const meta = document.createElement('div')
    meta.textContent = note.details
    meta.style.fontSize = '11px'
    meta.style.opacity = '0.78'
    meta.style.marginTop = '4px'

    row.appendChild(title)
    row.appendChild(meta)
    body.appendChild(row)
  })

  wrapper.appendChild(body)
  return wrapper
}

function getTopDevFocusIssue(validation) {
  const issues = (validation.qaIssues || []).filter(issue => issue.severity === 'fail')
  if (!issues.length) return null

  return [...issues].sort((left, right) => {
    const priorityDiff = (right.priority || 0) - (left.priority || 0)
    if (priorityDiff) return priorityDiff
    return Math.abs(right.delta || 0) - Math.abs(left.delta || 0)
  })[0]
}

function createDevHandoffCard(issue) {
  if (!issue) return null
  const presentation = createIssuePresentation(issue, { view: 'dev' })

  const card = document.createElement('section')
  card.style.display = 'grid'
  card.style.gap = '8px'
  card.style.padding = '12px'
  card.style.marginBottom = '12px'
  card.style.borderRadius = '12px'
  card.style.border = '1px solid rgba(59, 130, 246, 0.28)'
  card.style.background = 'rgba(59, 130, 246, 0.08)'

  const title = document.createElement('div')
  title.textContent = 'Fix handoff'
  title.style.fontSize = '12px'
  title.style.fontWeight = '700'

  const subtitle = document.createElement('div')
  subtitle.textContent = 'Start here before opening raw diagnostics.'
  subtitle.style.fontSize = '11px'
  subtitle.style.opacity = '0.72'

  card.appendChild(title)
  card.appendChild(subtitle)
  card.appendChild(createInsightSection('What looks wrong', issue.summary, '#f9a8d4'))

  if (presentation.showTextDiff) {
    card.appendChild(
      createTextDiffComparisonSection(
        typeof issue.figmaValue === 'string' ? issue.figmaValue : '',
        typeof issue.browserValue === 'string' ? issue.browserValue : ''
      )
    )
  } else if (presentation.showValues) {
    const facts = document.createElement('div')
    facts.style.display = 'grid'
    facts.style.gridTemplateColumns = '92px 1fr'
    facts.style.gap = '8px'
    facts.style.fontSize = '11px'
    facts.style.padding = '8px 0'

    getIssueFactItems(issue).forEach(item => {
      const label = document.createElement('div')
      label.textContent = item.label
      label.style.opacity = '0.65'

      const value = document.createElement('div')
      value.textContent = item.value
      value.style.fontWeight = '700'
      value.style.fontSize = '12px'
      value.style.color =
        item.label === 'Figma' || item.label === 'Expected'
          ? '#fde68a'
          : item.label === 'Browser' || item.label === 'Actual'
            ? '#bfdbfe'
            : '#fca5a5'

      facts.appendChild(label)
      facts.appendChild(value)
    })

    card.appendChild(facts)
  } else if (presentation.showDetails) {
    card.appendChild(createInsightSection('Where to look', issue.details, '#93c5fd'))
  }

  if (presentation.showFix) {
    card.appendChild(
      createInsightSection('Recommended fix', issue.recommendedFix.instruction, '#86efac')
    )
    if (presentation.showWhy && issue.recommendedFix.reason) {
      card.appendChild(
        createInsightSection('Why', issue.recommendedFix.reason, '#c4b5fd')
      )
    }
  } else if (presentation.showCheck) {
    card.appendChild(createInsightSection('Check', issue.suggestion, '#93c5fd'))
  }

  if (presentation.showTechnicalHint && (issue.delta != null || issue.technicalHint)) {
    const hintText =
      issue.technicalHint ||
      `Expected ${typeof issue.figmaValue === 'number' ? formatPixelValue(issue.figmaValue) : issue.figmaValue || '--'} • Actual ${
        typeof issue.browserValue === 'number'
          ? formatPixelValue(issue.browserValue)
          : issue.browserValue || '--'
      }${issue.delta != null ? ` • Delta ${getNumericDeltaLabel(issue.delta)}` : ''}`
    card.appendChild(createInsightSection('Technical hint', hintText, '#c4b5fd'))
  }

  return card
}

function createQaIssueCard(issue) {
  const isTextIssue = issue.kind === 'text'
  const issueTypeLabel =
    issue.kind === 'color'
      ? 'Color issue'
      : issue.kind === 'shape'
        ? 'Shape issue'
        : issue.kind === 'stroke'
          ? 'Stroke issue'
      : issue.kind === 'visual_style' || issue.kind === 'typography' || issue.kind === 'style'
      ? 'Style issue'
      : issue.kind === 'size'
        ? 'Size issue'
        : isTextIssue
          ? 'Text issue'
          : 'Layout issue'
  const statusColor =
    issue.view === 'visual'
      ? issue.severity === 'note'
        ? '#f59e0b'
        : '#ec4899'
      : issue.severity === 'note'
        ? '#f59e0b'
        : '#0ea5e9'
  const card = document.createElement('section')
  card.style.border = `1px solid ${statusColor}`
  card.style.borderRadius = '12px'
  card.style.padding = '12px'
  card.style.background =
    issue.severity === 'note'
      ? 'rgba(245, 158, 11, 0.08)'
      : issue.view === 'visual'
        ? 'rgba(236, 72, 153, 0.08)'
        : 'rgba(14, 165, 233, 0.08)'
  card.style.cursor = issue.primaryElement ? 'pointer' : 'default'
  card.style.display = 'grid'
  card.style.gap = '8px'

  if (issue.primaryElement) {
    card.onmouseenter = () =>
      issue.view === 'visual' ? focusVisualQaIssue(issue) : focusQaIssue(issue)
    card.onmouseleave = () => resetFocusState()
  }

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.gap = '10px'

  const titleWrap = document.createElement('div')
  titleWrap.style.display = 'grid'
  titleWrap.style.gap = '3px'

  const title = document.createElement('div')
  title.style.display = 'flex'
  title.style.alignItems = 'center'
  title.style.gap = '8px'
  title.style.fontWeight = '700'

  if (issue.markerNumber) {
    const marker = document.createElement('span')
    marker.textContent = issue.markerNumber
    marker.style.display = 'inline-flex'
    marker.style.alignItems = 'center'
    marker.style.justifyContent = 'center'
    marker.style.width = '18px'
    marker.style.height = '18px'
    marker.style.borderRadius = '999px'
    marker.style.background = issue.view === 'visual' ? '#ec4899' : '#0ea5e9'
    marker.style.color = '#fff'
    marker.style.fontSize = '10px'
    title.appendChild(marker)
  }

  const titleText = document.createElement('span')
  titleText.textContent = issue.summary
  title.appendChild(titleText)

  const subtitle = document.createElement('div')
  subtitle.textContent = `${issue.scopeLabel} • ${issueTypeLabel}`
  subtitle.style.fontSize = '11px'
  subtitle.style.opacity = '0.72'

  titleWrap.appendChild(title)
  titleWrap.appendChild(subtitle)

  const pill = document.createElement('div')
  pill.textContent = issue.severity === 'note' ? 'NOTE' : 'ISSUE'
  pill.style.padding = '2px 8px'
  pill.style.borderRadius = '999px'
  pill.style.fontSize = '10px'
  pill.style.fontWeight = '700'
  pill.style.letterSpacing = '0.08em'
  pill.style.color = '#fff'
  pill.style.background = statusColor

  header.appendChild(titleWrap)
  header.appendChild(pill)

  const details = document.createElement('div')
  details.textContent = issue.details
  details.style.fontSize = '11px'
  details.style.opacity = '0.86'
  const presentation = createIssuePresentation(issue, {
    view: issue.view === 'visual' ? 'visual' : 'dev'
  })

  const facts =
    presentation.showValues
      ? (() => {
          const factsNode = document.createElement('div')
          factsNode.style.display = 'grid'
          factsNode.style.gridTemplateColumns = '76px 1fr'
          factsNode.style.gap = '8px'
          factsNode.style.fontSize = '11px'
          getIssueFactItems(issue).forEach(item => {
            const label = document.createElement('div')
            label.textContent = item.label
            label.style.opacity = '0.65'
            factsNode.appendChild(label)

            const value = document.createElement('div')
            value.textContent = item.value
            value.style.fontWeight = '700'
            value.style.fontSize = '12px'
            value.style.color =
              item.label === 'Figma' || item.label === 'Expected'
                ? '#fde68a'
                : item.label === 'Browser' || item.label === 'Actual'
                  ? '#bfdbfe'
                  : '#fca5a5'
            factsNode.appendChild(value)
          })
          return factsNode
        })()
      : null

  const suggestion = createInsightSection(
    presentation.showVerify ? 'Verify' : 'Check',
    issue.suggestion,
    '#93c5fd'
  )
  suggestion.style.marginTop = '0'

  card.appendChild(header)

  if (issue.view === 'visual') {
    if (presentation.showDetails) {
      const visualRead = document.createElement('div')
      visualRead.textContent = issue.details
      visualRead.style.fontSize = '11px'
      visualRead.style.opacity = '0.86'
      card.appendChild(visualRead)
    }

    if (presentation.showTechnicalHint && issue.technicalHint) {
      const technicalHint = createInsightSection(
        'Technical hint',
        issue.technicalHint,
        '#93c5fd'
      )
      technicalHint.style.marginTop = '0'
      card.appendChild(technicalHint)
    }
  } else {
    if (presentation.showDetails && issue.details && issue.details !== issue.summary) {
      card.appendChild(details)
    }
  }

  if (presentation.showTextDiff) {
    card.appendChild(
      createTextDiffComparisonSection(
        typeof issue.figmaValue === 'string' ? issue.figmaValue : '',
        typeof issue.browserValue === 'string' ? issue.browserValue : ''
      )
    )
  }

  if (facts) {
    card.appendChild(facts)
  }
  if (presentation.showFix) {
    card.appendChild(
      createInsightSection('Recommended fix', issue.recommendedFix.instruction, '#86efac')
    )
    if (presentation.showWhy && issue.recommendedFix?.reason) {
      card.appendChild(createInsightSection('Why', issue.recommendedFix.reason, '#c4b5fd'))
    }
  } else if (presentation.showCheck || presentation.showVerify) {
    card.appendChild(suggestion)
  }

  return card
}

function getVisualQaSelectionState(visualQa, openIssueId, viewMode) {
  const issues = (visualQa?.issues || []).filter(issue => issue.severity === 'fail')
  const selectedIssue = issues.find(issue => issue.key === openIssueId) || issues[0] || null
  const nextViewMode =
    viewMode === 'full' || !selectedIssue ? 'full' : 'focused'
  const selectedBounds =
    nextViewMode === 'focused' && selectedIssue
      ? expandNormalizedBounds(getVisualIssueFocusBounds(selectedIssue), 0.04)
      : {
          x: 0,
          y: 0,
          width: 1,
          height: 1
        }

  return {
    issues,
    selectedIssue,
    viewMode: nextViewMode,
    selectedBounds
  }
}

function createVisualStageTitle(text, accentColor) {
  const title = document.createElement('div')
  title.textContent = text
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  title.style.color = accentColor
  return title
}

function createVisualStageHeader(text, accentColor, controls = null) {
  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.gap = '8px'
  header.style.flexWrap = 'wrap'
  header.appendChild(createVisualStageTitle(text, accentColor))
  if (controls) {
    header.appendChild(controls)
  }
  return header
}

function createVisualStageViewport(selectionState, targetSize) {
  const viewport = document.createElement('div')
  viewport.style.position = 'relative'
  viewport.style.overflow = 'hidden'
  viewport.style.borderRadius = '10px'
  viewport.style.border = '1px solid rgba(255,255,255,0.08)'
  viewport.style.background = 'rgba(255,255,255,0.03)'
  viewport.style.width = '100%'
  viewport.style.maxWidth = '100%'
  viewport.style.minWidth = '0'
  viewport.style.aspectRatio = `${targetSize.width} / ${targetSize.height}`

  const content = document.createElement('div')
  content.style.position = 'absolute'
  content.style.inset = '0'
  content.style.transformOrigin = 'top left'

  if (selectionState.viewMode === 'focused') {
    const focus = selectionState.selectedBounds
    const scale = Math.min(1 / focus.width, 1 / focus.height)
    content.style.width = `${scale * 100}%`
    content.style.height = `${scale * 100}%`
    content.style.left = `${-focus.x * scale * 100}%`
    content.style.top = `${-focus.y * scale * 100}%`
  } else {
    content.style.width = '100%'
    content.style.height = '100%'
    content.style.left = '0'
    content.style.top = '0'
  }

  viewport.appendChild(content)

  return {
    viewport,
    content
  }
}

function createVisualStageImage(content, imageUrl, options = {}) {
  const image = document.createElement('img')
  image.src = imageUrl
  image.alt = options.alt || ''
  image.style.position = 'absolute'
  image.style.inset = '0'
  image.style.width = '100%'
  image.style.height = '100%'
  image.style.objectFit = 'fill'
  image.style.filter = options.filter || 'none'
  image.style.opacity = options.opacity || '1'
  image.style.pointerEvents = 'none'
  content.appendChild(image)
  return image
}

function createVisualStageRect(bounds, options = {}) {
  if (!bounds) return null

  const wrapper = document.createElement('div')
  wrapper.style.position = 'absolute'
  wrapper.style.left = `${bounds.x * 100}%`
  wrapper.style.top = `${bounds.y * 100}%`
  wrapper.style.width = `${bounds.width * 100}%`
  wrapper.style.height = `${bounds.height * 100}%`
  wrapper.style.pointerEvents = 'none'

  const rect = document.createElement('div')
  rect.style.position = 'absolute'
  rect.style.inset = '0'
  rect.style.border = options.border || '2px solid rgba(236,72,153,0.95)'
  rect.style.borderRadius = options.radius || '8px'
  rect.style.background = options.background || 'transparent'
  rect.style.boxShadow = options.boxShadow || 'none'
  wrapper.appendChild(rect)

  if (options.label) {
    const badge = document.createElement('div')
    badge.textContent = options.label
    badge.style.position = 'absolute'
    badge.style.left = '6px'
    badge.style.top = '6px'
    badge.style.padding = '2px 6px'
    badge.style.borderRadius = '999px'
    badge.style.fontSize = '10px'
    badge.style.fontWeight = '700'
    badge.style.lineHeight = '1.2'
    badge.style.whiteSpace = 'nowrap'
    badge.style.background = options.labelBackground || 'rgba(15, 23, 42, 0.9)'
    badge.style.color = options.labelColor || '#fff'
    badge.style.border = options.labelBorder || '1px solid rgba(255,255,255,0.15)'
    badge.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)'
    wrapper.appendChild(badge)
  }

  return wrapper
}

function createVisualStageMask(bounds) {
  if (!bounds) return null

  const mask = document.createElement('div')
  mask.style.position = 'absolute'
  mask.style.left = `${bounds.x * 100}%`
  mask.style.top = `${bounds.y * 100}%`
  mask.style.width = `${bounds.width * 100}%`
  mask.style.height = `${bounds.height * 100}%`
  mask.style.borderRadius = '10px'
  mask.style.boxShadow = '0 0 0 9999px rgba(7, 10, 18, 0.42)'
  mask.style.border = '2px solid rgba(255,255,255,0.16)'
  mask.style.pointerEvents = 'none'
  return mask
}

function createVisualStagePane(config) {
  const {
    title,
    accentColor,
    imageUrl,
    backgroundImageUrl,
    overlayOpacity,
    targetSize,
    issues,
    selectedIssue,
    selectionState,
    kind,
    headerControls
  } = config
  const pane = document.createElement('div')
  pane.style.display = 'grid'
  pane.style.gap = '6px'
  pane.style.minWidth = '0'

  pane.appendChild(createVisualStageHeader(title, accentColor, headerControls || null))

  const { viewport, content } = createVisualStageViewport(selectionState, targetSize)
  const useExpectedActual = selectedIssue?.highlightMode === 'expected_actual'

  if (kind === 'difference') {
    viewport.style.background = '#ffffff'

    if (backgroundImageUrl) {
      createVisualStageImage(content, backgroundImageUrl, {
        alt: `${title} background`,
        opacity: '0.92'
      })
    }

    if (imageUrl) {
      createVisualStageImage(content, imageUrl, {
        alt: `${title} overlay`,
        opacity: String(overlayOpacity ?? 0.88)
      })
    }

    if (!useExpectedActual) {
      issues.forEach(issue => {
        const isSelected = selectedIssue?.key === issue.key
        const rect = createVisualStageRect(issue.clusterBounds, {
          border: isSelected
            ? '2px solid rgba(251,113,133,0.98)'
            : '1px solid rgba(251,113,133,0.45)',
          background: isSelected
            ? 'rgba(244,63,94,0.18)'
            : 'rgba(244,63,94,0.08)',
          radius: isSelected ? '8px' : '6px'
        })
        if (rect) content.appendChild(rect)
      })
    }

    if (selectedIssue?.expectedBounds) {
      const expectedRect = createVisualStageRect(selectedIssue.expectedBounds, {
        border: '2px dashed rgba(56,189,248,0.98)',
        background: 'transparent',
        radius: '8px'
      })
      if (expectedRect) content.appendChild(expectedRect)
    }

    if (selectedIssue?.actualBounds) {
      const actualRect = createVisualStageRect(selectedIssue.actualBounds, {
        border: '2px solid rgba(236,72,153,0.98)',
        background: 'transparent',
        radius: '8px'
      })
      if (actualRect) content.appendChild(actualRect)
    }

    if (!useExpectedActual && selectedIssue?.clusterBounds) {
      const clusterRect = createVisualStageRect(selectedIssue.clusterBounds, {
        border: '2px solid rgba(251,113,133,0.95)',
        background: 'rgba(244,63,94,0.06)',
        radius: '8px'
      })
      if (clusterRect) content.appendChild(clusterRect)
    }
  } else {
    createVisualStageImage(content, imageUrl, {
      alt: title
    })

    if (selectedIssue) {
      if (useExpectedActual) {
        const bounds = kind === 'reference'
          ? selectedIssue.expectedBounds
          : kind === 'browser'
            ? selectedIssue.actualBounds
            : null

        if (bounds) {
          const rect = createVisualStageRect(bounds, {
            border:
              kind === 'reference'
                ? '2px dashed rgba(56,189,248,0.98)'
                : '2px solid rgba(236,72,153,0.98)',
            background: 'transparent',
            radius: '8px'
          })
          if (rect) content.appendChild(rect)
        }
      } else {
        const clusterRect = createVisualStageRect(selectedIssue.clusterBounds, {
          border: '2px solid rgba(251,113,133,0.95)',
          background: 'rgba(244,63,94,0.12)',
          radius: '8px'
        })
        if (clusterRect) content.appendChild(clusterRect)

        const primaryRect = createVisualStageRect(selectedIssue.primaryBounds, {
          border: '2px solid rgba(56,189,248,0.98)',
          background: 'transparent',
          radius: '8px'
        })
        if (primaryRect) content.appendChild(primaryRect)

        if (selectedIssue.secondaryBounds) {
          const secondaryRect = createVisualStageRect(selectedIssue.secondaryBounds, {
            border: '2px dashed rgba(245,158,11,0.98)',
            background: 'transparent',
            radius: '8px'
          })
          if (secondaryRect) content.appendChild(secondaryRect)
        }
      }
    }
  }

  if (selectionState.viewMode === 'focused' && selectedIssue) {
    const mask = createVisualStageMask(selectionState.selectedBounds)
    if (mask) content.appendChild(mask)
  }

  pane.appendChild(viewport)
  return pane
}

function createVisualQaSelectedIssueDetails(issue) {
  const presentation = createIssuePresentation(issue, { view: 'visual' })
  const wrapper = document.createElement('section')
  wrapper.style.display = 'grid'
  wrapper.style.gap = '8px'
  wrapper.style.padding = '12px'
  wrapper.style.borderRadius = '12px'
  wrapper.style.border = '1px solid rgba(236, 72, 153, 0.28)'
  wrapper.style.background = 'rgba(236, 72, 153, 0.08)'

  const title = document.createElement('div')
  title.textContent = issue.summary
  title.style.fontSize = '12px'
  title.style.fontWeight = '700'

  const subtitle = document.createElement('div')
  subtitle.textContent = `${issue.scopeLabel} • ${getIssueKindLabel(issue.kind)}`
  subtitle.style.fontSize = '11px'
  subtitle.style.opacity = '0.72'

  const facts = document.createElement('div')
  facts.style.display = 'grid'
  facts.style.gridTemplateColumns = '108px 1fr'
  facts.style.gap = '8px'
  facts.style.fontSize = '11px'

  const factItems =
    !presentation.showValues
      ? []
      : issue.highlightMode === 'expected_actual'
      ? [
          {
            label: 'Expected',
            value:
              typeof issue.figmaValue === 'number'
                ? formatPixelValue(issue.figmaValue)
                : issue.figmaValue || '--'
          },
          {
            label: 'Actual',
            value:
              typeof issue.browserValue === 'number'
                ? formatPixelValue(issue.browserValue)
                : issue.browserValue || '--'
          },
          { label: 'Delta', value: getNumericDeltaLabel(issue.delta) }
        ]
      : [
          {
            label: 'Changed area',
            value:
              typeof issue.figmaValue === 'number'
                ? formatPixelValue(issue.figmaValue)
                : issue.figmaValue || '--'
          },
          {
            label: 'Visual severity',
            value:
              typeof issue.browserValue === 'number'
                ? formatPixelValue(issue.browserValue)
                : issue.browserValue || '--'
          }
        ]

  factItems.forEach(item => {
    const label = document.createElement('div')
    label.textContent = item.label
    label.style.opacity = '0.65'

    const value = document.createElement('div')
    value.textContent = item.value
    if (item.label !== 'Type') {
      value.style.color =
        item.label === 'Expected' || item.label === 'Changed area'
          ? '#fde68a'
          : item.label === 'Actual' || item.label === 'Visual severity'
            ? '#bfdbfe'
            : '#fca5a5'
    }

    facts.appendChild(label)
    facts.appendChild(value)
  })

  wrapper.appendChild(title)
  wrapper.appendChild(subtitle)
  if (presentation.showDetails) {
    const detailsText = document.createElement('div')
    detailsText.textContent = issue.details
    detailsText.style.fontSize = '11px'
    detailsText.style.opacity = '0.86'
    wrapper.appendChild(detailsText)
  }

  if (presentation.showTechnicalHint && issue.technicalHint) {
    wrapper.appendChild(
      createInsightSection('Technical hint', issue.technicalHint, '#93c5fd')
    )
  }

  if (presentation.showTextDiff) {
    wrapper.appendChild(
      createTextDiffComparisonSection(
        typeof issue.figmaValue === 'string' ? issue.figmaValue : '',
        typeof issue.browserValue === 'string' ? issue.browserValue : ''
      )
    )
  }

  if (factItems.length) {
    wrapper.appendChild(facts)
  }

  if (presentation.showFix && issue.recommendedFix?.instruction) {
    wrapper.appendChild(
      createInsightSection('Recommended fix', issue.recommendedFix.instruction, '#86efac')
    )
    if (presentation.showWhy && issue.recommendedFix.reason) {
      wrapper.appendChild(
        createInsightSection('Why', issue.recommendedFix.reason, '#c4b5fd')
      )
    }
  }

  if (presentation.showCheck || presentation.showVerify) {
    wrapper.appendChild(
      createInsightSection(
        presentation.showVerify ? 'Verify' : 'Check',
        issue.suggestion,
        '#93c5fd'
      )
    )
  }

  return wrapper
}

function createVisualQaStageLegend(selectedIssue = null) {
  const legend = document.createElement('div')
  legend.style.display = 'flex'
  legend.style.flexWrap = 'wrap'
  legend.style.gap = '8px'

  const legendItems =
    selectedIssue?.highlightMode === 'expected_actual'
      ? [
          {
            label: 'Expected',
            color: '#38bdf8',
            background: 'rgba(56, 189, 248, 0.12)',
            description: 'Where Figma expects the region to appear or how large it should be.'
          },
          {
            label: 'Actual',
            color: '#ec4899',
            background: 'rgba(236, 72, 153, 0.12)',
            description: 'Where the browser actually rendered the region.'
          }
        ]
      : [
          {
            label: 'Changed area',
            color: '#fb7185',
            background: 'rgba(244, 63, 94, 0.14)',
            description: 'The part of the render where Visual QA detected visible change.'
          }
        ]

  legendItems.forEach(item => {
    const chip = document.createElement('div')
    chip.style.display = 'inline-flex'
    chip.style.alignItems = 'center'
    chip.style.gap = '6px'
    chip.style.padding = '4px 8px'
    chip.style.borderRadius = '999px'
    chip.style.background = 'rgba(255,255,255,0.04)'
    chip.style.border = '1px solid rgba(255,255,255,0.08)'
    chip.style.fontSize = '10px'
    chip.style.opacity = '0.9'

    const swatch = document.createElement('span')
    swatch.style.display = 'inline-block'
    swatch.style.width = '12px'
    swatch.style.height = '12px'
    swatch.style.borderRadius = '4px'
    swatch.style.border = `2px solid ${item.color}`
    swatch.style.background = item.background

    const text = document.createElement('span')
    text.textContent = item.label

    chip.appendChild(swatch)
    chip.appendChild(text)
    attachInfoTooltip(chip, item.description)
    legend.appendChild(chip)
  })

  return legend
}

function createVisualQaAccordionItem(issue, isOpen, bodyNodes = []) {
  const item = document.createElement('section')
  item.style.border = `1px solid ${
    isOpen ? 'rgba(236,72,153,0.45)' : 'rgba(255,255,255,0.08)'
  }`
  item.style.borderRadius = '12px'
  item.style.background = isOpen
    ? 'rgba(236,72,153,0.08)'
    : 'rgba(255,255,255,0.03)'
  item.style.overflow = 'hidden'

  const headerButton = document.createElement('button')
  headerButton.type = 'button'
  headerButton.style.width = '100%'
  headerButton.style.textAlign = 'left'
  headerButton.style.border = '0'
  headerButton.style.background = 'transparent'
  headerButton.style.color = '#fff'
  headerButton.style.cursor = 'pointer'
  headerButton.style.display = 'grid'
  headerButton.style.gap = '6px'
  headerButton.style.padding = '10px 12px'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.alignItems = 'center'
  header.style.justifyContent = 'space-between'
  header.style.gap = '8px'

  const title = document.createElement('div')
  title.style.display = 'flex'
  title.style.alignItems = 'center'
  title.style.gap = '8px'
  title.style.fontSize = '11px'
  title.style.fontWeight = '700'
  title.style.minWidth = '0'

  if (issue.markerNumber) {
    const marker = document.createElement('span')
    marker.textContent = issue.markerNumber
    marker.style.display = 'inline-flex'
    marker.style.alignItems = 'center'
    marker.style.justifyContent = 'center'
    marker.style.width = '18px'
    marker.style.height = '18px'
    marker.style.borderRadius = '999px'
    marker.style.background = '#ec4899'
    marker.style.color = '#fff'
    marker.style.fontSize = '10px'
    title.appendChild(marker)
  }

  const titleText = document.createElement('span')
  titleText.textContent = issue.summary
  titleText.style.minWidth = '0'
  title.appendChild(titleText)

  const pill = document.createElement('div')
  pill.textContent = getIssueKindLabel(issue.kind)
  pill.style.padding = '2px 8px'
  pill.style.borderRadius = '999px'
  pill.style.fontSize = '10px'
  pill.style.fontWeight = '700'
  pill.style.background = 'rgba(236,72,153,0.18)'
  pill.style.color = '#fbcfe8'
  pill.style.flexShrink = '0'

  const meta = document.createElement('div')
  meta.textContent =
    typeof issue.delta === 'number'
      ? getNumericDeltaLabel(issue.delta)
      : issue.scopeLabel
  meta.style.fontSize = '11px'
  meta.style.opacity = '0.72'

  header.appendChild(title)
  header.appendChild(pill)
  headerButton.appendChild(header)
  headerButton.appendChild(meta)
  item.appendChild(headerButton)

  if (isOpen) {
    const body = document.createElement('div')
    body.style.padding = '0 12px 12px'
    bodyNodes.forEach(node => {
      if (node) body.appendChild(node)
    })
    item.appendChild(body)
  }

  return {
    item,
    headerButton
  }
}

function renderVisualQaContent(container, validation) {
  const visualQa = validation.visualQa

  if (!visualQa || visualQa.status === 'loading') {
    container.appendChild(
      createEmptyState(
        'Building visual comparison…'
      )
    )
    return
  }

  if (visualQa.status !== 'ready') {
    container.appendChild(
      createEmptyState(
        visualQa.reason ||
          'Visual QA is unavailable for this selection. Re-check the selected region or open Dev.'
      )
    )
    return
  }

  const issues = (visualQa.issues || []).filter(issue => issue.severity === 'fail')
  let lockedIssueKey =
    activeVisualQaSelection.openIssueId || visualQa.selectedIssueId || issues[0]?.key || null
  let previewIssueKey = null
  let viewMode = activeVisualQaSelection.viewMode || visualQa.stage?.viewMode || 'focused'
  let overlayOpacity =
    typeof activeVisualQaSelection.overlayOpacity === 'number'
      ? activeVisualQaSelection.overlayOpacity
      : 0.88

  if (issues.length === 0) {
    container.appendChild(
      createEmptyState(
        'No visible issues found for this selection.'
      )
    )
    return
  }

  const stageShell = document.createElement('div')
  stageShell.style.display = 'grid'
  stageShell.style.gap = '12px'
  stageShell.style.marginBottom = '12px'

  const stageHeader = document.createElement('div')
  stageHeader.style.display = 'flex'
  stageHeader.style.alignItems = isMobileViewport() ? 'flex-start' : 'center'
  stageHeader.style.justifyContent = 'space-between'
  stageHeader.style.flexDirection = isMobileViewport() ? 'column' : 'row'
  stageHeader.style.gap = '8px'

  const stageControls = document.createElement('div')
  stageControls.style.display = 'flex'
  stageControls.style.alignItems = 'center'
  stageControls.style.gap = '10px'
  stageControls.style.flexWrap = 'wrap'

  const stageToggle = document.createElement('button')
  stageToggle.type = 'button'
  stageToggle.style.border = '1px solid rgba(255,255,255,0.14)'
  stageToggle.style.borderRadius = '999px'
  stageToggle.style.padding = '4px 9px'
  stageToggle.style.cursor = 'pointer'
  stageToggle.style.color = '#fff'
  stageToggle.style.background = 'rgba(255,255,255,0.06)'
  stageToggle.style.fontSize = '11px'

  const stageHost = document.createElement('div')
  const accordionHost = document.createElement('div')
  accordionHost.style.display = 'grid'
  accordionHost.style.gap = '8px'
  const legendHost = document.createElement('div')
  const comparisonHint = document.createElement('div')
  comparisonHint.style.fontSize = '11px'
  comparisonHint.style.opacity = '0.72'
  comparisonHint.style.marginBottom = '12px'

  function createDifferenceControls() {
    const controls = document.createElement('label')
    controls.style.display = 'inline-flex'
    controls.style.alignItems = 'center'
    controls.style.gap = '6px'
    controls.style.fontSize = '11px'
    controls.style.opacity = '0.82'

    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0.15'
    range.max = '1'
    range.step = '0.05'
    range.value = String(overlayOpacity)
    range.style.accentColor = '#fb7185'
    range.style.cursor = 'pointer'
    range.oninput = event => {
      const nextValue = Number.parseFloat(event.target.value)
      overlayOpacity = clamp(nextValue, 0.15, 1)
      activeVisualQaSelection = {
        openIssueId: lockedIssueKey,
        viewMode,
        overlayOpacity
      }
      renderStage()
    }

    const value = document.createElement('span')
    value.style.minWidth = '34px'
    value.textContent = `${Math.round(overlayOpacity * 100)}%`

    controls.appendChild(range)
    controls.appendChild(value)
    return controls
  }

  function getActiveIssue() {
    const issueKey = previewIssueKey || lockedIssueKey
    return issues.find(issue => issue.key === issueKey) || issues[0] || null
  }

  function getLockedIssue() {
    return issues.find(issue => issue.key === lockedIssueKey) || issues[0] || null
  }

  function renderStage() {
    const selectionState = getVisualQaSelectionState(
      visualQa,
      getActiveIssue()?.key || null,
      previewIssueKey ? 'focused' : viewMode
    )

    stageHost.replaceChildren()

    const stageGrid = document.createElement('div')
    stageGrid.style.display = 'grid'
    stageGrid.style.gridTemplateColumns = isMobileViewport()
      ? 'minmax(0, 1fr)'
      : 'repeat(2, minmax(0, 1fr))'
    stageGrid.style.gap = '8px'

    const paneConfigs = [
      {
        title: 'Figma',
        accentColor: '#f9a8d4',
        imageUrl: visualQa.stage?.referenceImage || visualQa.referenceImage,
        kind: 'reference'
      },
      {
        title: 'Browser',
        accentColor: '#93c5fd',
        imageUrl: visualQa.stage?.browserImage || visualQa.browserImage,
        kind: 'browser'
      },
      {
        title: 'Difference',
        accentColor: '#fb7185',
        backgroundImageUrl: visualQa.stage?.browserImage || visualQa.browserImage,
        imageUrl: visualQa.stage?.referenceImage || visualQa.referenceImage,
        overlayOpacity,
        kind: 'difference',
        fullWidth: true,
        headerControls: createDifferenceControls()
      }
    ]

    paneConfigs.forEach(config => {
      const pane = createVisualStagePane({
        ...config,
        targetSize: visualQa.targetSize,
        issues,
        selectedIssue: selectionState.selectedIssue,
        selectionState
      })

      if (config.fullWidth) {
        pane.style.gridColumn = '1 / -1'
      }

      stageGrid.appendChild(
        pane
      )
    })

    stageHost.appendChild(stageGrid)
    legendHost.replaceChildren(createVisualQaStageLegend(selectionState.selectedIssue))

    stageToggle.textContent =
      viewMode === 'full' ? 'Zoom to selected issue' : 'Show full selection'
  }

  function renderAccordion() {
    accordionHost.replaceChildren()

    issues.forEach(issue => {
      const bodyNodes =
        issue.key === lockedIssueKey
          ? [stageShell, createVisualQaSelectedIssueDetails(issue)]
          : []
      const { item, headerButton } = createVisualQaAccordionItem(
        issue,
        issue.key === lockedIssueKey,
        bodyNodes
      )

      headerButton.onmouseenter = () => {
        previewIssueKey = issue.key
        focusVisualQaIssue(issue)
        renderStage()
      }
      headerButton.onmouseleave = () => {
        previewIssueKey = null
        resetFocusState()
        renderStage()
      }
      headerButton.onclick = () => {
        if (lockedIssueKey === issue.key) return
        lockedIssueKey = issue.key
        viewMode = 'focused'
        activeVisualQaSelection = {
          openIssueId: issue.key,
          viewMode,
          overlayOpacity
        }
        renderAccordion()
        renderStage()
      }

      accordionHost.appendChild(item)
    })
  }

  stageToggle.onclick = () => {
    viewMode = viewMode === 'full' ? 'focused' : 'full'
    activeVisualQaSelection = {
      openIssueId: lockedIssueKey,
      viewMode,
      overlayOpacity
    }
    previewIssueKey = null
    resetFocusState()
    renderStage()
  }

  stageControls.appendChild(stageToggle)
  stageHeader.appendChild(stageControls)
  comparisonHint.textContent = `Comparing by: ${getActiveMetrics().join(' + ')}`
  container.appendChild(comparisonHint)
  stageShell.appendChild(stageHeader)
  stageShell.appendChild(legendHost)
  stageShell.appendChild(stageHost)
  container.appendChild(accordionHost)

  renderStage()
  renderAccordion()
}

function renderQaContent(container, validation) {
  const qaIssues = (validation.qaIssues || []).filter(issue => issue.severity === 'fail')
  const layoutIssues = qaIssues.filter(issue => issue.kind !== 'text')
  const textIssues = qaIssues.filter(issue => issue.kind === 'text')
  const markerCount = qaIssues.filter(issue => issue.markerNumber).length
  const rawUnmatchedCount = (validation.entries || []).filter(
    entry => entry.result.mappingStatus === 'unmatched'
  ).length

    container.appendChild(
      createSummaryChips([
        { label: 'Issues', value: qaIssues.length, color: '#1d4ed8', description: 'Total QA-visible issues for the current metric filters.' },
        { label: 'Layout', value: layoutIssues.length, color: '#2563eb', description: 'Layout issues cover visible spacing, alignment, or size drift.' },
        { label: 'Text', value: textIssues.length, color: '#9333ea', description: 'Text issues cover visible text content mismatches.' },
        { label: 'Markers', value: markerCount, color: '#be123c', description: 'Number of on-page issue markers currently shown.' }
      ])
    )

  const hint = document.createElement('div')
  hint.textContent = `QA mode groups visible symptoms instead of raw tree nodes • Comparing by: ${getActiveMetrics().join(
    ' + '
  )}`
  hint.style.fontSize = '11px'
  hint.style.opacity = '0.72'
  hint.style.marginBottom = '12px'
  container.appendChild(hint)

  const sectionTitle = document.createElement('div')
  sectionTitle.textContent = 'Visual issues'
  sectionTitle.style.fontSize = '12px'
  sectionTitle.style.fontWeight = '700'
  sectionTitle.style.marginBottom = '10px'
  container.appendChild(sectionTitle)

  if (qaIssues.length === 0) {
    container.appendChild(
      createEmptyState(
        rawUnmatchedCount > 0
          ? 'No QA-visible issues found under the current tree-aware validation mode. Remaining raw unmatched nodes are hidden in QA and available in Dev.'
          : validation.devVisualNotes.length
            ? 'No QA-facing visual issues found. Remaining differences are hidden as developer notes because the rendered layout still looks equivalent.'
            : 'No QA-facing visual issues found for the current metric filters.'
      )
    )
    return
  }

  const cards = document.createElement('div')
  cards.style.display = 'grid'
  cards.style.gap = '10px'

  qaIssues.forEach(issue => {
    cards.appendChild(createQaIssueCard(issue))
  })

  container.appendChild(cards)
}

function renderDevContent(container, validation) {
  const rows = validation.entries || buildValidationEntries(validation)
  const unmatched = rows.filter(entry => entry.result.status === 'unmatched').length
  const failIssues = (validation.qaIssues || []).filter(issue => issue.severity === 'fail')
  const spacingIssues = failIssues.filter(issue => issue.kind === 'spacing').length
  const alignmentIssues = failIssues.filter(issue => issue.kind === 'alignment').length
  const sizeIssues = failIssues.filter(issue => issue.kind === 'size').length
  const textIssues = failIssues.filter(issue => issue.kind === 'text').length
  const styleIssues = failIssues.filter(
    issue => issue.kind === 'typography' || issue.kind === 'visual_style'
  ).length
  const relationIssues = failIssues.filter(
    issue => !['text', 'typography', 'visual_style'].includes(issue.kind)
  ).length
  const markerCount = rows.filter(
    entry => entry.devPrimaryIssues?.length && entry.devPrimaryIssues[0]?.markerNumber
  ).length
  const topIssue = getTopDevFocusIssue(validation)

  const metricControls = createMetricToggleControls()
  metricControls.style.marginBottom = '12px'
  container.appendChild(metricControls)

  container.appendChild(
    createSummaryChips([
      { label: 'Layout Issues', value: relationIssues, color: '#1d4ed8', description: 'Visible spacing or alignment issues found by the shared symptom engine.' },
      { label: 'Spacing', value: spacingIssues, color: '#0f766e', description: 'Spacing compares visible gaps or insets between regions.' },
      { label: 'Alignment', value: alignmentIssues, color: '#7c3aed', description: 'Alignment compares whether regions line up on the expected edge or center.' },
      { label: 'Size', value: sizeIssues, color: '#d97706', description: 'Size issues compare box dimensions that are still visually meaningful.' },
      { label: 'Text', value: textIssues, color: '#db2777', description: 'Text issues compare rendered text content against Figma.' },
      { label: 'Style', value: styleIssues, color: '#be185d', description: 'Style issues compare explicit typography or other visual property values against Figma.' },
      { label: 'Unmatched', value: unmatched, color: '#92400e', description: 'Raw Figma nodes without a confident DOM mapping. These remain diagnostic only in Dev.' },
      { label: 'Markers', value: markerCount, color: '#be123c', description: 'Number of primary issue markers shown on the page in Dev.' }
    ])
  )

  const hint = document.createElement('div')
  hint.textContent = `Use Dev for implementation detail • Mapping: ${validation.strategy} • Comparing by: ${getActiveMetrics().join(
    ' + '
  )}`
  hint.style.fontSize = '11px'
  hint.style.opacity = '0.72'
  hint.style.marginBottom = '12px'
  container.appendChild(hint)

  const handoffCard = createDevHandoffCard(topIssue)
  if (handoffCard) {
    container.appendChild(handoffCard)
  }

  const relevantRows = rows
    .filter(
      entry =>
        entry.devPrimaryIssues?.length ||
        entry.devSecondaryIssues?.length ||
        entry.result.status === 'unmatched' ||
        entry.result.status === 'mismatch'
    )
    .sort((left, right) => {
      const leftRank = left.devPrimaryIssues?.length
        ? 0
        : left.devSecondaryIssues?.length
          ? 1
          : left.result.status === 'mismatch'
            ? 2
            : 3
      const rightRank = right.devPrimaryIssues?.length
        ? 0
        : right.devSecondaryIssues?.length
          ? 1
          : right.result.status === 'mismatch'
            ? 2
            : 3
      return leftRank - rightRank || left.depth - right.depth
    })

  if (relevantRows.length) {
    container.appendChild(createCompactSectionTitle('Relevant nodes'))

    const cards = document.createElement('div')
    cards.style.display = 'grid'
    cards.style.gap = '10px'

    relevantRows.forEach(entry => {
      cards.appendChild(createResultCard(entry, { devMode: 'enhanced' }))
    })

    container.appendChild(cards)
  } else {
    container.appendChild(
      createEmptyState(
        'Dev did not find any mapped nodes that need technical follow-up for the current filters.'
      )
    )
  }

  const advanced = document.createElement('details')
  advanced.style.marginTop = '12px'
  advanced.style.borderTop = '1px solid rgba(255,255,255,0.08)'
  advanced.style.paddingTop = '8px'

  const advancedSummary = document.createElement('summary')
  advancedSummary.textContent = 'Advanced raw tree diagnostics'
  advancedSummary.style.cursor = 'pointer'
  advancedSummary.style.fontSize = '11px'
  advancedSummary.style.fontWeight = '700'
  advancedSummary.style.opacity = '0.88'
  advanced.appendChild(advancedSummary)

  const advancedBody = document.createElement('div')
  advancedBody.style.display = 'grid'
  advancedBody.style.gap = '12px'
  advancedBody.style.marginTop = '10px'

  advancedBody.appendChild(createMetricToggleControls())

  const matches = rows.filter(entry => entry.result.status === 'match').length
  const mismatches = rows.filter(entry => entry.result.status === 'mismatch').length
  const tagged = rows.filter(entry => entry.match?.markerNumber).length

  advancedBody.appendChild(
    createSummaryChips([
      { label: 'Matches', value: matches, color: '#166534', description: 'Raw node mappings whose active box dimensions currently match.' },
      { label: 'Mismatches', value: mismatches, color: '#991b1b', description: 'Raw node mappings whose active box dimensions currently differ.' },
      { label: 'Unmatched', value: unmatched, color: '#92400e', description: 'Figma nodes without a confident DOM mapping.' },
      { label: 'Visual-equivalent notes', value: validation.devVisualNotes.length, color: '#b45309', description: 'Technical differences that are hidden from QA because the final layout still looks equivalent.' },
      { label: 'Markers', value: tagged, color: '#be123c', description: 'Number of raw mismatch markers shown on the page.' }
    ])
  )

  const rawHint = document.createElement('div')
  rawHint.textContent = `Raw Tree shows the underlying mapped structure for deeper debugging • Mapping: ${validation.strategy} • Comparing by: ${getActiveMetrics().join(
    ' + '
  )}`
  rawHint.style.fontSize = '11px'
  rawHint.style.opacity = '0.72'
  advancedBody.appendChild(rawHint)

  const notesSection = createDevNotesSection(validation.devVisualNotes)
  if (notesSection) {
    advancedBody.appendChild(notesSection)
  }

  const rawCards = document.createElement('div')
  rawCards.style.display = 'grid'
  rawCards.style.gap = '10px'
  rows.forEach(entry => {
    rawCards.appendChild(createResultCard(entry, { devMode: 'classic' }))
  })
  advancedBody.appendChild(rawCards)
  advanced.appendChild(advancedBody)
  container.appendChild(advanced)
}

function renderOverlayContent(container, validation) {
  const result = validation.result

  if (result.error) {
    const error = document.createElement('div')
    error.textContent = result.error
    error.style.color = '#fca5a5'
    error.style.fontWeight = '600'

    const help = document.createElement('div')
    help.textContent = result.help || ''
    help.style.marginTop = '6px'
    help.style.opacity = '0.8'

    container.appendChild(error)
    if (result.help) container.appendChild(help)
    return
  }

  const controls = document.createElement('div')
  controls.style.display = 'grid'
  controls.style.gap = '10px'
  controls.style.marginBottom = '12px'

  const tabControls = document.createElement('div')
  tabControls.style.display = 'flex'
  tabControls.style.gap = '8px'
  tabControls.style.flexWrap = 'wrap'

  ;[
    { key: 'visual', label: 'Visual QA' },
    { key: 'dev', label: 'Dev' }
  ].forEach(option => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = option.label
    button.style.border = '1px solid rgba(255,255,255,0.14)'
    button.style.borderRadius = '999px'
    button.style.padding = '5px 10px'
    button.style.cursor = 'pointer'
    button.style.color = '#fff'
    button.style.background =
      activePanelView === option.key
        ? option.key === 'visual'
          ? 'rgba(236, 72, 153, 0.35)'
          : 'rgba(34, 197, 94, 0.35)'
        : 'rgba(255,255,255,0.06)'

    button.onclick = () => {
      if (activePanelView === option.key) return
      activePanelView = option.key
      renderValidationUI()
    }

    tabControls.appendChild(button)
  })

  controls.appendChild(tabControls)
  container.appendChild(controls)

  if (activePanelView === 'visual') {
    renderVisualQaContent(container, validation)
    return
  }

  renderDevContent(container, validation)
}

function renderOverlay(validation) {
  const existing = document.getElementById('figma-validator-overlay')
  if (existing) existing.remove()

  const isVisualPanel = activePanelView === 'visual'
  const mobileSheet = isMobileViewport()
  const container = document.createElement('div')
  container.id = 'figma-validator-overlay'
  container.style.position = 'fixed'
  container.style.top = mobileSheet ? 'auto' : '16px'
  container.style.right = mobileSheet ? '0' : '16px'
  container.style.left = mobileSheet ? '0' : 'auto'
  container.style.bottom = mobileSheet ? '0' : 'auto'
  container.style.zIndex = '999999'
  container.style.width = mobileSheet
    ? '100vw'
    : isVisualPanel
      ? 'min(1040px, calc(100vw - 32px))'
      : '460px'
  container.style.maxWidth = mobileSheet ? '100vw' : 'calc(100vw - 32px)'
  container.style.maxHeight = mobileSheet ? '78vh' : isVisualPanel ? '82vh' : '75vh'
  container.style.overflow = 'auto'
  container.style.padding = mobileSheet ? '14px 14px 20px' : '14px'
  container.style.borderRadius = mobileSheet ? '18px 18px 0 0' : '14px'
  container.style.background = 'rgba(7, 10, 18, 0.92)'
  container.style.color = '#fff'
  container.style.font = '12px/1.5 monospace'
  container.style.boxShadow = '0 16px 40px rgba(0, 0, 0, 0.4)'
  container.style.backdropFilter = 'blur(10px)'
  container.style.overscrollBehavior = 'contain'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = mobileSheet ? 'flex-start' : 'center'
  header.style.flexDirection = mobileSheet ? 'column' : 'row'
  header.style.gap = mobileSheet ? '8px' : '0'
  header.style.marginBottom = '12px'

  const titleWrap = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = 'Figma Layout Validator'

  const subtitle = document.createElement('div')
  subtitle.textContent = 'Review visible issues first. Use Dev for implementation detail.'
  subtitle.style.fontSize = '11px'
  subtitle.style.opacity = '0.7'

  titleWrap.appendChild(title)
  titleWrap.appendChild(subtitle)

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  close.style.border = '0'
  close.style.borderRadius = '8px'
  close.style.padding = '5px 10px'
  close.style.cursor = 'pointer'
  close.onclick = () => {
    cleanupAnnotations()
    disablePickerMode()
    container.remove()
  }

  const body = document.createElement('div')

  header.appendChild(titleWrap)
  header.appendChild(close)
  container.appendChild(header)
  container.appendChild(body)
  renderOverlayContent(body, validation)

  document.body.appendChild(container)
  ensurePickerLauncher()
}

function renderMissingSnapshotOverlay() {
  cleanupAnnotations()
  renderOverlay({
    result: {
      error: 'No Figma layout snapshot found',
      help:
        'Select a container in Figma first, then use Pick Area and tap or click the matching browser region.'
    },
    matches: []
  })
}

function getLatestValidation() {
  if (!latestValidationContext) return null

  if (latestValidationContext.cache.validation) {
    return latestValidationContext.cache.validation
  }

  const validation = window.FigmaGeometryValidator.validateContainerLayout(
    latestValidationContext.figmaSnapshot,
    latestValidationContext.containerElement,
    {
      tolerance: latestValidationContext.tolerance
    }
  )

  latestValidationContext.cache.validation = validation
  return validation
}

async function renderValidationUI() {
  if (!latestValidationContext) return
  const currentRenderToken = ++latestRenderToken

  try {
    latestRawValidation = getLatestValidation()
    if (!latestRawValidation) return

    // The raw validation keeps mapping decisions stable while the overlay derives
    // QA issues and Dev status from the currently selected metric filters.
    const displayValidation = buildDisplayValidation(latestRawValidation)

    if (activePanelView === 'visual') {
      cleanupAnnotations()
      renderOverlay({
        ...displayValidation,
        visualQa: {
          status: 'loading'
        }
      })

      const visualQa = await getLatestVisualQa(displayValidation)
      if (currentRenderToken !== latestRenderToken) return

      displayValidation.visualQa = visualQa
      highlightVisualQaIssues(displayValidation)
      renderOverlay(displayValidation)
      return
    }

    if (currentRenderToken !== latestRenderToken) return

    if (activeDevPanelMode === 'enhanced') {
      highlightEnhancedDevIssues(displayValidation)
    } else {
      highlightValidationEntries(displayValidation)
    }

    renderOverlay(displayValidation)
  } catch (error) {
    latestRawValidation = null
    cleanupAnnotations()
    renderOverlay({
      result: {
        error: error instanceof Error ? error.message : 'Layout validation failed'
      },
      matches: []
    })
  }
}

document.addEventListener(
  'pointerdown',
  event => {
    const resolvedTarget = resolvePickerTarget(event.target)
    if ((!pickerModeActive && !event.shiftKey) || !resolvedTarget) {
      return
    }

    clearBrowserSelection()
    event.preventDefault()
  },
  true
)

document.addEventListener(
  'mousemove',
  event => {
    if (!pickerModeActive) return
    applyPickerHover(resolvePickerTarget(event.target))
  },
  true
)

document.addEventListener(
  'click',
  async event => {
    const overlay = document.getElementById('figma-validator-overlay')
    const resolvedTarget = resolvePickerTarget(event.target)

    if (pickerModeActive) {
      if (!resolvedTarget) return

      event.preventDefault()
      event.stopPropagation()

      try {
        await selectValidationTarget(resolvedTarget)
      } catch (error) {
        latestRawValidation = null
        latestValidationContext = null
        disablePickerMode()
        cleanupAnnotations()
        renderOverlay({
          result: {
            error: error instanceof Error ? error.message : 'Layout validation failed'
          },
          matches: []
        })
      }
      return
    }

    if (!event.shiftKey || overlay?.contains(event.target) || !resolvedTarget) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    try {
      await selectValidationTarget(resolvedTarget)
    } catch (error) {
      latestRawValidation = null
      latestValidationContext = null
      cleanupAnnotations()
      renderOverlay({
        result: {
          error: error instanceof Error ? error.message : 'Layout validation failed'
        },
        matches: []
      })
    }
  },
  true
)

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pickerModeActive) {
    disablePickerMode()
  }
})

window.addEventListener('resize', () => {
  ensurePickerLauncher()
  if (latestValidationContext && document.getElementById('figma-validator-overlay')) {
    renderValidationUI()
  }
})

ensurePickerLauncher()

window.addEventListener('message', event => {
  if (event.data?.source === 'figma-validator') {
    const payload = cloneSnapshot(event.data.payload)
    chrome.storage.local.set({
      figmaSnapshot: payload
    })
  }
})

window.addEventListener('scroll', scheduleAnnotationPositionUpdate, true)
window.addEventListener('resize', scheduleAnnotationPositionUpdate)
