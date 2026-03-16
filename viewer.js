document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const fileUrl = urlParams.get('file');
  const fileKey = urlParams.get('key');

  const loadingDiv = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');
  const uploadContainer = document.getElementById('upload-container');
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');
  const contentDiv = document.getElementById('content');
  const errorPlaceholder = document.getElementById('error-placeholder');
  
  const sidebar = document.getElementById('sidebar');
  const outlineContainer = document.getElementById('outline-container');
  const pageCountSpan = document.getElementById('page-count');
  const pageNumInput = document.getElementById('page-num-input');
  const docTitleSpan = document.getElementById('doc-title');
  const viewerContainer = document.getElementById('viewer');
  const notesPanel = document.getElementById('notes-panel');
  const notesText = document.getElementById('notes-text');
  const notesClearBtn = document.getElementById('notes-clear');
  const notesCollapseBtn = document.getElementById('notes-collapse');
  const notesStatus = document.getElementById('notes-status');
  const notesCount = document.getElementById('notes-count');
  
  // 新增工具栏按钮
  const toggleSidebarBtn = document.getElementById('toggle-sidebar');
  const zoomOutBtn = document.getElementById('zoom-out');
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomDisplay = document.getElementById('zoom-display');
  const actionHome = document.getElementById('action-home');
  const recentListEl = document.getElementById('recent-list');
  const recentEmptyEl = document.getElementById('recent-empty');
  const recentClearBtn = document.getElementById('recent-clear');

  // 状态变量
  let currentPdf = null;
  let totalPages = 0;
  let currentZoom = 100;
  let sidebarVisible = false;
  let currentFileBlob = null;
  let currentFileName = '';
  let currentDocKey = null;
  let saveReadingPosTimer = null;
  let activeLoadSeq = 0;
  let activeObjectUrl = null;
  let saveNotesTimer = null;

  function setNotesStatus(text) {
    if (notesStatus) notesStatus.innerText = text;
  }

  function setNotesCountText(text) {
    if (notesCount) notesCount.innerText = text;
  }

  function updateNotesCount() {
    if (!notesText) return;
    const v = notesText.value || '';
    setNotesCountText(String(v.length));
  }

  async function loadNotesForCurrentDoc() {
    if (!notesText) return;
    if (!currentDocKey) {
      notesText.value = '';
      notesText.disabled = true;
      notesText.placeholder = '打开 PDF 后可记录笔记（自动保存）';
      updateNotesCount();
      setNotesStatus('未保存');
      return;
    }

    const key = `notes:${currentDocKey}`;
    const value = await storageGet(key, '');
    notesText.disabled = false;
    notesText.placeholder = '在这里记录笔记（自动保存）';
    notesText.value = value || '';
    updateNotesCount();
    setNotesStatus('已加载');
  }

  async function saveNotesForCurrentDoc() {
    if (!notesText || !currentDocKey) return;
    const key = `notes:${currentDocKey}`;
    const value = notesText.value || '';
    await storageSet(key, value);
    setNotesStatus('已保存');
  }

  function setNotesCollapsed(collapsed) {
    if (!notesPanel || !notesCollapseBtn) return;
    notesPanel.classList.toggle('collapsed', !!collapsed);
    notesCollapseBtn.innerText = collapsed ? '展开' : '收起';
    localStorage.setItem('notes-collapsed', collapsed ? '1' : '0');
  }

  function storageGet(key, defaultValue) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ [key]: defaultValue }, (res) => {
          resolve(res[key] ?? defaultValue);
        });
      } catch (e) {
        resolve(defaultValue);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function openRecentDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('transreadPdf', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbPutPdfFile(key, file) {
    const db = await openRecentDb();
    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.put({
        key,
        name: file.name,
        type: file.type,
        blob: file,
        savedAt: Date.now()
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    });
  }

  async function idbGetPdfFile(key) {
    const db = await openRecentDb();
    return new Promise((resolve) => {
      const tx = db.transaction('files', 'readonly');
      const store = tx.objectStore('files');
      const req = store.get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  }

  function formatRelativeTime(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return '刚刚';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    return `${d} 天前`;
  }

  async function addRecentPdf(entry) {
    const list = await storageGet('recentPdfs', []);
    const key = entry.type === 'url' ? entry.url : entry.key;
    const now = Date.now();
    const normalized = {
      key,
      type: entry.type,
      name: entry.name || '',
      url: entry.url || '',
      lastOpenedAt: now
    };

    const next = [normalized, ...list.filter((x) => x && x.key !== key)];
    await storageSet('recentPdfs', next.slice(0, 30));
    await renderRecentList();
  }

  async function clearRecentList() {
    await storageSet('recentPdfs', []);
    await renderRecentList();
  }

  async function renderRecentList() {
    if (!recentListEl || !recentEmptyEl) return;
    const list = await storageGet('recentPdfs', []);
    recentListEl.innerHTML = '';

    if (!list || list.length === 0) {
      recentEmptyEl.style.display = 'block';
      return;
    }
    recentEmptyEl.style.display = 'none';

    list.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.title = item.type === 'url' ? item.url : '点击重新打开';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name || item.url || '未命名 PDF';

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatRelativeTime(item.lastOpenedAt || Date.now());

      li.appendChild(name);
      li.appendChild(meta);

      li.addEventListener('click', () => {
        if (item.type === 'url' && item.url) {
          window.location.href = `viewer.html?file=${encodeURIComponent(item.url)}`;
          return;
        }
        if (item.type === 'idb' && item.key) {
          window.location.href = `viewer.html?key=${encodeURIComponent(item.key)}`;
          return;
        }
      });

      recentListEl.appendChild(li);
    });
  }

  // 侧边栏切换
  toggleSidebarBtn.addEventListener('click', () => {
    sidebarVisible = !sidebarVisible;
    sidebar.style.display = sidebarVisible ? 'flex' : 'none';
  });

  // 缩放控制
  function updateZoom(newZoom) {
    if (newZoom < 50) newZoom = 50;
    if (newZoom > 200) newZoom = 200;
    currentZoom = newZoom;
    zoomDisplay.innerText = `${currentZoom}%`;
    
    // 更新所有页面容器的宽度和字体大小
    const containers = document.querySelectorAll('.page-container');
    containers.forEach(container => {
      container.style.width = `${700 * (currentZoom / 100)}px`;
      container.style.fontSize = `${18 * (currentZoom / 100)}px`;
    });
  }

  zoomOutBtn.addEventListener('click', () => updateZoom(currentZoom - 10));
  zoomInBtn.addEventListener('click', () => updateZoom(currentZoom + 10));

  if (notesText) {
    notesText.addEventListener('input', () => {
      setNotesStatus('未保存');
      updateNotesCount();
      if (saveNotesTimer) clearTimeout(saveNotesTimer);
      saveNotesTimer = setTimeout(() => {
        saveNotesForCurrentDoc();
      }, 500);
    });
  }

  if (notesClearBtn) {
    notesClearBtn.addEventListener('click', async () => {
      if (!notesText || notesText.disabled) return;
      if (!confirm('清空当前文档的笔记？')) return;
      notesText.value = '';
      updateNotesCount();
      await saveNotesForCurrentDoc();
    });
  }

  if (notesCollapseBtn) {
    notesCollapseBtn.addEventListener('click', () => {
      const collapsed = !!notesPanel?.classList.contains('collapsed');
      setNotesCollapsed(!collapsed);
    });
  }

  function goHome() {
    activeLoadSeq += 1;
    currentPdf = null;
    totalPages = 0;
    pageCountSpan.innerText = '0';
    pageNumInput.value = '1';
    sidebarVisible = false;
    sidebar.style.display = 'none';
    outlineContainer.innerHTML = '';
    contentDiv.innerHTML = '';
    loadingDiv.style.display = 'none';
    uploadContainer.style.display = 'block';
    errorPlaceholder.innerHTML = '';
    docTitleSpan.innerText = 'PDF 网页版';
    currentFileBlob = null;
    currentFileName = '';
    currentDocKey = null;
    loadNotesForCurrentDoc();
    fileInput.value = '';
    window.history.replaceState(null, '', 'viewer.html');

    if (activeObjectUrl) {
      try {
        URL.revokeObjectURL(activeObjectUrl);
      } catch (e) {}
      activeObjectUrl = null;
    }

    renderRecentList();
  }

  if (actionHome) {
    actionHome.addEventListener('click', () => {
      goHome();
    });
  }

  // 批注工具状态
  let currentTool = null; // 'draw'
  const toolHighlight = document.getElementById('tool-highlight');
  const toolDraw = document.getElementById('tool-draw');

  function setActiveTool(tool) {
    if (currentTool === tool) {
      currentTool = null; // Toggle off
    } else {
      currentTool = tool;
    }
    
    // 更新UI
    [toolDraw].forEach(btn => btn.classList.remove('active-tool'));
    
    if (currentTool === 'draw') toolDraw.classList.add('active-tool');

    // 启用/禁用所有页面的批注层
    document.querySelectorAll('.annotation-layer').forEach(layer => {
      if (currentTool) {
        layer.classList.add('active');
        layer.style.cursor = 'crosshair';
      } else {
        layer.classList.remove('active');
      }
    });
  }

  toolDraw.addEventListener('click', () => setActiveTool('draw'));

  // 1. 高亮功能 (基于 Selection API)
  toolHighlight.addEventListener('click', () => {
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) {
      alert('请先在页面上用鼠标选中要高亮的文本');
      return;
    }

    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    span.className = 'highlighted-text';
    
    try {
      range.surroundContents(span);
      selection.removeAllRanges();
    } catch (e) {
      console.warn("跨段落高亮暂不支持，请在同一段落内选择");
    }
  });

  // 页码跳转
  pageNumInput.addEventListener('change', (e) => {
    let pageNum = parseInt(e.target.value);
    if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
    if (pageNum > totalPages) pageNum = totalPages;
    
    pageNumInput.value = pageNum;
    
    const targetPage = document.getElementById(`page-${pageNum}`);
    if (targetPage) {
      targetPage.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // 监听滚动更新页码
  viewerContainer.addEventListener('scroll', () => {
    // 简单的节流，防止滚动时计算太频繁
    if (viewerContainer.scrollTimeout) return;
    viewerContainer.scrollTimeout = setTimeout(() => {
      const containers = document.querySelectorAll('.page-container');
      const viewerTop = viewerContainer.scrollTop;
      
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i];
        if (container.offsetTop + container.offsetHeight / 2 > viewerTop) {
          const pageNum = container.id.split('-')[1];
          if (pageNumInput.value !== pageNum && document.activeElement !== pageNumInput) {
            pageNumInput.value = pageNum;
          }
          if (currentDocKey) {
            const pageNumInt = parseInt(pageNum, 10);
            const offsetInPage = Math.max(0, viewerTop - container.offsetTop);
            if (saveReadingPosTimer) clearTimeout(saveReadingPosTimer);
            saveReadingPosTimer = setTimeout(() => {
              storageSet(`readingPos:${currentDocKey}`, {
                pageNum: pageNumInt,
                offsetInPage,
                savedAt: Date.now()
              });
            }, 250);
          }
          break;
        }
      }
      viewerContainer.scrollTimeout = null;
    }, 100);
  });

  // 主题切换逻辑
  const themeBtns = {
    'dark': document.getElementById('theme-dark'),
    'light': document.getElementById('theme-light'),
    'sepia': document.getElementById('theme-sepia')
  };

  function setTheme(themeName) {
    // 移除旧主题
    document.body.removeAttribute('data-theme');
    // 如果不是默认的 dark，则添加对应的主题属性
    if (themeName !== 'dark') {
      document.body.setAttribute('data-theme', themeName);
    }
    
    // 更新按钮状态
    Object.values(themeBtns).forEach(btn => btn.classList.remove('active'));
    if (themeBtns[themeName]) {
      themeBtns[themeName].classList.add('active');
    }

    // 保存用户的选择
    localStorage.setItem('pdf-reader-theme', themeName);
  }

  // 初始化加载上次选择的主题
  const savedTheme = localStorage.getItem('pdf-reader-theme') || 'dark';
  setTheme(savedTheme);

  // 绑定点击事件
  Object.keys(themeBtns).forEach(themeName => {
    themeBtns[themeName].addEventListener('click', () => setTheme(themeName));
  });

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  setNotesCollapsed(localStorage.getItem('notes-collapsed') === '1');
  loadNotesForCurrentDoc();
  renderRecentList();
  if (recentClearBtn) {
    recentClearBtn.addEventListener('click', () => {
      clearRecentList();
    });
  }

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      errorPlaceholder.innerHTML = '';
      const key = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      await idbPutPdfFile(key, file);
      await addRecentPdf({ type: 'idb', key, name: file.name });

      currentFileBlob = file;
      currentFileName = file.name;
      currentDocKey = `idb:${key}`;
      await loadNotesForCurrentDoc();
      docTitleSpan.innerText = file.name;
      window.history.replaceState(null, '', `viewer.html?key=${encodeURIComponent(key)}`);
      if (activeObjectUrl) {
        try {
          URL.revokeObjectURL(activeObjectUrl);
        } catch (e) {}
      }
      const objectUrl = URL.createObjectURL(file);
      activeObjectUrl = objectUrl;
      
      uploadContainer.style.display = 'none';
      loadingDiv.style.display = 'block';
      contentDiv.innerHTML = '';
      sidebar.style.display = 'none';
      outlineContainer.innerHTML = '';
      
      loadPdf(objectUrl);
    }
  });

  if (!fileUrl && !fileKey) {
    loadingDiv.style.display = 'none';
    uploadContainer.style.display = 'block';
    renderRecentList();
    return;
  }

  if (fileUrl) {
    currentDocKey = `url:${fileUrl}`;
    await loadNotesForCurrentDoc();
    try {
      const urlObj = new URL(fileUrl);
      const pathname = urlObj.pathname;
      const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
      if (filename) {
        docTitleSpan.innerText = decodeURIComponent(filename);
        currentFileName = decodeURIComponent(filename);
      } else {
        currentFileName = 'document.pdf';
      }
    } catch (e) {
      currentFileName = 'document.pdf';
    }
    await addRecentPdf({ type: 'url', url: fileUrl, name: docTitleSpan.innerText });
    uploadContainer.style.display = 'none';
    loadingDiv.style.display = 'block';
    loadPdf(fileUrl);
  } else if (fileKey) {
    currentDocKey = `idb:${fileKey}`;
    await loadNotesForCurrentDoc();
    uploadContainer.style.display = 'none';
    loadingDiv.style.display = 'block';
    contentDiv.innerHTML = '';
    const record = await idbGetPdfFile(fileKey);
    if (!record || !record.blob) {
      loadingDiv.style.display = 'none';
      uploadContainer.style.display = 'block';
      errorPlaceholder.innerHTML = '<div class="error-msg">找不到该 PDF 记录，可能已被清理。请重新上传。</div>';
      renderRecentList();
      return;
    }
    currentFileBlob = record.blob;
    currentFileName = record.name || 'document.pdf';
    docTitleSpan.innerText = currentFileName;
    await addRecentPdf({ type: 'idb', key: fileKey, name: currentFileName });
    if (activeObjectUrl) {
      try {
        URL.revokeObjectURL(activeObjectUrl);
      } catch (e) {}
    }
    const objectUrl = URL.createObjectURL(record.blob);
    activeObjectUrl = objectUrl;
    loadPdf(objectUrl);
  }

  async function loadPdf(url) {
    const loadSeq = ++activeLoadSeq;
    // 矩阵乘法辅助函数 (m1 * m2)
    function multiply(m1, m2) {
      const result = new Float32Array(6);
      result[0] = m1[0] * m2[0] + m1[1] * m2[2];
      result[1] = m1[0] * m2[1] + m1[1] * m2[3];
      result[2] = m1[2] * m2[0] + m1[3] * m2[2];
      result[3] = m1[2] * m2[1] + m1[3] * m2[3];
      result[4] = m1[4] * m2[0] + m1[5] * m2[2] + m2[4];
      result[5] = m1[4] * m2[1] + m1[5] * m2[3] + m2[5];
      return result;
    }

    // 从页面操作列表提取图片
    async function extractImages(page, viewport) {
      const operatorList = await page.getOperatorList();
      const fnArray = operatorList.fnArray;
      const argsArray = operatorList.argsArray;
      
      const images = [];
      let currentMatrix = [1, 0, 0, 1, 0, 0]; // 初始变换矩阵
      const stateStack = [];

      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];

        if (fn === pdfjsLib.OPS.save) {
          stateStack.push([...currentMatrix]);
        } else if (fn === pdfjsLib.OPS.restore) {
          if (stateStack.length > 0) {
            currentMatrix = stateStack.pop();
          }
        } else if (fn === pdfjsLib.OPS.transform) {
          // args: [a, b, c, d, e, f]
          // currentMatrix = args * currentMatrix (注意乘法顺序，PDF spec是 args x CTM)
          currentMatrix = multiply(currentMatrix, args);
        } else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintJpegXObject) {
          const imgId = args[0];
          // 图片位置：(0, 0) 在 currentMatrix 变换后的坐标
          // PDF坐标系是左下角原点，Y轴向上。viewport是左上角原点，Y轴向下。
          // currentMatrix[5] 是 Y 平移量。
          // 我们需要的是图片在 viewport 中的视觉 Y 坐标（顶部）。
          // 由于 PDF 图片通常是 1x1 矩形被缩放，其 top edge 在 PDF 空间是 y=1 (如果未翻转)
          // 简单起见，我们取变换后的 (0, 1) 点的 Y 坐标作为图片的顶部位置
          
          // 计算变换后的点 (0, 1) -> 图片顶部 (假设没有旋转)
          const x = currentMatrix[4];
          const y = currentMatrix[5] + currentMatrix[3]; // y + scaleY
          
          // 转换为 viewport 坐标
          const viewPos = viewport.convertToViewportPoint(x, y);
          
          images.push({
            type: 'image',
            id: imgId,
            y: viewPos[1], // 视觉上的 Y 坐标
            x: viewPos[0],
            width: currentMatrix[0], // 近似宽度
            height: currentMatrix[3] // 近似高度
          });
        }
      }
      return images;
    }

    try {
      if (loadSeq !== activeLoadSeq) return;
      loadingText.innerText = '正在解析 PDF，请稍候...';
      const loadingTask = pdfjsLib.getDocument(url);
      
      loadingTask.onProgress = function (progress) {
        const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;
        if (percent > 0) {
          loadingText.innerText = `正在下载 PDF... ${percent}%`;
        }
      };

      const pdf = await loadingTask.promise;
      if (loadSeq !== activeLoadSeq) return;
      currentPdf = pdf;
      totalPages = pdf.numPages;
      pageCountSpan.innerText = totalPages;

      await renderOutline(pdf);
      if (loadSeq !== activeLoadSeq) return;

      const restorePos = currentDocKey ? await storageGet(`readingPos:${currentDocKey}`, null) : null;
      let restored = false;

      // 逐页解析，恢复流式排版
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        if (loadSeq !== activeLoadSeq) return;
        loadingText.innerText = `正在渲染第 ${pageNum} / ${pdf.numPages} 页...`;
        const page = await pdf.getPage(pageNum);
        if (loadSeq !== activeLoadSeq) return;
        const viewport = page.getViewport({ scale: 1.0 }); // 用于坐标转换
        const textContent = await page.getTextContent();
        let extractedImages = [];
        try {
          extractedImages = await extractImages(page, viewport);
        } catch (e) {
          extractedImages = [];
        }
        if (loadSeq !== activeLoadSeq) return;

        // 创建页面容器
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page-container';
        pageContainer.id = `page-${pageNum}`;

        if (extractedImages.length > 0) {
          renderPageCanvas(page, pageContainer);
        }
        
        // 1. 提取文本段落
        const paragraphs = [];
        let currentParagraph = '';
        let lastItem = null;
        let paragraphY = 0; // 记录段落起始 Y 坐标

        textContent.items.forEach(item => {
          const text = item.str.trim();
          if (!text) return;

          // 计算当前项的视觉 Y 坐标
          const itemY = viewport.convertToViewportPoint(item.transform[4], item.transform[5])[1];

          if (lastItem) {
            const lastY = viewport.convertToViewportPoint(lastItem.transform[4], lastItem.transform[5])[1];
            const height = item.height || 10; // 默认行高

            // 判断换段落 (Y 差值超过 1.5 倍行高)
            const isNewParagraph = Math.abs(itemY - lastY) > (height * 1.5);
            
            if (isNewParagraph) {
              if (currentParagraph) {
                paragraphs.push({
                  type: 'text',
                  text: currentParagraph,
                  y: paragraphY
                });
              }
              currentParagraph = item.str;
              paragraphY = itemY;
            } else {
              if (currentParagraph.endsWith('-')) {
                currentParagraph = currentParagraph.slice(0, -1) + item.str;
              } else {
                currentParagraph += ' ' + item.str;
              }
            }
          } else {
            currentParagraph = item.str;
            paragraphY = itemY;
          }
          lastItem = item;
        });
        
        if (currentParagraph) {
          paragraphs.push({
            type: 'text',
            text: currentParagraph,
            y: paragraphY
          });
        }

        // 2. 合并文本和图片，按 Y 坐标排序
        const allItems = [...paragraphs, ...extractedImages].sort((a, b) => a.y - b.y);

        // 3. 渲染合并后的内容
        for (const item of allItems) {
          if (item.type === 'text') {
            renderParagraph(item.text, pageContainer);
          } else if (item.type === 'image') {
            renderImage(item.id, page, pageContainer);
          }
        }

        // 将页码放在最后
        const pageNumDiv = document.createElement('div');
        pageNumDiv.className = 'page-number';
        pageNumDiv.innerText = `${pageNum} / ${pdf.numPages}`;
        pageContainer.appendChild(pageNumDiv);
        
        // 添加批注层... (保持原有逻辑)
        addAnnotationLayer(pageContainer);

        contentDiv.appendChild(pageContainer);

        if (pageNum === 1) {
          loadingDiv.style.display = 'none';
        }

        if (!restored && restorePos && restorePos.pageNum === pageNum) {
          restored = true;
          const offset = typeof restorePos.offsetInPage === 'number' ? restorePos.offsetInPage : 0;
          pageNumInput.value = String(pageNum);
          requestAnimationFrame(() => {
            viewerContainer.scrollTop = pageContainer.offsetTop + offset;
          });
        }
      }
    } catch (error) {
      console.error('Error loading PDF:', error);
      loadingDiv.style.display = 'none';
      uploadContainer.style.display = 'block';
      
      let errorHtml = `<b>自动读取失败</b><br>原因可能是：跨域限制 (CORS)、当前页面并非真实的 PDF 文件，或者插件没有读取本地文件的权限。`;
      errorPlaceholder.innerHTML = `<div class="error-msg">${errorHtml}</div>`;
    }
  }

  // 渲染段落辅助函数
  function renderParagraph(text, container) {
    if (!text.trim()) return;
    
    let cleanText = text.replace(/-\s+/g, '').replace(/\s{2,}/g, ' ');

    const block = document.createElement('div');
    block.className = 'paragraph-block';
    
    const enDiv = document.createElement('div');
    enDiv.className = 'en-text';
    enDiv.setAttribute('translate', 'no');
    enDiv.classList.add('notranslate');
    enDiv.innerText = cleanText;
    
    const zhDiv = document.createElement('div');
    zhDiv.className = 'zh-text';
    zhDiv.innerText = cleanText;

    block.appendChild(enDiv);
    block.appendChild(zhDiv);
    container.appendChild(block);
  }

  function renderPageCanvas(page, container) {
    const wrapper = document.createElement('div');
    wrapper.style.textAlign = 'center';
    wrapper.style.margin = '10px 0 24px 0';

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.borderRadius = '6px';
    canvas.style.boxShadow = '0 2px 10px rgba(0,0,0,0.25)';

    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    try {
      const scale = 1.6;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      page.render({ canvasContext: ctx, viewport }).promise.catch(() => {
        wrapper.remove();
      });
    } catch (e) {
      wrapper.remove();
    }
  }

  // 渲染图片辅助函数（异步加载，不阻塞文本渲染）
  function renderImage(imgId, page, container) {
    const imgWrapper = document.createElement('div');
    imgWrapper.style.textAlign = 'center';
    imgWrapper.style.margin = '20px 0';
    container.appendChild(imgWrapper);

    const timeoutMs = 1500;
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      imgWrapper.remove();
    }, timeoutMs);

    const normalizeToNode = (img) => {
      if (!img) return null;

      if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
        return img;
      }

      if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return canvas;
      }

      if (typeof ImageData !== 'undefined' && img instanceof ImageData) {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(img, 0, 0);
        return canvas;
      }

      if (img && typeof img.width === 'number' && typeof img.height === 'number' && img.data) {
        try {
          const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.putImageData(imageData, 0, 0);
          return canvas;
        } catch (e) {
          return null;
        }
      }

      return null;
    };

    try {
      page.objs.get(imgId, (img) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);

        const node = normalizeToNode(img);
        if (!node) {
          imgWrapper.remove();
          return;
        }

        node.style.maxWidth = '100%';
        node.style.height = 'auto';
        node.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
        imgWrapper.appendChild(node);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      imgWrapper.remove();
    }
  }

  // 添加批注层辅助函数
  function addAnnotationLayer(pageContainer) {
         // 添加批注层和绘图层
         const annotationLayer = document.createElement('div');
         annotationLayer.className = 'annotation-layer';
         
         const drawCanvas = document.createElement('canvas');
         drawCanvas.style.position = 'absolute';
         drawCanvas.style.top = '0';
         drawCanvas.style.left = '0';
         drawCanvas.style.width = '100%';
         drawCanvas.style.height = '100%';
         drawCanvas.style.pointerEvents = 'none';
         drawCanvas.style.zIndex = '1';
         
         // 自由绘制逻辑
         let isDrawing = false;
         let ctx = drawCanvas.getContext('2d');

         function setupCtx() {
           ctx = drawCanvas.getContext('2d');
           const dpr = window.devicePixelRatio || 1;
           ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
           ctx.strokeStyle = '#ffeb3b';
           ctx.lineWidth = 4;
           ctx.lineCap = 'round';
           ctx.lineJoin = 'round';
         }

         function resizeCanvasPreserve() {
           const dpr = window.devicePixelRatio || 1;
           const cssW = Math.max(1, pageContainer.clientWidth);
           const cssH = Math.max(1, pageContainer.clientHeight);
           const nextW = Math.round(cssW * dpr);
           const nextH = Math.round(cssH * dpr);

           if (drawCanvas.width === nextW && drawCanvas.height === nextH) {
             setupCtx();
             return;
           }

           const prev = document.createElement('canvas');
           prev.width = drawCanvas.width || 1;
           prev.height = drawCanvas.height || 1;
           const prevCtx = prev.getContext('2d');
           try {
             prevCtx.drawImage(drawCanvas, 0, 0);
           } catch (e) {}

           drawCanvas.width = nextW;
           drawCanvas.height = nextH;
           setupCtx();

           try {
             ctx.setTransform(1, 0, 0, 1, 0, 0);
             ctx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, nextW, nextH);
           } catch (e) {}
           setupCtx();
         }

         resizeCanvasPreserve();
         let ro = null;
         if (typeof ResizeObserver !== 'undefined') {
           ro = new ResizeObserver(() => {
             resizeCanvasPreserve();
           });
           try {
             ro.observe(pageContainer);
           } catch (e) {}
         }
 
         annotationLayer.addEventListener('mousedown', (e) => {
           if (currentTool !== 'draw') return;
           isDrawing = true;
           const rect = annotationLayer.getBoundingClientRect();
           ctx.beginPath();
           ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
         });
 
         annotationLayer.addEventListener('mousemove', (e) => {
           if (!isDrawing || currentTool !== 'draw') return;
           const rect = annotationLayer.getBoundingClientRect();
           ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
           ctx.stroke();
         });
 
         annotationLayer.addEventListener('mouseup', () => {
           isDrawing = false;
         });
 
         annotationLayer.addEventListener('mouseleave', () => {
           isDrawing = false;
         });
 
         pageContainer.appendChild(drawCanvas);
         pageContainer.appendChild(annotationLayer);
  }
// 渲染侧边栏目录函数
  async function renderOutline(pdf) {
    try {
      const outline = await pdf.getOutline();
      if (!outline || outline.length === 0) {
        // 如果没有目录，禁用侧边栏按钮
        toggleSidebarBtn.style.opacity = '0.5';
        toggleSidebarBtn.style.pointerEvents = 'none';
        return;
      }

      // 默认显示侧边栏
      sidebarVisible = true;
      sidebar.style.display = 'flex';

      const renderItems = (items, container) => {
        const ul = document.createElement('ul');
        items.forEach(item => {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.innerText = item.title;
          
          a.onclick = async () => {
            let dest = item.dest;
            if (typeof dest === 'string') {
              dest = await pdf.getDestination(dest);
            }
            if (dest) {
              try {
                const pageIndex = await pdf.getPageIndex(dest[0]);
                const pageNum = pageIndex + 1;
                const pageElement = document.getElementById(`page-${pageNum}`);
                if (pageElement) {
                  pageElement.scrollIntoView({ behavior: 'smooth' });
                }
              } catch (e) {}
            }
          };
          li.appendChild(a);
          
          if (item.items && item.items.length > 0) {
            renderItems(item.items, li);
          }
          ul.appendChild(li);
        });
        container.appendChild(ul);
      };

      renderItems(outline, outlineContainer);
    } catch (e) {}
  }
});
