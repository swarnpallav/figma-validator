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
let activeFocusEntry = null
let annotationFrameId = null
let latestRawValidation = null
const comparisonSettings = {
  width: true,
  height: true
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
  elementBadges.forEach(({ marker }) => marker.remove())
  elementBadges = []

  if (activeFocusBadge) {
    activeFocusBadge.remove()
    activeFocusBadge = null
  }

  activeFocusEntry = null
}

function cleanupAnnotations() {
  clearHighlights()
  clearBadges()
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

function placeFocusBadge(entry, badge) {
  const rect = entry.element.getBoundingClientRect()
  badge.style.position = 'fixed'
  badge.style.left = `${Math.min(Math.max(rect.left, 8), window.innerWidth - 320)}px`
  badge.style.top = `${Math.max(rect.top - 32, 8)}px`
}

function showFocusBadge(entry) {
  if (activeFocusBadge) {
    activeFocusBadge.remove()
    activeFocusBadge = null
  }

  if (!entry?.element) return

  const badge = document.createElement('div')
  const prefix = entry.markerNumber ? `${entry.markerNumber}. ` : ''
  badge.textContent = `${prefix}${getDisplayLabel(entry)} • ${entry.nodeName} • ${entry.status}`
  badge.style.zIndex = '999998'
  badge.style.maxWidth = '320px'
  badge.style.padding = '6px 10px'
  badge.style.borderRadius = '999px'
  badge.style.background = 'rgba(15, 23, 42, 0.96)'
  badge.style.border = `1px solid ${getStatusColor(entry.status)}`
  badge.style.color = '#fff'
  badge.style.font = '11px/1.4 monospace'
  badge.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.35)'
  badge.style.pointerEvents = 'none'
  placeFocusBadge(entry, badge)

  document.body.appendChild(badge)
  activeFocusBadge = badge
  activeFocusEntry = entry
}

function clearFocusBadge() {
  if (activeFocusBadge) {
    activeFocusBadge.remove()
    activeFocusBadge = null
  }
}

function resetFocusState() {
  highlightedElements.forEach(({ element, boxShadow }) => {
    if (!element || !element.style) return
    element.style.boxShadow = boxShadow
  })

  clearFocusBadge()
}

function focusEntry(entry) {
  if (!entry?.element) return

  resetFocusState()
  showFocusBadge(entry)
  entry.element.style.boxShadow = `0 0 0 4px ${
    entry.status === 'match'
      ? 'rgba(34, 197, 94, 0.15)'
      : entry.status === 'unmatched'
        ? 'rgba(245, 158, 11, 0.18)'
        : 'rgba(239, 68, 68, 0.18)'
  }`
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

function updateAnnotationPositions() {
  elementBadges.forEach(({ element, marker }) => {
    if (!element || !marker) return
    placeMarker(element, marker)
  })

  if (activeFocusBadge && activeFocusEntry?.element) {
    placeFocusBadge(activeFocusEntry, activeFocusBadge)
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
  return String(value)
}

function createStyleDetails(result) {
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
      row.style.gridTemplateColumns =
        result.mappingStatus === 'matched' ? '88px 1fr 1fr 42px' : '88px 1fr'
      row.style.gap = '8px'
      row.style.fontSize = '11px'
      row.style.opacity = '0.86'

      const property = document.createElement('div')
      property.textContent = propertyKey
      property.style.opacity = '0.7'
      row.appendChild(property)

      const figma = document.createElement('div')
      figma.textContent = formatStyleValue(figmaValue)
      figma.style.color = '#fde68a'
      row.appendChild(figma)

      if (result.mappingStatus === 'matched') {
        const browserValue = source.browser?.[groupKey]?.[propertyKey]
        const diff = source.diffs?.[groupKey]?.[propertyKey]

        const browser = document.createElement('div')
        browser.textContent = formatStyleValue(browserValue)
        browser.style.color = '#bfdbfe'
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

function buildValidationEntries(validation) {
  const rows = []
  let index = 0

  function walk(result, depth, label) {
    const match = validation.matches[index] || null
    rows.push({
      id: index,
      result,
      depth,
      label,
      match
    })
    index += 1

    ;(result.children || []).forEach(child => {
      walk(child, depth + 1, `Nested child • level ${depth + 1}`)
    })
  }

  walk(validation.result, 0, 'Selected container')
  return rows
}

function createResultCard(entry) {
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
      ? `No eligible DOM match. Eligible candidates: ${result.debug?.eligibleCandidateCount ?? 0}`
      : `Mapping: matched${result.debug?.parentReuse ? ' via parent reuse' : ''}`

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

  if (result.status !== 'match') {
    card.appendChild(createStyleDetails(result))
  }

  return card
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
  controls.style.display = 'flex'
  controls.style.gap = '8px'
  controls.style.marginBottom = '12px'
  controls.style.flexWrap = 'wrap'

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

    controls.appendChild(button)
  })

  const rows = buildValidationEntries(validation)
  const summary = document.createElement('div')
  summary.style.display = 'flex'
  summary.style.gap = '8px'
  summary.style.marginBottom = '10px'
  summary.style.flexWrap = 'wrap'

  const matches = rows.filter(entry => entry.result.status === 'match').length
  const mismatches = rows.filter(entry => entry.result.status === 'mismatch').length
  const unmatched = rows.filter(entry => entry.result.status === 'unmatched').length
  const tagged = rows.filter(entry => entry.match?.markerNumber).length

  ;[
    { label: 'Matches', value: matches, color: '#166534' },
    { label: 'Mismatches', value: mismatches, color: '#991b1b' },
    { label: 'Unmatched', value: unmatched, color: '#92400e' },
    { label: 'Markers', value: tagged, color: '#7f1d1d' }
  ].forEach(item => {
    const chip = document.createElement('div')
    chip.textContent = `${item.label}: ${item.value}`
    chip.style.padding = '4px 8px'
    chip.style.borderRadius = '999px'
    chip.style.background = item.color
    chip.style.fontSize = '11px'
    summary.appendChild(chip)
  })

  const hint = document.createElement('div')
  hint.textContent = `Comparing by: ${getActiveMetrics().join(' + ')}`
  hint.style.fontSize = '11px'
  hint.style.opacity = '0.72'
  hint.style.marginBottom = '12px'

  const cards = document.createElement('div')
  cards.style.display = 'grid'
  cards.style.gap = '10px'

  rows.forEach(entry => {
    cards.appendChild(createResultCard(entry))
  })

  container.appendChild(controls)
  container.appendChild(summary)
  container.appendChild(hint)
  container.appendChild(cards)
}

function renderOverlay(validation) {
  const existing = document.getElementById('figma-validator-overlay')
  if (existing) existing.remove()

  const container = document.createElement('div')
  container.id = 'figma-validator-overlay'
  container.style.position = 'fixed'
  container.style.top = '16px'
  container.style.right = '16px'
  container.style.zIndex = '999999'
  container.style.width = '460px'
  container.style.maxHeight = '75vh'
  container.style.overflow = 'auto'
  container.style.padding = '14px'
  container.style.borderRadius = '14px'
  container.style.background = 'rgba(7, 10, 18, 0.92)'
  container.style.color = '#fff'
  container.style.font = '12px/1.5 monospace'
  container.style.boxShadow = '0 16px 40px rgba(0, 0, 0, 0.4)'
  container.style.backdropFilter = 'blur(10px)'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  header.style.marginBottom = '12px'

  const titleWrap = document.createElement('div')
  const title = document.createElement('strong')
  title.textContent = 'Figma Layout Validator'

  const subtitle = document.createElement('div')
  subtitle.textContent = 'Visual geometry comparison with style diagnostics'
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
    container.remove()
  }

  const body = document.createElement('div')

  header.appendChild(titleWrap)
  header.appendChild(close)
  container.appendChild(header)
  container.appendChild(body)
  renderOverlayContent(body, validation)

  document.body.appendChild(container)
}

function renderMissingSnapshotOverlay() {
  cleanupAnnotations()
  renderOverlay({
    result: {
      error: 'No Figma layout snapshot found',
      help:
        'Select a container in Figma first, then Shift+Click the matching container in the browser.'
    },
    matches: []
  })
}

function renderValidationUI() {
  if (!latestRawValidation) return

  // The raw validation keeps mapping decisions stable while the overlay derives
  // match/mismatch state from the currently selected metric filters.
  const derivedValidation = buildDerivedValidation(latestRawValidation)
  highlightValidationEntries(derivedValidation)
  renderOverlay(derivedValidation)
}

document.addEventListener('click', async event => {
  const overlay = document.getElementById('figma-validator-overlay')
  if (!event.shiftKey || overlay?.contains(event.target)) {
    return
  }

  const figmaSnapshot = await getFigmaSnapshot()

  if (!figmaSnapshot) {
    renderMissingSnapshotOverlay()
    return
  }

  try {
    latestRawValidation = window.FigmaGeometryValidator.validateContainerLayout(
      figmaSnapshot,
      event.target,
      { tolerance: 2 }
    )

    renderValidationUI()
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
})

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
