chrome.action.onClicked.addListener((tab) => {
  let viewerUrl = chrome.runtime.getURL('viewer.html');
  // 如果当前页面链接包含 .pdf，则尝试自动加载它
  if (tab.url && tab.url.toLowerCase().includes('.pdf')) {
    viewerUrl += `?file=${encodeURIComponent(tab.url)}`;
  }
  // 否则只打开转换页面，让用户手动上传
  chrome.tabs.create({ url: viewerUrl });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'EXPORT_TO_PDF') return;

  const tabId = message.tabId ?? sender?.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, error: '找不到当前标签页' });
    return;
  }

  const target = { tabId };
  const protocolVersion = '1.3';

  const safeDetach = (cb) => {
    chrome.debugger.detach(target, () => cb());
  };

  chrome.debugger.attach(target, protocolVersion, () => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    chrome.debugger.sendCommand(target, 'Page.enable', {}, () => {
      if (chrome.runtime.lastError) {
        safeDetach(() => {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        });
        return;
      }

      chrome.debugger.sendCommand(
        target,
        'Page.printToPDF',
        {
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false
        },
        (result) => {
          const err = chrome.runtime.lastError?.message;
          safeDetach(() => {
            if (err) {
              sendResponse({ ok: false, error: err });
              return;
            }
            if (!result || !result.data) {
              sendResponse({ ok: false, error: '导出失败：没有返回 PDF 数据' });
              return;
            }
            sendResponse({ ok: true, data: result.data });
          });
        }
      );
    });
  });

  return true;
});
