chrome.action.onClicked.addListener((tab) => {
  let viewerUrl = chrome.runtime.getURL('viewer.html');
  // 如果当前页面链接包含 .pdf，则尝试自动加载它
  if (tab.url && tab.url.toLowerCase().includes('.pdf')) {
    viewerUrl += `?file=${encodeURIComponent(tab.url)}`;
  }
  // 否则只打开转换页面，让用户手动上传
  chrome.tabs.create({ url: viewerUrl });
});
