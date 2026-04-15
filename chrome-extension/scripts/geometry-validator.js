;(function () {
  const DEFAULT_TOLERANCE = 2
  // The suggested matcher is now the canonical mapping strategy.
  // Pipeline:
  // 1. collect visible DOM candidates
  // 2. normalize away redundant wrappers
  // 3. project Figma children into browser space using root scaling
  // 4. filter implausible candidates
  // 5. score the remaining candidates with geometry + semantic hints
  // 6. assign siblings as a group so one early wrong choice does not cascade
  // 7. return confidence, ambiguity hints, and post-match diagnostics
  const SUGGESTED_MATCHER_CONFIG = {
    widthDeltaRatio: 0.55,
    heightDeltaRatio: 0.55,
    centerOffsetRatioX: 0.6,
    centerOffsetRatioY: 0.6,
    minOverlapRatio: 0.005,
    minAbsoluteDelta: 8,
    minCenterOffset: 10,
    maxAcceptedScore: 1.15,
    unmatchedScore: 0.98,
    highConfidenceThreshold: 0.8,
    mediumConfidenceThreshold: 0.6,
    optionLimit: 4,
    topCandidateLimit: 3,
    exactAssignmentMaxChildren: 12,
    exactAssignmentMaxEdges: 40,
    repeatedSharedParentBonus: 0.07,
    repeatedForeignParentPenalty: 0.08,
    repeatedOrderPenalty: 0.08,
    repeatedAmbiguityScoreGap: 0.1,
    repeatedConfidencePenalty: 0.16
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max)
  }

  function normalizeBounds(bounds) {
    if (!bounds) return null

    const x = Number(bounds.x)
    const y = Number(bounds.y)
    const width = Number(bounds.width)
    const height = Number(bounds.height)

    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      !isFiniteNumber(width) ||
      !isFiniteNumber(height)
    ) {
      return null
    }

    return { x, y, width, height }
  }

  function normalizeCssNumber(value) {
    const parsed = parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  function normalizeCssString(value) {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function normalizeBlendMode(value) {
    const normalized = normalizeCssString(value)
    if (!normalized) return null

    const upperValue = normalized.toUpperCase()
    if (upperValue === 'PASS_THROUGH' || upperValue === 'NORMAL') return null

    return normalized
  }

  function normalizeFontFamily(value) {
    const normalized = normalizeCssString(value)
    if (!normalized) return null

    const [firstFamily] = normalized.split(',')
    return firstFamily ? firstFamily.trim().replace(/^['"]|['"]$/g, '') : null
  }

  function normalizeCssShadow(value) {
    const normalized = normalizeCssString(value)
    if (!normalized || normalized.toLowerCase() === 'none') return null
    return normalized.replace(/\s+/g, ' ')
  }

  function normalizeCssLetterSpacingValue(value) {
    if (typeof value !== 'string') return normalizeCssNumber(value)

    const normalized = value.trim().toLowerCase()
    if (!normalized) return null

    // In CSS, `letter-spacing: normal` is the default rendering behavior and
    // should not be treated as a real mismatch against Figma `0px`.
    if (normalized === 'normal') return 0

    return normalizeCssNumber(value)
  }

  function getCssLetterSpacingUnit(value) {
    if (typeof value !== 'string') return null

    const normalized = value.trim().toLowerCase()
    if (!normalized) return null

    if (normalized === 'normal') return 'PIXELS'
    return getCssUnit(value)
  }

  function getCssUnit(value) {
    if (typeof value !== 'string') return null

    const normalized = value.trim().toLowerCase()
    if (!normalized || normalized === 'normal' || normalized === 'auto') return 'AUTO'
    if (normalized.endsWith('%')) return 'PERCENT'
    if (normalized.endsWith('px')) return 'PIXELS'
    if (/^-?\d+(\.\d+)?$/.test(normalized)) return 'NUMBER'

    return normalized.replace(/[^a-z%]+/g, '').toUpperCase() || null
  }

  function cssRgbToObject(value) {
    if (!value) return null

    const match = value.match(/rgba?\(([^)]+)\)/i)
    if (!match) return null

    const parts = match[1].split(',').map(part => part.trim())
    if (parts.length < 3) return null

    if (parts.length >= 4) {
      const alpha = Number(parts[3])
      if (Number.isFinite(alpha) && alpha === 0) return null
    }

    const [r, g, b] = parts.slice(0, 3).map(Number)
    if (![r, g, b].every(Number.isFinite)) return null
    return { r, g, b }
  }

  function getUniformBorderMetric(values) {
    if (!Array.isArray(values) || values.length === 0) return null
    if (values.some(value => value == null)) return null
    const [first] = values
    return values.every(value => value === first) ? first : null
  }

  function getUniformBorderColor(style) {
    const values = [
      cssRgbToObject(style.borderTopColor),
      cssRgbToObject(style.borderRightColor),
      cssRgbToObject(style.borderBottomColor),
      cssRgbToObject(style.borderLeftColor)
    ]

    if (values.some(value => !value)) return null
    const [first] = values
    return values.every(
      value => value.r === first.r && value.g === first.g && value.b === first.b
    )
      ? first
      : null
  }

  function toRelativeBounds(bounds, containerBounds) {
    return {
      x: bounds.x - containerBounds.x,
      y: bounds.y - containerBounds.y,
      width: bounds.width,
      height: bounds.height
    }
  }

  function toAbsoluteBounds(relativeBounds, containerBounds) {
    return {
      x: containerBounds.x + relativeBounds.x,
      y: containerBounds.y + relativeBounds.y,
      width: relativeBounds.width,
      height: relativeBounds.height
    }
  }

  function toScaledAbsoluteBounds(relativeBounds, containerBounds, scaleContext) {
    return {
      x: containerBounds.x + relativeBounds.x * scaleContext.scaleX,
      y: containerBounds.y + relativeBounds.y * scaleContext.scaleY,
      width: relativeBounds.width * scaleContext.scaleX,
      height: relativeBounds.height * scaleContext.scaleY
    }
  }

  function isVisibleDomElement(element) {
    if (!(element instanceof Element)) return false

    const style = window.getComputedStyle(element)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    ) {
      return false
    }

    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function isIgnoredSvgChild(element) {
    const tagName = element.tagName?.toLowerCase()
    if (!tagName) return false

    return (
      element instanceof SVGElement &&
      tagName !== 'svg' &&
      tagName !== 'foreignobject'
    )
  }

  function getElementBounds(element) {
    const rect = element.getBoundingClientRect()

    return normalizeBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    })
  }

  function hasMeaningfulBackground(value) {
    if (!value || value === 'transparent') return false

    const match = value.match(/rgba?\(([^)]+)\)/i)
    if (!match) return true

    const parts = match[1].split(',').map(part => part.trim())
    if (parts.length < 3) return true
    if (parts.length === 4 && Number(parts[3]) === 0) return false

    return true
  }

  function hasVisibleBorder(style) {
    const widths = [
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth
    ]

    if (
      style.borderTopStyle === 'none' &&
      style.borderRightStyle === 'none' &&
      style.borderBottomStyle === 'none' &&
      style.borderLeftStyle === 'none'
    ) {
      return false
    }

    return widths.some(value => parseFloat(value) > 0)
  }

  function hasPadding(style) {
    return (
      parseFloat(style.paddingTop) > 0 ||
      parseFloat(style.paddingRight) > 0 ||
      parseFloat(style.paddingBottom) > 0 ||
      parseFloat(style.paddingLeft) > 0
    )
  }

  function isTextLikeElement(element) {
    const tagName = element.tagName?.toLowerCase() || ''
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

    return (
      textTags.has(tagName) ||
      (element.childElementCount === 0 && (element.textContent || '').trim().length > 0)
    )
  }

  function extractDomNode(element) {
    const bounds = getElementBounds(element)
    if (!bounds) return null

    const style = window.getComputedStyle(element)
    const tagName = element.tagName?.toLowerCase() || 'unknown'
    const textContent = (element.textContent || '').trim()
    const hasBackground = hasMeaningfulBackground(style.backgroundColor)
    const hasBorder = hasVisibleBorder(style)
    const hasPaddingValue = hasPadding(style)
    const isInteractive = element.matches(
      'button, a, input, select, textarea, summary, [role="button"], [role="link"]'
    )
    const isTextLike = isTextLikeElement(element)
    const visualScore =
      Number(hasBackground) +
      Number(hasBorder) +
      Number(hasPaddingValue) +
      Number(isInteractive) +
      Number(isTextLike)

    return {
      element,
      nodeName: element.getAttribute('aria-label') || tagName,
      bounds,
      tagName,
      display: style.display,
      parentElement: element.parentElement,
      childCount: element.childElementCount,
      textLength: textContent.length,
      hasPadding: hasPaddingValue,
      hasBackground,
      hasBorder,
      isInteractive,
      isTextLike,
      visualScore,
      isVisualBoundary: visualScore > 0,
      wrapperPenalty:
        !visualScore && element.childElementCount > 0 ? 0.18 : 0,
      area: bounds.width * bounds.height
    }
  }

  function getDomCandidates(containerElement) {
    const candidates = []

    if (isVisibleDomElement(containerElement)) {
      const containerCandidate = extractDomNode(containerElement)
      if (containerCandidate) {
        candidates.push(containerCandidate)
      }
    }

    const elements = containerElement.querySelectorAll('*')

    elements.forEach(element => {
      if (!isVisibleDomElement(element)) return
      if (isIgnoredSvgChild(element)) return

      const candidate = extractDomNode(element)
      if (candidate) {
        candidates.push(candidate)
      }
    })

    return candidates.map((candidate, index) => ({
      ...candidate,
      domOrder: index
    }))
  }

  function normalizeSuggestedCandidates(candidates, tolerance) {
    const byElement = new Map(candidates.map(candidate => [candidate.element, candidate]))

    return candidates
      .filter(candidate => {
        if (candidate.display === 'contents') return false

        const parentCandidate = byElement.get(candidate.parentElement)
        if (!parentCandidate) return true

        if (!boundsRoughlyEqual(candidate.bounds, parentCandidate.bounds, Math.max(1.5, tolerance))) {
          return true
        }

        if (candidate.visualScore > parentCandidate.visualScore) return true
        if (candidate.visualScore < parentCandidate.visualScore) return false
        if (candidate.isInteractive && !parentCandidate.isInteractive) return true
        if (!candidate.isInteractive && parentCandidate.isInteractive) return false
        if (candidate.isTextLike && !parentCandidate.isTextLike) return true
        if (!candidate.isTextLike && parentCandidate.isTextLike) return false

        return candidate.childCount === 0
      })
      .map(candidate => ({
        ...candidate,
        wrapperPenalty:
          candidate.wrapperPenalty +
          (!candidate.isVisualBoundary && candidate.childCount > 0 ? 0.08 : 0)
      }))
  }

  function getOverlapArea(firstBounds, secondBounds) {
    const left = Math.max(firstBounds.x, secondBounds.x)
    const top = Math.max(firstBounds.y, secondBounds.y)
    const right = Math.min(
      firstBounds.x + firstBounds.width,
      secondBounds.x + secondBounds.width
    )
    const bottom = Math.min(
      firstBounds.y + firstBounds.height,
      secondBounds.y + secondBounds.height
    )

    return Math.max(0, right - left) * Math.max(0, bottom - top)
  }

  function getOverlapRatio(firstBounds, secondBounds) {
    const overlapArea = getOverlapArea(firstBounds, secondBounds)
    if (overlapArea === 0) return 0

    const smallerArea = Math.min(
      firstBounds.width * firstBounds.height,
      secondBounds.width * secondBounds.height
    )

    if (smallerArea <= 0) return 0
    return overlapArea / smallerArea
  }

  function getIntersectionOverUnion(firstBounds, secondBounds) {
    const overlapArea = getOverlapArea(firstBounds, secondBounds)
    if (overlapArea === 0) return 0

    const firstArea = firstBounds.width * firstBounds.height
    const secondArea = secondBounds.width * secondBounds.height
    const union = firstArea + secondArea - overlapArea

    return union > 0 ? overlapArea / union : 0
  }

  function compareDimension(figmaValue, browserValue, tolerance) {
    if (!isFiniteNumber(figmaValue) || !isFiniteNumber(browserValue)) {
      return false
    }

    return Math.abs(figmaValue - browserValue) <= tolerance
  }

  function compareColor(figmaColor, browserColor, tolerance = 1) {
    if (!figmaColor || !browserColor) return false

    return (
      Math.abs(figmaColor.r - browserColor.r) <= tolerance &&
      Math.abs(figmaColor.g - browserColor.g) <= tolerance &&
      Math.abs(figmaColor.b - browserColor.b) <= tolerance
    )
  }

  function normalizeTextContent(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/\s+/g, ' ').trim()
  }

  function getBrowserTextContent(element) {
    if (!(element instanceof Element)) return null

    const textSource =
      typeof element.innerText === 'string' && element.innerText.trim().length > 0
        ? element.innerText
        : element.textContent

    return typeof textSource === 'string' ? textSource : null
  }

  function buildTextComparison(figmaText, browserText) {
    if (typeof figmaText !== 'string') return null

    return {
      figma: figmaText,
      browser: browserText,
      normalizedFigma: normalizeTextContent(figmaText),
      normalizedBrowser: normalizeTextContent(browserText),
      matches: normalizeTextContent(figmaText) === normalizeTextContent(browserText)
    }
  }

  function boundsRoughlyEqual(firstBounds, secondBounds, tolerance) {
    if (!firstBounds || !secondBounds) return false

    return (
      compareDimension(firstBounds.x, secondBounds.x, tolerance) &&
      compareDimension(firstBounds.y, secondBounds.y, tolerance) &&
      compareDimension(firstBounds.width, secondBounds.width, tolerance) &&
      compareDimension(firstBounds.height, secondBounds.height, tolerance)
    )
  }

  function isDescendantOf(element, ancestorElement) {
    if (!element || !ancestorElement || element === ancestorElement) return false
    return ancestorElement.contains(element)
  }

  function getCenter(bounds) {
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2
    }
  }

  function getArea(bounds) {
    return bounds.width * bounds.height
  }

  function getAspectRatio(bounds) {
    return bounds.width > 0 && bounds.height > 0 ? bounds.width / bounds.height : 1
  }

  function getProjectionThresholds(bounds, thresholds) {
    return {
      widthTolerance: Math.max(bounds.width * thresholds.widthDeltaRatio, thresholds.minAbsoluteDelta),
      heightTolerance: Math.max(
        bounds.height * thresholds.heightDeltaRatio,
        thresholds.minAbsoluteDelta
      ),
      centerXTolerance: Math.max(
        bounds.width * thresholds.centerOffsetRatioX,
        thresholds.minCenterOffset
      ),
      centerYTolerance: Math.max(
        bounds.height * thresholds.centerOffsetRatioY,
        thresholds.minCenterOffset
      )
    }
  }

  function getEdgeAlignmentPenalty(firstBounds, secondBounds, thresholds) {
    const left = Math.abs(firstBounds.x - secondBounds.x) / thresholds.widthTolerance
    const right =
      Math.abs(
        firstBounds.x + firstBounds.width - (secondBounds.x + secondBounds.width)
      ) / thresholds.widthTolerance
    const top = Math.abs(firstBounds.y - secondBounds.y) / thresholds.heightTolerance
    const bottom =
      Math.abs(
        firstBounds.y + firstBounds.height - (secondBounds.y + secondBounds.height)
      ) / thresholds.heightTolerance

    return clamp((left + right + top + bottom) / 4, 0, 2)
  }

  function containsPoint(bounds, point) {
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    )
  }

  function classifyCandidateRejection(figmaProjectedBounds, candidateBounds, thresholds) {
    const figmaCenter = getCenter(figmaProjectedBounds)
    const candidateCenter = getCenter(candidateBounds)
    const projectionThresholds = getProjectionThresholds(figmaProjectedBounds, thresholds)
    const reasons = []

    if (
      Math.abs(figmaProjectedBounds.width - candidateBounds.width) >
      projectionThresholds.widthTolerance
    ) {
      reasons.push('width_delta')
    }

    if (
      Math.abs(figmaProjectedBounds.height - candidateBounds.height) >
      projectionThresholds.heightTolerance
    ) {
      reasons.push('height_delta')
    }

    if (
      Math.abs(figmaCenter.x - candidateCenter.x) >
      projectionThresholds.centerXTolerance
    ) {
      reasons.push('center_x')
    }

    if (
      Math.abs(figmaCenter.y - candidateCenter.y) >
      projectionThresholds.centerYTolerance
    ) {
      reasons.push('center_y')
    }

    if (
      getOverlapRatio(figmaProjectedBounds, candidateBounds) < thresholds.minOverlapRatio
    ) {
      reasons.push('overlap')
    }

    return reasons
  }

  function getBrowserStyleSnapshot(element) {
    const computedStyles = window.getComputedStyle(element)
    const borderTopLeftRadius = normalizeCssNumber(computedStyles.borderTopLeftRadius)
    const borderTopRightRadius = normalizeCssNumber(computedStyles.borderTopRightRadius)
    const borderBottomRightRadius = normalizeCssNumber(computedStyles.borderBottomRightRadius)
    const borderBottomLeftRadius = normalizeCssNumber(computedStyles.borderBottomLeftRadius)
    const borderWidths = [
      normalizeCssNumber(computedStyles.borderTopWidth),
      normalizeCssNumber(computedStyles.borderRightWidth),
      normalizeCssNumber(computedStyles.borderBottomWidth),
      normalizeCssNumber(computedStyles.borderLeftWidth)
    ]

    return {
      typography: {
        fontFamily: normalizeFontFamily(computedStyles.fontFamily),
        fontSize: normalizeCssNumber(computedStyles.fontSize),
        fontWeight: normalizeCssNumber(computedStyles.fontWeight),
        lineHeight: normalizeCssNumber(computedStyles.lineHeight),
        lineHeightUnit: getCssUnit(computedStyles.lineHeight),
        letterSpacing: normalizeCssLetterSpacingValue(computedStyles.letterSpacing),
        letterSpacingUnit: getCssLetterSpacingUnit(computedStyles.letterSpacing)
      },
      colors: {
        text: cssRgbToObject(computedStyles.color),
        background: cssRgbToObject(computedStyles.backgroundColor)
      },
      border: {
        radius: normalizeCssNumber(computedStyles.borderRadius),
        topLeftRadius: borderTopLeftRadius,
        topRightRadius: borderTopRightRadius,
        bottomRightRadius: borderBottomRightRadius,
        bottomLeftRadius: borderBottomLeftRadius,
        strokeWidth: getUniformBorderMetric(borderWidths),
        strokeColor: getUniformBorderColor(computedStyles)
      },
      spacing: {
        paddingTop: normalizeCssNumber(computedStyles.paddingTop),
        paddingRight: normalizeCssNumber(computedStyles.paddingRight),
        paddingBottom: normalizeCssNumber(computedStyles.paddingBottom),
        paddingLeft: normalizeCssNumber(computedStyles.paddingLeft)
      },
      compositing: {
        opacity: normalizeCssNumber(computedStyles.opacity),
        blendMode: normalizeBlendMode(computedStyles.mixBlendMode)
      },
      effects: {
        shadow: normalizeCssShadow(computedStyles.boxShadow)
      }
    }
  }

  function buildStyleComparison(figmaStyles, browserStyles) {
    if (!figmaStyles) return null

    const comparison = {
      figma: figmaStyles,
      browser: {},
      diffs: {}
    }

    function recordNumeric(groupKey, propertyKey, figmaValue, browserValue) {
      if (figmaValue == null) return

      if (!comparison.browser[groupKey]) comparison.browser[groupKey] = {}
      if (!comparison.diffs[groupKey]) comparison.diffs[groupKey] = {}

      comparison.browser[groupKey][propertyKey] = browserValue
      comparison.diffs[groupKey][propertyKey] = !compareDimension(
        figmaValue,
        browserValue,
        0.5
      )
    }

    function recordString(groupKey, propertyKey, figmaValue, browserValue, normalize = value => value) {
      if (!figmaValue) return

      if (!comparison.browser[groupKey]) comparison.browser[groupKey] = {}
      if (!comparison.diffs[groupKey]) comparison.diffs[groupKey] = {}

      comparison.browser[groupKey][propertyKey] = browserValue
      comparison.diffs[groupKey][propertyKey] =
        normalize(figmaValue) !== normalize(browserValue)
    }

    function recordColor(groupKey, propertyKey, figmaValue, browserValue) {
      if (!figmaValue) return

      if (!comparison.browser[groupKey]) comparison.browser[groupKey] = {}
      if (!comparison.diffs[groupKey]) comparison.diffs[groupKey] = {}

      comparison.browser[groupKey][propertyKey] = browserValue
      comparison.diffs[groupKey][propertyKey] = !compareColor(
        figmaValue,
        browserValue
      )
    }

    if (figmaStyles.typography) {
      recordString(
        'typography',
        'fontFamily',
        figmaStyles.typography.fontFamily,
        browserStyles.typography?.fontFamily,
        value => normalizeFontFamily(value) || ''
      )
      recordNumeric(
        'typography',
        'fontSize',
        figmaStyles.typography.fontSize,
        browserStyles.typography?.fontSize
      )
      recordNumeric(
        'typography',
        'fontWeight',
        figmaStyles.typography.fontWeight,
        browserStyles.typography?.fontWeight
      )
      recordNumeric(
        'typography',
        'lineHeight',
        figmaStyles.typography.lineHeight,
        browserStyles.typography?.lineHeight
      )
      recordString(
        'typography',
        'lineHeightUnit',
        figmaStyles.typography.lineHeightUnit,
        browserStyles.typography?.lineHeightUnit
      )
      recordNumeric(
        'typography',
        'letterSpacing',
        figmaStyles.typography.letterSpacing,
        browserStyles.typography?.letterSpacing
      )
      recordString(
        'typography',
        'letterSpacingUnit',
        figmaStyles.typography.letterSpacingUnit,
        browserStyles.typography?.letterSpacingUnit
      )
    }

    if (figmaStyles.colors) {
      recordColor(
        'colors',
        'text',
        figmaStyles.colors.text,
        browserStyles.colors?.text
      )
      recordColor(
        'colors',
        'background',
        figmaStyles.colors.background,
        browserStyles.colors?.background
      )
    }

    if (figmaStyles.border) {
      recordNumeric(
        'border',
        'radius',
        figmaStyles.border.radius,
        browserStyles.border?.radius
      )
      ;[
        'topLeftRadius',
        'topRightRadius',
        'bottomRightRadius',
        'bottomLeftRadius',
        'strokeWidth'
      ].forEach(propertyKey => {
        recordNumeric(
          'border',
          propertyKey,
          figmaStyles.border[propertyKey],
          browserStyles.border?.[propertyKey]
        )
      })
      recordColor(
        'border',
        'strokeColor',
        figmaStyles.border.strokeColor,
        browserStyles.border?.strokeColor
      )
    }

    if (figmaStyles.spacing) {
      ;['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(
        propertyKey => {
          recordNumeric(
            'spacing',
            propertyKey,
            figmaStyles.spacing[propertyKey],
            browserStyles.spacing?.[propertyKey]
          )
        }
      )
    }

    if (figmaStyles.compositing) {
      recordNumeric(
        'compositing',
        'opacity',
        figmaStyles.compositing.opacity,
        browserStyles.compositing?.opacity
      )
      recordString(
        'compositing',
        'blendMode',
        figmaStyles.compositing.blendMode,
        browserStyles.compositing?.blendMode,
        value => normalizeBlendMode(value) || ''
      )
    }

    if (figmaStyles.effects) {
      recordString(
        'effects',
        'shadow',
        figmaStyles.effects.shadow,
        browserStyles.effects?.shadow,
        value => normalizeCssShadow(value) || ''
      )
    }

    return comparison
  }

  function createValidationResult(
    figmaNode,
    browserNode,
    tolerance,
    mappingStatus,
    debug,
    extras = {}
  ) {
    const figmaWidth = figmaNode.bounds.width
    const figmaHeight = figmaNode.bounds.height
    const browserWidth = browserNode?.bounds.width ?? null
    const browserHeight = browserNode?.bounds.height ?? null
    const widthMatches =
      mappingStatus === 'matched'
        ? compareDimension(figmaWidth, browserWidth, tolerance)
        : null
    const heightMatches =
      mappingStatus === 'matched'
        ? compareDimension(figmaHeight, browserHeight, tolerance)
        : null

    const baseResult = {
      nodeId: figmaNode.nodeId ?? null,
      nodeName: figmaNode.nodeName,
      nodeType: figmaNode.nodeType ?? null,
      figmaBounds: {
        x: figmaNode.bounds.x,
        y: figmaNode.bounds.y,
        width: figmaWidth,
        height: figmaHeight
      },
      browserBounds: browserNode
        ? {
            x: browserNode.bounds.x,
            y: browserNode.bounds.y,
            width: browserWidth,
            height: browserHeight
          }
        : null,
      figma: {
        width: figmaWidth,
        height: figmaHeight
      },
      browser: {
        width: browserWidth,
        height: browserHeight
      },
      comparisons: {
        width: widthMatches,
        height: heightMatches
      },
      figmaStyles: figmaNode.styles || null,
      figmaText: figmaNode.textContent ?? null,
      styleComparison: null,
      textComparison: null,
      mappingStatus,
      status:
        mappingStatus === 'matched' && widthMatches && heightMatches
          ? 'match'
          : mappingStatus === 'matched'
            ? 'mismatch'
            : 'unmatched',
      debug,
      children: []
    }

    return {
      ...baseResult,
      ...extras
    }
  }

  function createMatchMeta(result, browserNode, depth, kind, extras = {}) {
    return {
      nodeName: result.nodeName,
      status: result.status,
      mappingStatus: result.mappingStatus,
      element: browserNode?.element ?? null,
      depth,
      kind,
      ...extras
    }
  }

  function enrichStyleComparisons(validationResult, matchEntries) {
    let matchIndex = 0

    function walk(result) {
      const matchEntry = matchEntries[matchIndex] || null
      matchIndex += 1

      if (
        result.mappingStatus === 'matched' &&
        result.status === 'mismatch' &&
        matchEntry?.element &&
        result.figmaStyles
      ) {
        result.styleComparison = buildStyleComparison(
          result.figmaStyles,
          getBrowserStyleSnapshot(matchEntry.element)
        )
      }

      if (
        result.mappingStatus === 'matched' &&
        matchEntry?.element &&
        typeof result.figmaText === 'string'
      ) {
        result.textComparison = buildTextComparison(
          result.figmaText,
          getBrowserTextContent(matchEntry.element)
        )
      }

      result.children.forEach(child => walk(child))
      return result
    }

    return walk(validationResult)
  }

  function buildScaleContext(figmaRootBounds, domRootBounds) {
    return {
      scaleX:
        figmaRootBounds.width > 0 ? domRootBounds.width / figmaRootBounds.width : 1,
      scaleY:
        figmaRootBounds.height > 0 ? domRootBounds.height / figmaRootBounds.height : 1
    }
  }

  function normalizeRepeatedName(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/\d+/g, '#')
      .replace(/[^a-z#]+/g, ' ')
      .trim()
  }

  function getRepeatedSignature(figmaNode) {
    const bounds = normalizeBounds(figmaNode?.bounds)
    if (!bounds) return ''

    const nodeName = normalizeRepeatedName(figmaNode.nodeName || figmaNode.nodeType || 'node')
    const widthBucket = Math.round(bounds.width / 12)
    const heightBucket = Math.round(bounds.height / 12)

    return [figmaNode.nodeType || 'node', nodeName || 'node', widthBucket, heightBucket].join(':')
  }

  function getSiblingAxis(parentFigmaNode, figmaChildren) {
    if (figmaChildren.length <= 1) return 'y'

    const layoutMode =
      parentFigmaNode && parentFigmaNode.styles && parentFigmaNode.styles.layout
        ? parentFigmaNode.styles.layout.layoutMode
        : null
    if (layoutMode === 'HORIZONTAL') return 'x'
    if (layoutMode === 'VERTICAL') return 'y'

    const xSpread =
      Math.max(...figmaChildren.map(child => child.bounds.x + child.bounds.width / 2)) -
      Math.min(...figmaChildren.map(child => child.bounds.x + child.bounds.width / 2))
    const ySpread =
      Math.max(...figmaChildren.map(child => child.bounds.y + child.bounds.height / 2)) -
      Math.min(...figmaChildren.map(child => child.bounds.y + child.bounds.height / 2))

    return xSpread > ySpread ? 'x' : 'y'
  }

  function buildRepeatedSiblingGroups(parentFigmaNode, figmaChildren) {
    const groupsBySignature = new Map()
    const axis = getSiblingAxis(parentFigmaNode, figmaChildren)

    figmaChildren.forEach((child, index) => {
      const signature = getRepeatedSignature(child)
      const group = groupsBySignature.get(signature) || []
      group.push({
        child,
        index,
        center:
          axis === 'x'
            ? child.bounds.x + child.bounds.width / 2
            : child.bounds.y + child.bounds.height / 2
      })
      groupsBySignature.set(signature, group)
    })

    return {
      axis,
      groups: Array.from(groupsBySignature.entries())
        .filter(([, group]) => group.length > 1)
        .map(([signature, group]) => ({
          signature,
          members: group
            .slice()
            .sort((left, right) => left.center - right.center)
            .map((member, orderIndex) => ({
              ...member,
              orderIndex
            }))
        }))
    }
  }

  function applyRepeatedStructureBias(childEntries, repeatedContext) {
    if (!repeatedContext?.groups?.length) return

    repeatedContext.groups.forEach(group => {
      const groupEntries = group.members
        .map(member => ({
          member,
          entry: childEntries[member.index]
        }))
        .filter(item => item.entry)

      if (groupEntries.length <= 1) return

      const parentCounts = new Map()
      groupEntries.forEach(({ entry }) => {
        entry.options.forEach(option => {
          const parent = option.candidate?.parentElement || null
          if (!parent) return
          parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1)
        })
      })

      const dominantParent = Array.from(parentCounts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] || null

      groupEntries.forEach(({ member, entry }) => {
        const orderedOptions = entry.options
          .slice()
          .sort((left, right) => {
            const leftCenter =
              repeatedContext.axis === 'x'
                ? left.candidate?.bounds?.x ?? Number.POSITIVE_INFINITY
                : left.candidate?.bounds?.y ?? Number.POSITIVE_INFINITY
            const rightCenter =
              repeatedContext.axis === 'x'
                ? right.candidate?.bounds?.x ?? Number.POSITIVE_INFINITY
                : right.candidate?.bounds?.y ?? Number.POSITIVE_INFINITY
            return leftCenter - rightCenter
          })

        entry.options = entry.options
          .map(option => {
            let adjustedScore = option.score

            if (dominantParent && option.candidate?.parentElement) {
              adjustedScore +=
                option.candidate.parentElement === dominantParent
                  ? -SUGGESTED_MATCHER_CONFIG.repeatedSharedParentBonus
                  : SUGGESTED_MATCHER_CONFIG.repeatedForeignParentPenalty
            }

            const optionIndex = orderedOptions.indexOf(option)
            if (optionIndex >= 0 && orderedOptions.length > 1) {
              const expectedRatio = member.orderIndex / Math.max(group.members.length - 1, 1)
              const actualRatio = optionIndex / Math.max(orderedOptions.length - 1, 1)
              adjustedScore +=
                Math.abs(expectedRatio - actualRatio) *
                SUGGESTED_MATCHER_CONFIG.repeatedOrderPenalty
            }

            return {
              ...option,
              score: clamp(adjustedScore, 0, 4)
            }
          })
          .sort((left, right) => left.score - right.score)

        entry.repeatedStructure = {
          signature: group.signature,
          orderIndex: member.orderIndex,
          size: group.members.length
        }
        entry.bestScore = entry.options[0]?.score ?? entry.bestScore
        entry.secondScore = entry.options[1]?.score ?? entry.secondScore
      })
    })
  }

  function buildRepeatedAmbiguityByIndex(childEntries, rawAssignments, repeatedContext) {
    const ambiguityByIndex = new Map()
    if (!repeatedContext?.groups?.length) return ambiguityByIndex

    repeatedContext.groups.forEach(group => {
      const selectedMembers = group.members
        .map(member => ({
          member,
          entry: childEntries[member.index],
          assignment: rawAssignments[member.index]
        }))
        .filter(item => item.assignment)

      if (selectedMembers.length <= 1) return

      const matchedAssignments = selectedMembers.filter(item => item.assignment.candidate)
      const selectedParents = new Set(
        matchedAssignments
          .map(item => item.assignment.candidate?.parentElement || null)
          .filter(Boolean)
      )

      const orderMismatch = matchedAssignments.some((item, index, array) => {
        if (index === 0) return false
        const previous = array[index - 1].assignment.candidate?.domOrder ?? -1
        const current = item.assignment.candidate?.domOrder ?? -1
        return current < previous
      })

      selectedMembers.forEach(({ member, entry }) => {
        const reasons = []
        const scoreGap =
          typeof entry?.bestScore === 'number' && typeof entry?.secondScore === 'number'
            ? entry.secondScore - entry.bestScore
            : null

        if (
          typeof scoreGap === 'number' &&
          scoreGap < SUGGESTED_MATCHER_CONFIG.repeatedAmbiguityScoreGap
        ) {
          reasons.push('close_candidates')
        }

        if (selectedParents.size > 1) {
          reasons.push('mixed_parent_group')
        }

        if (orderMismatch) {
          reasons.push('sibling_order_mismatch')
        }

        ambiguityByIndex.set(member.index, {
          inRepeatedGroup: true,
          signature: group.signature,
          repeatedGroupSize: group.members.length,
          orderIndex: member.orderIndex,
          ambiguous: reasons.length > 0,
          reasons
        })
      })
    })

    return ambiguityByIndex
  }

  function projectSuggestedBounds(
    figmaBounds,
    figmaRootBounds,
    domRootBounds,
    scaleContext
  ) {
    const figmaRelativeBounds = toRelativeBounds(figmaBounds, figmaRootBounds)
    return toScaledAbsoluteBounds(figmaRelativeBounds, domRootBounds, scaleContext)
  }

  // Remove redundant DOM wrappers before matching so the algorithm evaluates
  // the most meaningful visual boundaries instead of every structural div.
  function getSuggestedSemanticAdjustment(figmaNode, candidate) {
    const nodeName = String(figmaNode.nodeName || '').toLowerCase()
    const isTextNode = figmaNode.nodeType === 'TEXT'
    const looksInteractive = /button|cta|tag|chip|pill|badge|link/.test(nodeName)

    let adjustment = 0

    if (isTextNode) {
      adjustment += candidate.isTextLike ? -0.12 : 0.16
    } else if (candidate.isTextLike && !candidate.hasBackground && !candidate.isInteractive) {
      adjustment += 0.07
    }

    if (looksInteractive && candidate.isInteractive) {
      adjustment -= 0.06
    }

    if (candidate.isVisualBoundary) {
      adjustment -= 0.03
    }

    return adjustment
  }

  function filterEligibleCandidatesSuggested(
    figmaNode,
    candidatePool,
    figmaRootBounds,
    domRootBounds,
    scaleContext
  ) {
    const figmaProjectedBounds = projectSuggestedBounds(
      figmaNode.bounds,
      figmaRootBounds,
      domRootBounds,
      scaleContext
    )
    const eligibleCandidates = []
    const rejectedCandidates = []

    candidatePool.forEach(candidate => {
      const reasons = classifyCandidateRejection(
        figmaProjectedBounds,
        candidate.bounds,
        SUGGESTED_MATCHER_CONFIG
      )

      if (reasons.length === 0) {
        eligibleCandidates.push(candidate)
      } else {
        rejectedCandidates.push({
          candidate,
          reasons
        })
      }
    })

    return {
      figmaProjectedBounds,
      eligibleCandidates,
      rejectedCandidates
    }
  }

  // Suggested scoring is multi-signal rather than center+size only. Geometry
  // still dominates, but semantic hints and subtree preference help disambiguate
  // repeated chips, text nodes, and wrapper-heavy DOM structures.
  function scoreSuggestedCandidate(
    figmaNode,
    figmaProjectedBounds,
    candidate,
    preferredParentElement,
    parentConfidence
  ) {
    const projectedCenter = getCenter(figmaProjectedBounds)
    const candidateCenter = getCenter(candidate.bounds)
    const projectionThresholds = getProjectionThresholds(
      figmaProjectedBounds,
      SUGGESTED_MATCHER_CONFIG
    )
    const dx = Math.abs(projectedCenter.x - candidateCenter.x)
    const dy = Math.abs(projectedCenter.y - candidateCenter.y)
    const widthDelta = Math.abs(figmaProjectedBounds.width - candidate.bounds.width)
    const heightDelta = Math.abs(figmaProjectedBounds.height - candidate.bounds.height)
    const positionPenalty = clamp(
      (dx / projectionThresholds.centerXTolerance +
        dy / projectionThresholds.centerYTolerance) /
        2,
      0,
      2
    )
    const sizePenalty = clamp(
      (widthDelta / projectionThresholds.widthTolerance +
        heightDelta / projectionThresholds.heightTolerance) /
        2,
      0,
      2
    )
    const iou = getIntersectionOverUnion(figmaProjectedBounds, candidate.bounds)
    const overlapRatio = getOverlapRatio(figmaProjectedBounds, candidate.bounds)
    const edgePenalty = getEdgeAlignmentPenalty(
      figmaProjectedBounds,
      candidate.bounds,
      projectionThresholds
    )
    const aspectPenalty = clamp(
      Math.abs(
        Math.log(
          getAspectRatio(figmaProjectedBounds) / getAspectRatio(candidate.bounds)
        )
      ),
      0,
      1.5
    )
    const figmaArea = Math.max(getArea(figmaProjectedBounds), 1)
    const areaRatio = candidate.area / figmaArea
    const largeContainerPenalty =
      areaRatio > 1.8 && containsPoint(candidate.bounds, projectedCenter)
        ? Math.min(0.32, (areaRatio - 1.8) * 0.08)
        : 0
    const semanticAdjustment = getSuggestedSemanticAdjustment(figmaNode, candidate)
    const insidePreferredSubtree = preferredParentElement
      ? isDescendantOf(candidate.element, preferredParentElement)
      : false
    const subtreeBonus =
      preferredParentElement && parentConfidence >= 0.6 && insidePreferredSubtree
        ? -0.08
        : 0

    const score =
      0.24 * positionPenalty +
      0.18 * sizePenalty +
      0.18 * (1 - iou) +
      0.1 * (1 - overlapRatio) +
      0.12 * edgePenalty +
      0.08 * aspectPenalty +
      largeContainerPenalty +
      candidate.wrapperPenalty +
      semanticAdjustment +
      subtreeBonus

    return {
      candidate,
      score: clamp(score, 0, 4),
      iou,
      overlapRatio,
      insidePreferredSubtree
    }
  }

  function deriveConfidence(bestScore, secondScore, matchKind) {
    const baseScore = clamp(
      1 - bestScore / SUGGESTED_MATCHER_CONFIG.maxAcceptedScore,
      0,
      1
    )
    const gapBonus =
      secondScore == null
        ? 0.18
        : clamp((secondScore - bestScore) / 0.35, 0, 1) * 0.2
    const reuseAdjustment = matchKind === 'reused' ? -0.08 : 0
    const fallbackAdjustment = matchKind === 'fallback' ? -0.05 : 0
    const confidenceScore = clamp(
      baseScore + gapBonus + reuseAdjustment + fallbackAdjustment,
      0,
      1
    )

    return {
      confidenceScore,
      confidenceLevel:
        confidenceScore >= SUGGESTED_MATCHER_CONFIG.highConfidenceThreshold
          ? 'high'
          : confidenceScore >= SUGGESTED_MATCHER_CONFIG.mediumConfidenceThreshold
            ? 'medium'
            : 'low'
    }
  }

  function createTopCandidateSummary(scoredCandidate, bestScore) {
    return {
      nodeName: scoredCandidate.candidate.nodeName,
      bounds: scoredCandidate.candidate.bounds,
      score: Math.round(scoredCandidate.score * 100) / 100,
      confidenceGap:
        typeof bestScore === 'number'
          ? Math.round((scoredCandidate.score - bestScore) * 100) / 100
          : null
    }
  }

  function buildSuggestedOptionsForChild(
    figmaNode,
    figmaChild,
    browserNode,
    options
  ) {
    const {
      tolerance,
      figmaRootBounds,
      domRootBounds,
      scaleContext,
      candidatePool,
      parentConfidence
    } = options

    const projectedBounds = projectSuggestedBounds(
      figmaChild.bounds,
      figmaRootBounds,
      domRootBounds,
      scaleContext
    )
    const shouldReuseParentMatch =
      browserNode &&
      boundsRoughlyEqual(figmaChild.bounds, figmaNode.bounds, tolerance) &&
      boundsRoughlyEqual(figmaChild.bounds, browserNode.bounds, tolerance)

    if (shouldReuseParentMatch) {
      return {
        figmaChild,
        options: [
          {
            kind: 'reused',
            candidate: browserNode,
            score: 0.12,
            allowReuse: true,
            insidePreferredSubtree: true
          }
        ],
        eligibleCandidateCount: 1,
        rejectedCandidateReasons: [],
        topCandidates: browserNode
          ? [
              {
                nodeName: browserNode.nodeName,
                bounds: browserNode.bounds,
                score: 0.12,
                confidenceGap: null
              }
            ]
          : [],
        bestScore: 0.12,
        secondScore: null,
        projectedBounds
      }
    }

    const eligibility = filterEligibleCandidatesSuggested(
      figmaChild,
      candidatePool,
      figmaRootBounds,
      domRootBounds,
      scaleContext
    )

    const scoredCandidates = eligibility.eligibleCandidates
      .map(candidate =>
        scoreSuggestedCandidate(
          figmaChild,
          eligibility.figmaProjectedBounds,
          candidate,
          browserNode?.element,
          parentConfidence
        )
      )
      .sort((first, second) => first.score - second.score)

    return {
      figmaChild,
      options: scoredCandidates
        .filter(entry => entry.score <= SUGGESTED_MATCHER_CONFIG.maxAcceptedScore)
        .slice(0, SUGGESTED_MATCHER_CONFIG.optionLimit)
        .map(entry => ({
          kind:
            browserNode?.element && !entry.insidePreferredSubtree
              ? 'fallback'
              : 'direct',
          candidate: entry.candidate,
          score: entry.score,
          allowReuse: false,
          insidePreferredSubtree: entry.insidePreferredSubtree
        })),
      eligibleCandidateCount: eligibility.eligibleCandidates.length,
      rejectedCandidateReasons: eligibility.rejectedCandidates
        .slice(0, 5)
        .map(entry => entry.reasons.join(',')),
      topCandidates: scoredCandidates
        .slice(0, SUGGESTED_MATCHER_CONFIG.topCandidateLimit)
        .map(entry =>
          createTopCandidateSummary(entry, scoredCandidates[0]?.score ?? entry.score)
        ),
      bestScore: scoredCandidates[0]?.score ?? null,
      secondScore: scoredCandidates[1]?.score ?? null,
      projectedBounds: eligibility.figmaProjectedBounds
    }
  }

  function solveAssignmentsExact(childEntries) {
    const orderedEntries = childEntries
      .map((entry, index) => ({
        originalIndex: index,
        assignmentOptions: [
          ...entry.options,
          {
            kind: 'unmatched',
            candidate: null,
            score: SUGGESTED_MATCHER_CONFIG.unmatchedScore,
            allowReuse: true
          }
        ]
      }))
      .sort((first, second) => {
        const optionDiff =
          first.assignmentOptions.length - second.assignmentOptions.length
        if (optionDiff !== 0) return optionDiff

        return first.assignmentOptions[0].score - second.assignmentOptions[0].score
      })

    const best = {
      score: Number.POSITIVE_INFINITY,
      assignments: null
    }

    function search(index, usedElements, currentScore, currentAssignments) {
      if (currentScore >= best.score) return

      if (index === orderedEntries.length) {
        best.score = currentScore
        best.assignments = currentAssignments.slice()
        return
      }

      const entry = orderedEntries[index]

      entry.assignmentOptions.forEach(option => {
        const candidateKey = option.candidate?.element ?? null
        if (candidateKey && !option.allowReuse && usedElements.has(candidateKey)) {
          return
        }

        if (candidateKey && !option.allowReuse) {
          usedElements.add(candidateKey)
        }

        currentAssignments[entry.originalIndex] = option
        search(index + 1, usedElements, currentScore + option.score, currentAssignments)

        if (candidateKey && !option.allowReuse) {
          usedElements.delete(candidateKey)
        }
      })
    }

    search(0, new Set(), 0, new Array(childEntries.length))
    return best.assignments || new Array(childEntries.length).fill(null)
  }

  // Siblings are assigned as a group, which reduces cascading errors caused by
  // greedy one-by-one matching. Exact search is used for manageable sets and a
  // deterministic greedy fallback handles larger sibling groups.
  function solveAssignmentsGreedy(childEntries) {
    const remainingEntries = childEntries.map((entry, index) => ({
      ...entry,
      originalIndex: index,
      assignmentOptions: [
        ...entry.options,
        {
          kind: 'unmatched',
          candidate: null,
          score: SUGGESTED_MATCHER_CONFIG.unmatchedScore,
          allowReuse: true
        }
      ]
    }))
    const assignments = new Array(childEntries.length).fill(null)
    const usedElements = new Set()

    while (remainingEntries.length > 0) {
      remainingEntries.sort((first, second) => {
        const firstBest = first.assignmentOptions[0]?.score ?? Number.POSITIVE_INFINITY
        const secondBest =
          first.assignmentOptions[1]?.score ?? SUGGESTED_MATCHER_CONFIG.unmatchedScore
        const firstMargin = secondBest - firstBest
        const thirdBest = second.assignmentOptions[0]?.score ?? Number.POSITIVE_INFINITY
        const fourthBest =
          second.assignmentOptions[1]?.score ?? SUGGESTED_MATCHER_CONFIG.unmatchedScore
        const secondMargin = fourthBest - thirdBest

        if (firstMargin !== secondMargin) {
          return firstMargin - secondMargin
        }

        return first.assignmentOptions.length - second.assignmentOptions.length
      })

      const entry = remainingEntries.shift()
      if (!entry) break

      const selectedOption =
        entry.assignmentOptions.find(option => {
          const candidateKey = option.candidate?.element ?? null
          return !candidateKey || option.allowReuse || !usedElements.has(candidateKey)
        }) || entry.assignmentOptions[entry.assignmentOptions.length - 1]

      const candidateKey = selectedOption.candidate?.element ?? null
      if (candidateKey && !selectedOption.allowReuse) {
        usedElements.add(candidateKey)
      }

      assignments[entry.originalIndex] = selectedOption
    }

    return assignments
  }

  function finalizeSuggestedAssignment(
    optionSet,
    selectedOption,
    assignmentMethod,
    repeatedStructureMeta = null
  ) {
    const selectedKind = selectedOption?.kind || 'unmatched'
    const initialMatchKind = selectedKind === 'unmatched' ? 'unmatched' : selectedKind
    let initialConfidence =
      selectedKind === 'unmatched'
        ? { confidenceScore: 0, confidenceLevel: 'low' }
        : deriveConfidence(optionSet.bestScore ?? selectedOption.score, optionSet.secondScore, initialMatchKind)

    if (repeatedStructureMeta?.ambiguous && selectedKind !== 'unmatched') {
      const repeatedConfidenceScore = clamp(
        initialConfidence.confidenceScore - SUGGESTED_MATCHER_CONFIG.repeatedConfidencePenalty,
        0,
        1
      )
      initialConfidence = {
        confidenceScore: repeatedConfidenceScore,
        confidenceLevel:
          repeatedConfidenceScore >= SUGGESTED_MATCHER_CONFIG.highConfidenceThreshold
            ? 'high'
            : repeatedConfidenceScore >= SUGGESTED_MATCHER_CONFIG.mediumConfidenceThreshold
              ? 'medium'
              : 'low'
      }
    }

    const shouldDowngradeToUnmatched =
      selectedKind !== 'unmatched' &&
      initialMatchKind !== 'reused' &&
      initialConfidence.confidenceScore < 0.45 &&
      selectedOption.score >= 0.75

    const matchKind = shouldDowngradeToUnmatched ? 'unmatched' : initialMatchKind
    const matchedDomNode = shouldDowngradeToUnmatched
      ? null
      : selectedOption?.candidate || null
    const confidence = shouldDowngradeToUnmatched
      ? { confidenceScore: 0, confidenceLevel: 'low' }
      : initialConfidence

    return {
      matchedDomNode,
      confidenceScore: confidence.confidenceScore,
      confidenceLevel: confidence.confidenceLevel,
      matchKind,
      topCandidates: optionSet.topCandidates || [],
      debug: {
        eligibleCandidateCount: optionSet.eligibleCandidateCount,
        parentReuse: matchKind === 'reused',
        rejectedCandidateReasons: optionSet.rejectedCandidateReasons,
        assignmentMethod,
        repeatedStructure: repeatedStructureMeta
      }
    }
  }

  function assignSuggestedChildren(figmaNode, figmaChildren, browserNode, options) {
    const childEntries = figmaChildren.map(figmaChild =>
      buildSuggestedOptionsForChild(figmaNode, figmaChild, browserNode, options)
    )
    const repeatedContext = buildRepeatedSiblingGroups(figmaNode, figmaChildren)
    applyRepeatedStructureBias(childEntries, repeatedContext)
    const totalEdges = childEntries.reduce(
      (sum, entry) => sum + entry.options.length,
      0
    )

    const rawAssignments =
      figmaChildren.length <= SUGGESTED_MATCHER_CONFIG.exactAssignmentMaxChildren &&
      totalEdges <= SUGGESTED_MATCHER_CONFIG.exactAssignmentMaxEdges
        ? solveAssignmentsExact(childEntries)
        : solveAssignmentsGreedy(childEntries)

    const assignmentMethod =
      figmaChildren.length <= SUGGESTED_MATCHER_CONFIG.exactAssignmentMaxChildren &&
      totalEdges <= SUGGESTED_MATCHER_CONFIG.exactAssignmentMaxEdges
        ? 'exact'
        : 'greedy_fallback'
    const repeatedAmbiguityByIndex = buildRepeatedAmbiguityByIndex(
      childEntries,
      rawAssignments,
      repeatedContext
    )

    return rawAssignments.map((assignment, index) =>
      finalizeSuggestedAssignment(
        childEntries[index],
        assignment,
        assignmentMethod,
        repeatedAmbiguityByIndex.get(index) || null
      )
    )
  }

  function validateNodeSuggested(figmaNode, browserNode, options) {
    const {
      tolerance,
      depth,
      kind,
      figmaRootBounds,
      domRootBounds,
      unmatchedDomNodes,
      scaleContext,
      matchMeta,
      parentConfidence
    } = options

    const figmaChildren = Array.isArray(figmaNode.children)
      ? figmaNode.children.filter(child => normalizeBounds(child.bounds))
      : []

    const result = createValidationResult(
      figmaNode,
      browserNode,
      tolerance,
      browserNode ? 'matched' : 'unmatched',
      matchMeta?.debug || {
        eligibleCandidateCount: browserNode ? 1 : 0,
        parentReuse: false,
        rejectedCandidateReasons: []
      },
      {
        confidenceScore: matchMeta?.confidenceScore ?? (browserNode ? 1 : 0),
        confidenceLevel: matchMeta?.confidenceLevel ?? (browserNode ? 'high' : 'low'),
        matchKind: matchMeta?.matchKind ?? (browserNode ? 'direct' : 'unmatched'),
        topCandidates: matchMeta?.topCandidates || []
      }
    )
    const flatMatches = [
      createMatchMeta(result, browserNode, depth, kind, {
        confidenceScore: result.confidenceScore,
        confidenceLevel: result.confidenceLevel,
        matchKind: result.matchKind
      })
    ]

    if (!browserNode || figmaChildren.length === 0) {
      return { result, flatMatches }
    }

    const childAssignments = assignSuggestedChildren(figmaNode, figmaChildren, browserNode, {
      tolerance,
      figmaRootBounds,
      domRootBounds,
      scaleContext,
      candidatePool: Array.from(unmatchedDomNodes),
      parentConfidence: parentConfidence ?? result.confidenceScore
    })

    result.children = figmaChildren.map((figmaChild, index) => {
      const assignment = childAssignments[index]

      if (
        assignment.matchedDomNode &&
        assignment.matchedDomNode !== browserNode &&
        assignment.matchKind !== 'reused'
      ) {
        unmatchedDomNodes.delete(assignment.matchedDomNode)
      }

      const childValidation = validateNodeSuggested(figmaChild, assignment.matchedDomNode, {
        tolerance,
        depth: depth + 1,
        kind: 'child',
        figmaRootBounds,
        domRootBounds,
        unmatchedDomNodes,
        scaleContext,
        matchMeta: assignment,
        parentConfidence: assignment.confidenceScore
      })

      childValidation.result.debug = assignment.debug
      childValidation.flatMatches[0].mappingStatus =
        childValidation.result.mappingStatus
      childValidation.flatMatches[0].confidenceScore =
        childValidation.result.confidenceScore
      childValidation.flatMatches[0].confidenceLevel =
        childValidation.result.confidenceLevel
      childValidation.flatMatches[0].matchKind = childValidation.result.matchKind

      flatMatches.push(...childValidation.flatMatches)
      return childValidation.result
    })

    return { result, flatMatches }
  }

  // Recursive validation reuses the suggested matcher for every subtree, then
  // attaches style and text diagnostics only after the DOM pairing is stable.
  function validateContainerLayout(figmaSnapshot, containerElement, options) {
    const tolerance = options?.tolerance ?? DEFAULT_TOLERANCE

    if (!figmaSnapshot || !containerElement) {
      throw new Error('Figma snapshot and container element are required')
    }

    const figmaContainerBounds = normalizeBounds(figmaSnapshot.bounds)
    const domContainerBounds = getElementBounds(containerElement)

    if (!figmaContainerBounds || !domContainerBounds) {
      throw new Error('Container bounds are missing or invalid')
    }

    const availableDomNodes = normalizeSuggestedCandidates(
      getDomCandidates(containerElement).filter(domNode => domNode.element !== containerElement),
      tolerance
    )
    const unmatchedDomNodes = new Set(availableDomNodes)
    const scaleContext = buildScaleContext(figmaContainerBounds, domContainerBounds)
    const rootBrowserNode = extractDomNode(containerElement)

    const validation = validateNodeSuggested(
      {
        ...figmaSnapshot,
        nodeName: figmaSnapshot.nodeName || 'Container',
        bounds: figmaContainerBounds
      },
      rootBrowserNode,
      {
        tolerance,
        depth: 0,
        kind: 'container',
        figmaRootBounds: figmaContainerBounds,
        domRootBounds: domContainerBounds,
        unmatchedDomNodes,
        scaleContext,
        matchMeta: {
          confidenceScore: 1,
          confidenceLevel: 'high',
          matchKind: 'direct',
          topCandidates: [],
          debug: {
            eligibleCandidateCount: 1,
            parentReuse: false,
            rejectedCandidateReasons: [],
            assignmentMethod: 'root'
          }
        },
        parentConfidence: 1
      }
    )

    enrichStyleComparisons(validation.result, validation.flatMatches)

    return {
      strategy: 'suggested',
      result: validation.result,
      matches: validation.flatMatches
    }
  }

  window.FigmaGeometryValidator = {
    DEFAULT_TOLERANCE,
    validateContainerLayout
  }
})()
