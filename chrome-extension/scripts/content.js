// Get Figma snapshot
async function getFigmaSnapshot () {
  return new Promise(resolve => {
    chrome.storage.local.get(['figmaSnapshot'], result => {
      resolve(result.figmaSnapshot || null)
    })
  })
}

function getBrowserSnapshot (el) {
  const cs = window.getComputedStyle(el)

  return {
    spacing: {
      marginTop: parseFloat(cs.marginTop),
      marginRight: parseFloat(cs.marginRight),
      marginBottom: parseFloat(cs.marginBottom),
      marginLeft: parseFloat(cs.marginLeft),
      paddingTop: parseFloat(cs.paddingTop),
      paddingRight: parseFloat(cs.paddingRight),
      paddingBottom: parseFloat(cs.paddingBottom),
      paddingLeft: parseFloat(cs.paddingLeft)
    },
    typography: {
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseFloat(cs.fontWeight),
      lineHeight: isNaN(parseFloat(cs.lineHeight))
        ? cs.lineHeight
        : parseFloat(cs.lineHeight)
    },
    colors: {
      text: cssRgbToObject(cs.color),
      background: cssRgbToObject(cs.backgroundColor)
    },
    border: {
      radius: parseFloat(cs.borderRadius) || 0
    }
  }
}

// Utility functions for colors
function rgbObjectToCss (color) {
  if (!color) return '—'
  const { r, g, b } = color
  return `rgb(${r}, ${g}, ${b})`
}

function cssRgbToObject (rgbString) {
  if (!rgbString) return null

  const match = rgbString.match(/\d+/g)
  if (!match) return null

  const [r, g, b] = match.map(Number)

  return { r, g, b }
}

// Renderer
function renderOverlayTable (result) {
  // Remove old overlay if exists
  const existing = document.getElementById('figma-validator-overlay-table')
  if (existing) existing.remove()

  const container = document.createElement('div')
  container.id = 'figma-validator-overlay-table'

  container.style.position = 'fixed'
  container.style.top = '16px'
  container.style.right = '16px'
  container.style.zIndex = '999999'
  container.style.color = '#fff'
  container.style.padding = '12px 14px'
  container.style.borderRadius = '8px'
  container.style.fontSize = '12px'
  container.style.fontFamily = 'monospace'
  container.style.maxWidth = '340px'
  container.style.boxShadow = '0 8px 24px rgba(0,0,0,0.3)'
  container.style.backdropFilter = 'blur(6px)'
  container.style.background = 'rgba(0,0,0,0.85)'
  container.style.pointerEvents = 'auto'

  const header = document.createElement('div')
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  header.style.marginBottom = '6px'

  const title = document.createElement('div')
  title.style.fontWeight = 'bold'
  title.textContent = 'Figma Validator'

  const closeBtn = document.createElement('div')
  closeBtn.textContent = '✕'
  closeBtn.style.cursor = 'pointer'
  closeBtn.style.opacity = '0.7'
  closeBtn.style.fontSize = '14px'

  closeBtn.onmouseenter = () => (closeBtn.style.opacity = '1')
  closeBtn.onmouseleave = () => (closeBtn.style.opacity = '0.7')

  closeBtn.onclick = () => {
    // remove highlight from last element
    if (lastElement.element && lastElement.element.style) {
      lastElement.element.style.outline = lastElement.style.outline
      lastElement.element.style.outlineOffset = lastElement.style.outlineOffset
    }

    // reset state
    lastElement = { element: null, style: {} }

    // remove overlay
    container.remove()
  }

  header.appendChild(title)
  header.appendChild(closeBtn)

  const summary = document.createElement('div')
  summary.style.marginBottom = '8px'
  summary.style.opacity = '0.9'
  summary.innerHTML = `
    Matches: ${result.matches.count} &nbsp; | &nbsp;
    Mismatches: ${result.mismatches.count}
  `

  // Helper to format values
  const formatVal = val => (typeof val === 'object' ? rgbObjectToCss(val) : val)

  // Table
  const table = document.createElement('table')
  table.style.width = '100%'
  table.style.borderCollapse = 'collapse'
  table.style.fontSize = '11px'

  // Header row
  const headerRow = document.createElement('tr')
  ;['Property', 'Figma', 'Browser', ''].forEach(text => {
    const th = document.createElement('th')
    th.textContent = text
    th.style.textAlign = 'left'
    th.style.padding = '4px'
    th.style.borderBottom = '1px solid rgba(255,255,255,0.15)'
    th.style.fontWeight = '600'
    headerRow.appendChild(th)
  })
  table.appendChild(headerRow)

  // Helper to create a row
  const createRow = (property, figmaVal, browserVal, isMatch, index) => {
    const row = document.createElement('tr')

    // zebra background
    if (index % 2 === 0) {
      row.style.background = 'rgba(255,255,255,0.03)'
    }

    const prop = document.createElement('td')
    prop.textContent = property
    prop.style.borderRight = '1px solid rgba(255,255,255,0.08)'

    const figma = document.createElement('td')
    figma.textContent = formatVal(figmaVal)
    figma.style.textAlign = 'right'

    const browser = document.createElement('td')
    browser.textContent = formatVal(browserVal)
    browser.style.textAlign = 'right'

    const status = document.createElement('td')
    status.textContent = isMatch ? '✔' : '❌'
    status.style.color = isMatch ? '#4ade80' : '#f87171'
    status.style.opacity = '0.85'
    ;[prop, figma, browser, status].forEach(td => {
      td.style.padding = '3px 4px'
      td.style.verticalAlign = 'top'
      row.appendChild(td)
    })

    return row
  }

  let rowIndex = 0

  // Mismatches first (higher priority)
  Object.entries(result.mismatches.properties).forEach(([key, value]) => {
    const row = createRow(key, value.figma, value.browser, false, rowIndex++)
    row.style.color = 'rgba(251, 12, 12, 0.86)'
    table.appendChild(row)
  })

  // Then matches
  Object.entries(result.matches.properties).forEach(([key, value]) => {
    const row = createRow(key, value, value, true, rowIndex++)
    row.style.color = 'rgba(12, 251, 20, 0.86)'
    row.style.opacity = '0.85'
    table.appendChild(row)
  })

  container.appendChild(header)
  container.appendChild(summary)
  container.appendChild(table)

  document.body.appendChild(container)
}

// comparison logic
function isEqual (a, b, tolerance = 0.5) {
  if (a == null || b == null) return false

  // Numbers (fontSize, radius, spacing)
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= tolerance
  }

  // Strings (fontWeight sometimes, lineHeight = "normal")
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b
  }

  // Objects (colors)
  if (typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])

    for (const key of keys) {
      if (typeof a[key] === 'number' && typeof b[key] === 'number') {
        if (Math.abs(a[key] - b[key]) > tolerance) {
          return false
        }
      } else {
        if (a[key] !== b[key]) {
          return false
        }
      }
    }

    return true
  }

  return false
}

function compareSnapshots (figma, browser) {
  if (!figma || !browser) return

  const result = Object.entries(figma || {}).reduce(
    (acc, [key, value]) => {
      Object.entries(value).forEach(([property, cssValue]) => {
        const browserValue = browser[key]?.[property]
        if (isEqual(cssValue, browserValue)) {
          acc.matches.count++
          acc.matches.properties[property] = cssValue
        } else {
          acc.mismatches.count++
          acc.mismatches.properties[property] = {
            figma: cssValue,
            browser: browserValue
          }
        }
      })
      return acc
    },
    {
      matches: {
        count: 0,
        properties: {}
      },
      mismatches: {
        count: 0,
        properties: {}
      }
    }
  )

  return result
}

let lastElement = { element: null, style: {} }
// click listener
document.addEventListener('click', async event => {
  if (!event.shiftKey || event.target.id === 'figma-validator-overlay') return

  const figmaSnapshot = await getFigmaSnapshot()

  const el = event.target

  if (!lastElement.element) {
    lastElement = {
      element: el,
      style: {
        outline: el.style.outline,
        outlineOffset: el.style.outlineOffset
      }
    }
  } else {
    if (lastElement.element && lastElement.element.style) {
      lastElement.element.style.outline = lastElement.style.outline
      lastElement.element.style.outlineOffset = lastElement.style.outlineOffset
    }

    lastElement = {
      element: el,
      style: {
        outline: el.style.outline,
        outlineOffset: el.style.outlineOffset
      }
    }
  }
  el.style.outline = '2px solid #3b82f6'
  el.style.outlineOffset = '2px'

  const browserSnapshot = getBrowserSnapshot(el)

  if (!figmaSnapshot) {
    renderOverlayTable({
      matches: { count: 0, properties: {} },
      mismatches: {
        count: 0,
        properties: {
          error: {
            figma: 'No selection in Figma',
            browser: 'Shift+Click after selecting element in Figma'
          }
        }
      }
    })
    return
  }

  const result = compareSnapshots(figmaSnapshot, browserSnapshot)
  renderOverlayTable(result)
})

window.addEventListener('message', event => {
  if (event.data?.source === 'figma-validator') {
    chrome.storage.local.set({
      figmaSnapshot: event.data.payload
    })
  }
})
