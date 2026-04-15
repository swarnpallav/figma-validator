chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'FIGMA_VALIDATOR_CAPTURE_VISIBLE_TAB') {
    return undefined
  }

  if (!sender.tab?.windowId) {
    sendResponse({
      ok: false,
      error: 'Unable to resolve the active browser window for capture.'
    })
    return undefined
  }

  chrome.tabs.captureVisibleTab(
    sender.tab.windowId,
    {
      format: 'png'
    },
    dataUrl => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({
          ok: false,
          error:
            chrome.runtime.lastError?.message ||
            'Visible-tab capture failed.'
        })
        return
      }

      sendResponse({
        ok: true,
        dataUrl
      })
    }
  )

  return true
})
