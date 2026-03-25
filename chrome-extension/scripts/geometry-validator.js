;(function () {
  const DEFAULT_TOLERANCE = 2
  // Mapping is intentionally conservative: if a DOM node is not close enough to
  // the projected Figma box, we prefer "unmatched" over a misleading pairing.
  const ELIGIBILITY_THRESHOLDS = {
    widthDeltaRatio: 0.35,
    heightDeltaRatio: 0.35,
    centerOffsetRatioX: 0.4,
    centerOffsetRatioY: 0.4,
    minOverlapRatio: 0.01,
    minAbsoluteDelta: 6,
    minCenterOffset: 8
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
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

  function extractDomNode(element) {
    const bounds = getElementBounds(element)
    if (!bounds) return null

    return {
      element,
      nodeName: element.getAttribute('aria-label') || element.tagName.toLowerCase(),
      bounds
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
      // Inner SVG nodes are usually implementation details of a copied icon.
      // Matching those directly creates noise, so only the outer icon wrapper
      // participates in mapping.
      if (isIgnoredSvgChild(element)) return

      const candidate = extractDomNode(element)
      if (candidate) {
        candidates.push(candidate)
      }
    })

    return candidates
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

  function compareDimension(figmaValue, browserValue, tolerance) {
    if (!isFiniteNumber(figmaValue) || !isFiniteNumber(browserValue)) {
      return false
    }

    return Math.abs(figmaValue - browserValue) <= tolerance
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

  function scoreCandidate(figmaProjectedBounds, candidateBounds) {
    const figmaCenter = getCenter(figmaProjectedBounds)
    const domCenter = getCenter(candidateBounds)

    const positionDelta =
      Math.abs(figmaCenter.x - domCenter.x) + Math.abs(figmaCenter.y - domCenter.y)
    const sizeDelta =
      Math.abs(figmaProjectedBounds.width - candidateBounds.width) +
      Math.abs(figmaProjectedBounds.height - candidateBounds.height)

    return positionDelta + sizeDelta
  }

  function classifyCandidateRejection(figmaProjectedBounds, candidateBounds, thresholds) {
    const figmaCenter = getCenter(figmaProjectedBounds)
    const candidateCenter = getCenter(candidateBounds)
    const widthTolerance = Math.max(
      figmaProjectedBounds.width * thresholds.widthDeltaRatio,
      thresholds.minAbsoluteDelta
    )
    const heightTolerance = Math.max(
      figmaProjectedBounds.height * thresholds.heightDeltaRatio,
      thresholds.minAbsoluteDelta
    )
    const centerXTolerance = Math.max(
      figmaProjectedBounds.width * thresholds.centerOffsetRatioX,
      thresholds.minCenterOffset
    )
    const centerYTolerance = Math.max(
      figmaProjectedBounds.height * thresholds.centerOffsetRatioY,
      thresholds.minCenterOffset
    )

    const reasons = []

    if (
      Math.abs(figmaProjectedBounds.width - candidateBounds.width) > widthTolerance
    ) {
      reasons.push('width_delta')
    }

    if (
      Math.abs(figmaProjectedBounds.height - candidateBounds.height) > heightTolerance
    ) {
      reasons.push('height_delta')
    }

    if (Math.abs(figmaCenter.x - candidateCenter.x) > centerXTolerance) {
      reasons.push('center_x')
    }

    if (Math.abs(figmaCenter.y - candidateCenter.y) > centerYTolerance) {
      reasons.push('center_y')
    }

    if (
      getOverlapRatio(figmaProjectedBounds, candidateBounds) <
      thresholds.minOverlapRatio
    ) {
      reasons.push('overlap')
    }

    return reasons
  }

  function filterEligibleCandidates(figmaNode, candidatePool, figmaRootBounds, domRootBounds, preferredParentElement) {
    const figmaRelativeBounds = toRelativeBounds(figmaNode.bounds, figmaRootBounds)
    const figmaProjectedBounds = toAbsoluteBounds(figmaRelativeBounds, domRootBounds)
    const thresholds = ELIGIBILITY_THRESHOLDS
    // If the parent mapped successfully, children first try to stay inside that
    // DOM subtree. This reduces cross-branch matches in dense layouts.
    const descendantPool = preferredParentElement
      ? candidatePool.filter(candidate =>
          isDescendantOf(candidate.element, preferredParentElement)
        )
      : []
    const scopedPool = descendantPool.length > 0 ? descendantPool : candidatePool
    const eligibleCandidates = []
    const rejectedCandidates = []

    scopedPool.forEach(candidate => {
      const reasons = classifyCandidateRejection(
        figmaProjectedBounds,
        candidate.bounds,
        thresholds
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

  function chooseBestCandidate(figmaProjectedBounds, eligibleCandidates) {
    let bestMatch = null
    let bestScore = Number.POSITIVE_INFINITY

    // Scoring only happens after eligibility filtering. At this point we are
    // picking the best plausible candidate, not the least bad overall node.
    eligibleCandidates.forEach(candidate => {
      const score = scoreCandidate(figmaProjectedBounds, candidate.bounds)

      if (score < bestScore) {
        bestScore = score
        bestMatch = candidate
      }
    })

    return bestMatch
  }

  function createValidationResult(figmaNode, browserNode, tolerance, mappingStatus, debug) {
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

    return {
      nodeName: figmaNode.nodeName,
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
  }

  function createMatchMeta(result, browserNode, depth, kind) {
    return {
      nodeName: result.nodeName,
      status: result.status,
      mappingStatus: result.mappingStatus,
      element: browserNode?.element ?? null,
      depth,
      kind
    }
  }

  function validateNode(figmaNode, browserNode, options) {
    const {
      tolerance,
      depth,
      kind,
      figmaRootBounds,
      domRootBounds,
      unmatchedDomNodes
    } = options

    const figmaChildren = Array.isArray(figmaNode.children)
      ? figmaNode.children.filter(child => normalizeBounds(child.bounds))
      : []

    const result = createValidationResult(
      figmaNode,
      browserNode,
      tolerance,
      browserNode ? 'matched' : 'unmatched',
      {
        eligibleCandidateCount: 0,
        parentReuse: false,
        rejectedCandidateReasons: []
      }
    )
    const flatMatches = [createMatchMeta(result, browserNode, depth, kind)]

    if (!browserNode || figmaChildren.length === 0) {
      return { result, flatMatches }
    }

    result.children = figmaChildren.map(figmaChild => {
      const shouldReuseParentMatch =
        browserNode &&
        boundsRoughlyEqual(figmaChild.bounds, figmaNode.bounds, tolerance) &&
        boundsRoughlyEqual(figmaChild.bounds, browserNode.bounds, tolerance)

      let matchedDomNode = null
      let debug = {
        eligibleCandidateCount: 0,
        parentReuse: shouldReuseParentMatch,
        rejectedCandidateReasons: []
      }

      if (shouldReuseParentMatch) {
        // Wrapper reuse is reserved for near-identical parent/child bounds. It
        // helps with Figma instance wrappers that collapse to one DOM element.
        matchedDomNode = browserNode
      } else {
        const eligibility = filterEligibleCandidates(
          figmaChild,
          Array.from(unmatchedDomNodes),
          figmaRootBounds,
          domRootBounds,
          browserNode?.element
        )

        matchedDomNode = chooseBestCandidate(
          eligibility.figmaProjectedBounds,
          eligibility.eligibleCandidates
        )
        debug = {
          eligibleCandidateCount: eligibility.eligibleCandidates.length,
          parentReuse: false,
          rejectedCandidateReasons: eligibility.rejectedCandidates
            .slice(0, 5)
            .map(entry => entry.reasons.join(','))
        }
      }

      if (matchedDomNode && matchedDomNode !== browserNode) {
        unmatchedDomNodes.delete(matchedDomNode)
      }

      const childValidation = validateNode(figmaChild, matchedDomNode, {
        tolerance,
        depth: depth + 1,
        kind: 'child',
        figmaRootBounds,
        domRootBounds,
        unmatchedDomNodes
      })

      childValidation.result.debug = debug
      childValidation.flatMatches[0].mappingStatus = childValidation.result.mappingStatus

      flatMatches.push(...childValidation.flatMatches)
      return childValidation.result
    })

    return { result, flatMatches }
  }

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

    const availableDomNodes = getDomCandidates(containerElement).filter(
      domNode => domNode.element !== containerElement
    )
    // Siblings compete for the same pool so one DOM node cannot silently map to
    // multiple Figma siblings unless parent reuse explicitly allows it.
    const unmatchedDomNodes = new Set(availableDomNodes)

    const validation = validateNode(
      {
        ...figmaSnapshot,
        nodeName: figmaSnapshot.nodeName || 'Container',
        bounds: figmaContainerBounds
      },
      {
        element: containerElement,
        bounds: domContainerBounds
      },
      {
        tolerance,
        depth: 0,
        kind: 'container',
        figmaRootBounds: figmaContainerBounds,
        domRootBounds: domContainerBounds,
        unmatchedDomNodes
      }
    )

    return {
      result: validation.result,
      matches: validation.flatMatches
    }
  }

  window.FigmaGeometryValidator = {
    DEFAULT_TOLERANCE,
    validateContainerLayout
  }
})()
