import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface CodeBlock {
    path: string;
    start_line: number;
    end_line: number;
    x: number;
    y: number;
    w: number;
    h: number;
}

interface CodeMapData {
    page_name: string;
    codeMap: { [key: string]: CodeBlock };
    arrows?: Array<{
        from: { block: string; line: number };
        to: { block: string; line: number };
    }>;
}

export function activate(context: vscode.ExtensionContext) {
    // 获取工作区根目录
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('请先打开一个工作区');
        return;
    }

    const jsonFilePath = path.join(workspaceRoot, 'CodeMapFree.json');
    let currentPanel: vscode.WebviewPanel | undefined = undefined;

    // 读取JSON文件
    function loadCodeMap(): CodeMapData {
        try {
            if (fs.existsSync(jsonFilePath)) {
                const content = fs.readFileSync(jsonFilePath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (error) {
            console.error('读取CodeMapFree.json失败:', error);
        }
        return { page_name: 'CodeMapFree', codeMap: {}, arrows: [] };
    }

    // 保存JSON文件
    function saveCodeMap(data: CodeMapData) {
        try {
            fs.writeFileSync(jsonFilePath, JSON.stringify(data, null, '\t'), 'utf-8');
        } catch (error) {
            vscode.window.showErrorMessage(`保存CodeMapFree.json失败: ${error}`);
        }
    }

    // 打开CodeMapFree页面
    function openCodeMapFree() {
        if (currentPanel) {
            currentPanel.reveal();
            return;
        }

        currentPanel = vscode.window.createWebviewPanel(
            'codeMapFree',
            'CodeMapFree',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const data = loadCodeMap();
        currentPanel.webview.html = getWebviewContent(currentPanel.webview, context.extensionUri, data, workspaceRoot!);

        // 处理来自webview的消息
        currentPanel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'save':
                        saveCodeMap(message.data);
                        break;
                    case 'getCode':
                        const code = await getCodeContent(message.path, message.startLine, message.endLine);
                        currentPanel?.webview.postMessage({
                            command: 'codeContent',
                            id: message.id,
                            code: code
                        });
                        break;
                    case 'openFile':
                        // 需求：CodeMapFree.json 存储的是“相对工作区根目录”的相对路径
                        // 使用 resolve 支持 message.path 中包含 ..
                        const uri = vscode.Uri.file(path.resolve(workspaceRoot!, message.path));
                        const document = await vscode.workspace.openTextDocument(uri);
                        const editor = await vscode.window.showTextDocument(document);
                        const range = new vscode.Range(
                            message.startLine - 1,
                            0,
                            message.endLine - 1,
                            0
                        );
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        editor.selection = new vscode.Selection(range.start, range.end);
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        currentPanel.onDidDispose(
            () => {
                currentPanel = undefined;
            },
            null,
            context.subscriptions
        );
    }

    // 获取代码内容
    async function getCodeContent(filePath: string, startLine: number, endLine: number): Promise<string> {
        try {
            // 需求：CodeMapFree.json 存储的是“相对工作区根目录”的相对路径
            // 使用 resolve 支持 filePath 中包含 ..
            const fullPath = path.resolve(workspaceRoot!, filePath);
            const uri = vscode.Uri.file(fullPath);
            const document = await vscode.workspace.openTextDocument(uri);
            const range = new vscode.Range(
                startLine - 1,
                0,
                endLine - 1,
                Number.MAX_VALUE
            );
            return document.getText(range);
        } catch (error) {
            return `// 无法读取文件: ${error}`;
        }
    }

    // 添加到CodeMapFree命令
    const addToMapCommand = vscode.commands.registerCommand('codemapfree.addToMap', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('没有活动的编辑器');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showErrorMessage('请先选择一段代码');
            return;
        }

        const document = editor.document;
        // 需求：路径一律存“相对 CodeMapFree.json 所在目录”的相对路径
        // 允许出现 ..（例如：工作区根目录是子目录，但文件在父目录）
        const filePath = path.relative(workspaceRoot!, document.uri.fsPath);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;

        // 加载现有数据
        const data = loadCodeMap();

        // 自动命名：查找“同一路径下、标题为纯数字”的最大值 + 1
        // 用户手动改名后大概率不是纯数字，因此不纳入计算
        const numericOnly = /^\d+$/;
        let maxNum = 0;
        for (const [title, block] of Object.entries(data.codeMap)) {
            if (block.path !== filePath) continue;
            if (!numericOnly.test(title)) continue;
            const n = parseInt(title, 10);
            if (!Number.isNaN(n) && n > maxNum) maxNum = n;
        }

        // 为避免不同文件“数字标题”冲突导致覆盖，这里做一次全局去重
        let nextNum = maxNum + 1;
        let blockName = String(nextNum);
        while (data.codeMap[blockName]) {
            nextNum += 1;
            blockName = String(nextNum);
        }

        // 添加新代码块
        const newBlock: CodeBlock = {
            path: filePath,
            start_line: startLine,
            end_line: endLine,
            x: Object.keys(data.codeMap).length * 50 + 50,
            y: Object.keys(data.codeMap).length * 50 + 50,
            w: 400,
            h: 300
        };

        data.codeMap[blockName] = newBlock;
        saveCodeMap(data);

        // 打开CodeMapFree页面
        openCodeMapFree();

        // 等待webview加载后发送更新消息
        setTimeout(() => {
            currentPanel?.webview.postMessage({
                command: 'update',
                data: data
            });
        }, 500);
    });

    // 打开CodeMapFree命令
    const openMapCommand = vscode.commands.registerCommand('codemapfree.openMap', () => {
        openCodeMapFree();
    });

    context.subscriptions.push(addToMapCommand, openMapCommand);
}

function escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri, data: CodeMapData, workspaceRoot: string): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>CodeMapFree</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            overflow: hidden;
        }

        .toolbar {
            height: 40px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            padding: 0 10px;
            gap: 10px;
        }

        .toolbar-button {
            padding: 5px 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            border-radius: 2px;
            font-size: 16px;
        }

        .toolbar-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .toolbar-button.active {
            background: var(--vscode-button-secondaryBackground);
        }

        .canvas-container {
            position: relative;
            width: 100%;
            height: calc(100vh - 40px);
            overflow: auto;
            background: var(--vscode-editor-background);
        }

        .code-block {
            position: absolute;
            border: 2px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
            border-radius: 4px;
            min-width: 300px;
            min-height: 200px;
            cursor: move;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            z-index: 2;
        }

        .code-block-header {
            background: var(--vscode-titleBar-activeBackground);
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            cursor: move;
            user-select: none;
            font-size: 12px;
        }

        .code-block-title {
            display: inline-block;
            padding: 2px 4px;
            border-radius: 2px;
        }

        .code-block-title.editing {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            outline: none;
            padding: 2px 4px;
        }

        .rename-wrap {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }

        .rename-input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            outline: none;
            padding: 2px 6px;
            border-radius: 2px;
            width: 200px;
            font-size: 12px;
        }

        .rename-btn {
            width: 18px;
            height: 18px;
            line-height: 18px;
            text-align: center;
            border-radius: 2px;
            cursor: pointer;
            user-select: none;
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            font-size: 12px;
        }

        .rename-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
        }

        .cmf-menu {
            position: fixed;
            z-index: 9999;
            min-width: 180px;
            background: var(--vscode-menu-background);
            color: var(--vscode-menu-foreground);
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            box-shadow: 0 6px 18px rgba(0,0,0,0.35);
            border-radius: 4px;
            padding: 6px 0;
            display: none;
            user-select: none;
        }

        .cmf-menu-item {
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            line-height: 18px;
        }

        .cmf-menu-item:hover {
            background: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }

        .cmf-menu-sep {
            height: 1px;
            margin: 6px 0;
            background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
        }

        .code-block-content {
            padding: 10px;
            height: calc(100% - 40px);
            overflow: auto;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            line-height: 19.5px;
            user-select: text;
            cursor: text;
        }

        .code-line {
            display: flex;
            min-height: 19.5px;
        }

        .code-line-number {
            color: var(--vscode-textBlockQuote-border);
            margin-right: 10px;
            user-select: none;
            width: 50px;
            text-align: right;
            flex-shrink: 0;
        }

        .code-line-content {
            flex: 1;
            white-space: pre;
        }

        .connection-point {
            position: absolute;
            width: 8px;
            height: 8px;
            background: var(--vscode-textLink-foreground);
            border-radius: 50%;
            cursor: crosshair;
            z-index: 10;
            transform: translate(-50%, -50%);
            opacity: 0;
            transition: opacity 0.2s;
        }

        .code-block:hover .connection-point {
            opacity: 1;
        }

        .connection-point:hover {
            width: 12px;
            height: 12px;
        }

        .arrow-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="toolbar-button" id="arrowTool" title="箭头连接工具">→</button>
        <span style="margin-left: auto; padding: 0 10px;" id="pageName" contenteditable="true" style="outline: none; padding: 2px 4px; border-radius: 2px;">${escapeHtml(data.page_name)}</span>
    </div>
    <div class="canvas-container" id="canvas">
        <svg class="arrow-layer" id="arrowLayer">
            <defs>
                <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                    <polygon points="0 0, 10 3, 0 6" fill="var(--vscode-textLink-foreground)" />
                </marker>
            </defs>
        </svg>
    </div>
    <div class="cmf-menu" id="cmfMenu"></div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const canvas = document.getElementById('canvas');
        const arrowLayer = document.getElementById('arrowLayer');
        const arrowTool = document.getElementById('arrowTool');
        const pageName = document.getElementById('pageName');
        const cmfMenu = document.getElementById('cmfMenu');

        let codeMapData = ${JSON.stringify(data)};
        let codeBlocks = {};
        let isDragging = false;
        let dragTarget = null;
        let dragOffset = { x: 0, y: 0 };
        let arrowMode = false;
        let arrowStart = null;
        let currentArrow = null;
        let arrows = codeMapData.arrows || [];
        const LINE_HEIGHT = 19.5;

        // =========================
        // Undo / Redo (Ctrl+Z / Ctrl+Y)
        // =========================
        let history = [];
        let historyIndex = -1;
        let isApplyingHistory = false;

        function deepClone(obj) {
            return JSON.parse(JSON.stringify(obj));
        }

        function isTextEditingTarget(el) {
            if (!el) return false;
            const tag = (el.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') return true;
            if (el.isContentEditable) return true;
            return false;
        }

        function snapshotState() {
            // 确保 arrows 已写入 codeMapData
            const s = deepClone(codeMapData);
            s.arrows = deepClone(arrows);
            return s;
        }

        function recordSnapshot() {
            // 回退后发生新的编辑：清空 redo 历史
            if (historyIndex < history.length - 1) {
                history = history.slice(0, historyIndex + 1);
            }
            history.push(snapshotState());
            historyIndex = history.length - 1;
        }

        function canUndo() {
            return historyIndex > 0;
        }

        function canRedo() {
            return historyIndex >= 0 && historyIndex < history.length - 1;
        }

        function applySnapshot(state) {
            isApplyingHistory = true;
            codeMapData = deepClone(state);
            arrows = deepClone(state.arrows || []);
            loadCodeBlocks();
            // 将回退/重做结果写回 CodeMapFree.json
            saveData();
            isApplyingHistory = false;
        }

        function undo() {
            if (!canUndo()) return;
            historyIndex -= 1;
            applySnapshot(history[historyIndex]);
        }

        function redo() {
            if (!canRedo()) return;
            historyIndex += 1;
            applySnapshot(history[historyIndex]);
        }

        document.addEventListener('keydown', (e) => {
            // 不抢占输入框/可编辑区域内部的撤销（例如重命名输入框、pageName）
            if (isTextEditingTarget(document.activeElement)) return;

            const mod = e.ctrlKey || e.metaKey;
            if (!mod) return;

            const key = (e.key || '').toLowerCase();
            // Ctrl+Z / Cmd+Z
            if (key === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
                return;
            }
            // Ctrl+Y / Cmd+Shift+Z
            if (key === 'y' || (key === 'z' && e.shiftKey)) {
                e.preventDefault();
                redo();
                return;
            }
        });

        function recordAndSave() {
            // 由 undo/redo 触发的 save 不计入历史（避免死循环/历史膨胀）
            if (isApplyingHistory) {
                saveData();
                return;
            }
            saveData();
            recordSnapshot();
        }

        // =========================
        // Custom Context Menu (replace default Cut/Copy/Paste)
        // =========================
        const BLOCK_CLIP_PREFIX = 'CodeMapFreeBlock:';

        function hideMenu() {
            cmfMenu.style.display = 'none';
            cmfMenu.innerHTML = '';
        }

        function showMenu(items, x, y) {
            cmfMenu.innerHTML = '';
            items.forEach((it) => {
                if (it === 'sep') {
                    const sep = document.createElement('div');
                    sep.className = 'cmf-menu-sep';
                    cmfMenu.appendChild(sep);
                    return;
                }
                const el = document.createElement('div');
                el.className = 'cmf-menu-item';
                el.textContent = it.label;
                el.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    hideMenu();
                    await it.onClick();
                });
                cmfMenu.appendChild(el);
            });

            cmfMenu.style.display = 'block';
            const rect = cmfMenu.getBoundingClientRect();
            const maxX = window.innerWidth - rect.width - 8;
            const maxY = window.innerHeight - rect.height - 8;
            cmfMenu.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
            cmfMenu.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
        }

        async function writeClipboardText(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }

        async function readClipboardText() {
            if (navigator.clipboard && navigator.clipboard.readText) {
                return await navigator.clipboard.readText();
            }
            return '';
        }

        function getBlockNameFromTarget(target) {
            const blockEl = target && target.closest ? target.closest('.code-block') : null;
            return blockEl ? blockEl.dataset.blockName : null;
        }

        function deleteBlock(blockName) {
            if (!codeMapData.codeMap[blockName]) return;
            delete codeMapData.codeMap[blockName];
            arrows = (arrows || []).filter(a => a.from.block !== blockName && a.to.block !== blockName);
            loadCodeBlocks();
            recordAndSave();
        }

        function getNextNumericNameForPath(filePath) {
            const numericOnly = /^\\d+$/;
            let maxNum = 0;
            Object.entries(codeMapData.codeMap).forEach(([title, block]) => {
                if (!block || block.path !== filePath) return;
                if (!numericOnly.test(title)) return;
                const n = parseInt(title, 10);
                if (!Number.isNaN(n) && n > maxNum) maxNum = n;
            });
            let next = maxNum + 1;
            let name = String(next);
            while (codeMapData.codeMap[name]) {
                next += 1;
                name = String(next);
            }
            return name;
        }

        function createPastedBlockAt(xClient, yClient, payload) {
            const canvasRect = canvas.getBoundingClientRect();
            const x = xClient - canvasRect.left + canvas.scrollLeft;
            const y = yClient - canvasRect.top + canvas.scrollTop;

            const name = getNextNumericNameForPath(payload.path);
            codeMapData.codeMap[name] = {
                path: payload.path,
                start_line: payload.start_line,
                end_line: payload.end_line,
                x: Math.max(0, x),
                y: Math.max(0, y),
                w: payload.w || 400,
                h: payload.h || 300
            };
            loadCodeBlocks();
            recordAndSave();
        }

        document.addEventListener('click', () => hideMenu());
        document.addEventListener('scroll', () => hideMenu(), true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hideMenu();
        });

        document.addEventListener('contextmenu', async (e) => {
            // 禁用默认右键菜单（剪切/复制/粘贴）
            e.preventDefault();
            e.stopPropagation();

            const target = e.target;
            const blockName = getBlockNameFromTarget(target);
            const inHeader = target && target.closest ? !!target.closest('.code-block-header') : false;
            const inContent = target && target.closest ? !!target.closest('.code-block-content') : false;

            const items = [];

            if (blockName && inHeader) {
                items.push({
                    label: '复制此代码块',
                    onClick: async () => {
                        const b = codeMapData.codeMap[blockName];
                        if (!b) return;
                        const payload = {
                            path: b.path,
                            start_line: b.start_line,
                            end_line: b.end_line,
                            w: b.w,
                            h: b.h
                        };
                        await writeClipboardText(BLOCK_CLIP_PREFIX + JSON.stringify(payload));
                    }
                });
                items.push({
                    label: '删除此代码块',
                    onClick: async () => deleteBlock(blockName)
                });
                items.push('sep');
            }

            if (blockName && inContent) {
                items.push({
                    label: '复制选择内容',
                    onClick: async () => {
                        const selected = (window.getSelection && window.getSelection().toString()) || '';
                        if (selected) await writeClipboardText(selected);
                    }
                });
                items.push({
                    label: '复制整个代码块内容',
                    onClick: async () => {
                        const raw = codeBlocks[blockName] && codeBlocks[blockName].rawCode ? codeBlocks[blockName].rawCode : '';
                        if (raw) {
                            await writeClipboardText(raw);
                        } else {
                            const contentEl = codeBlocks[blockName]?.content;
                            const lines = contentEl ? Array.from(contentEl.querySelectorAll('.code-line-content')).map(n => n.textContent || '') : [];
                            await writeClipboardText(lines.join('\\n'));
                        }
                    }
                });
                items.push('sep');
            }

            items.push({
                label: '在此粘贴新代码块',
                onClick: async () => {
                    const t = await readClipboardText();
                    if (!t || !t.startsWith(BLOCK_CLIP_PREFIX)) {
                        vscode.postMessage({ command: 'showError', message: '剪贴板里没有可粘贴的 CodeMapFree 代码块' });
                        return;
                    }
                    try {
                        const payload = JSON.parse(t.slice(BLOCK_CLIP_PREFIX.length));
                        if (!payload || !payload.path || !payload.start_line || !payload.end_line) {
                            vscode.postMessage({ command: 'showError', message: '剪贴板中的代码块数据格式不正确' });
                            return;
                        }
                        createPastedBlockAt(e.clientX, e.clientY, payload);
                    } catch (err) {
                        vscode.postMessage({ command: 'showError', message: '解析剪贴板中的代码块数据失败' });
                    }
                }
            });

            showMenu(items, e.clientX, e.clientY);
        }, true);

        // 初始化页面名称编辑
        pageName.addEventListener('blur', () => {
            codeMapData.page_name = pageName.textContent.trim() || 'CodeMapFree';
            recordAndSave();
        });

        pageName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                pageName.blur();
            }
        });

        // 箭头工具切换
        arrowTool.addEventListener('click', () => {
            arrowMode = !arrowMode;
            arrowTool.classList.toggle('active', arrowMode);
            canvas.style.cursor = arrowMode ? 'crosshair' : 'default';
            updateConnectionPoints();
        });

        // 更新连接点显示
        function updateConnectionPoints() {
            Object.values(codeBlocks).forEach(block => {
                const points = block.element.querySelectorAll('.connection-point');
                points.forEach(point => {
                    point.style.display = arrowMode ? 'block' : 'none';
                });
            });
        }

        // 加载代码块
        function loadCodeBlocks() {
            // 清空现有代码块
            Object.values(codeBlocks).forEach(block => block.element.remove());
            codeBlocks = {};

            // 创建代码块
            for (const [name, blockData] of Object.entries(codeMapData.codeMap)) {
                createCodeBlock(name, blockData);
            }

            updateConnectionPoints();
            updateArrows();
        }

        // 创建代码块
        function createCodeBlock(name, blockData) {
            const block = document.createElement('div');
            block.className = 'code-block';
            block.style.left = blockData.x + 'px';
            block.style.top = blockData.y + 'px';
            block.style.width = blockData.w + 'px';
            block.style.height = blockData.h + 'px';
            block.dataset.blockName = name;

            const header = document.createElement('div');
            header.className = 'code-block-header';

            const title = document.createElement('span');
            title.className = 'code-block-title';
            title.textContent = \`\${blockData.path}@\${blockData.start_line}:\${blockData.end_line}@\${name}\`;
            title.dataset.blockName = name;

            // 双击编辑代码块名称
            title.addEventListener('dblclick', (e) => {
                // 阻止双击默认行为（否则可能把光标放到末尾，导致输入“追加”）
                e.preventDefault();
                e.stopPropagation();

                const wrap = document.createElement('span');
                wrap.className = 'rename-wrap';

                const input = document.createElement('input');
                input.type = 'text';
                // 使用“当前名称”（可能已被用户改过），不要用 createCodeBlock 闭包里的旧 name
                const oldNameAtStart = title.dataset.blockName || name;
                input.value = oldNameAtStart;
                input.className = 'rename-input';

                const ok = document.createElement('span');
                ok.className = 'rename-btn';
                ok.title = '保存(Enter)';
                ok.textContent = '✓';

                const cancel = document.createElement('span');
                cancel.className = 'rename-btn';
                cancel.title = '取消(Esc)';
                cancel.textContent = '×';

                const restore = () => {
                    wrap.replaceWith(title);
                };

                const commit = () => {
                    const newName = input.value.trim();
                    if (!newName || newName === oldNameAtStart) {
                        restore();
                        return;
                    }
                    renameBlock(oldNameAtStart, newName);
                    restore();
                };

                // 阻止 header 的拖拽 mousedown(e.preventDefault) 影响输入框聚焦/编辑
                [wrap, input, ok, cancel].forEach((el) => {
                    el.addEventListener('mousedown', (ev) => ev.stopPropagation());
                    el.addEventListener('click', (ev) => ev.stopPropagation());
                    el.addEventListener('dblclick', (ev) => ev.stopPropagation());
                });

                // 关键：点击 ✓/× 时会先触发 input.blur，如果 blur 先把 wrap 恢复成 title，
                // click 事件就没机会触发 => 看起来“点✓没反应”
                // 所以用 mousedown 标记/抢先处理，确保保存/取消一定执行
                let actionTaken = false;
                let isComposing = false;
                // IME 下“全选覆盖”经常失效（空格确认候选词会把光标跳到末尾导致追加）。
                // 这里实现明确的语义：进入编辑后的“首次输入”一定覆盖旧内容。
                let replaceAllPending = true;
                let replacedOnce = false;

                function replaceAllNowIfNeeded() {
                    if (!replaceAllPending) return;
                    replaceAllPending = false;
                    replacedOnce = true;
                    input.value = '';
                    try {
                        input.setSelectionRange(0, 0);
                    } catch (err) {
                        // ignore
                    }
                }

                // 组合输入开始时就清空，保证后续候选词/空格确认不会追加到旧内容末尾
                input.addEventListener('compositionstart', () => {
                    isComposing = true;
                    replaceAllNowIfNeeded();
                });
                input.addEventListener('compositionend', () => {
                    isComposing = false;
                    // 某些 IME 会在上屏时把“旧值”重新作为前缀拼回去，这里强制剥离
                    if (replacedOnce && input.value && oldNameAtStart && input.value.startsWith(oldNameAtStart)) {
                        input.value = input.value.slice(oldNameAtStart.length);
                        try {
                            input.setSelectionRange(input.value.length, input.value.length);
                        } catch (err) {
                            // ignore
                        }
                    }
                });

                // beforeinput 更早拦截 IME/输入法的插入行为（部分环境里比 compositionend 更可靠）
                input.addEventListener('beforeinput', (ev) => {
                    // 进入“覆盖模式”后首次发生任何插入（包括 IME），先清空旧内容
                    if (replaceAllPending && ev.inputType && ev.inputType.startsWith('insert')) {
                        replaceAllNowIfNeeded();
                    }
                });

                const doCommit = () => {
                    if (isComposing) return;
                    actionTaken = true;
                    commit();
                };
                const doCancel = () => {
                    if (isComposing) return;
                    actionTaken = true;
                    restore();
                };

                // pointerdown 比 mousedown 更通用（触控板/触屏/不同输入法环境更稳）
                ok.addEventListener('pointerdown', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    doCommit();
                });
                cancel.addEventListener('pointerdown', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    doCancel();
                });
                // 再加一层 click 兜底（有些环境 pointerdown 可能不触发）
                ok.addEventListener('click', () => doCommit());
                cancel.addEventListener('click', () => doCancel());

                input.addEventListener('keydown', (ev) => {
                    // IME 组合输入时，Enter 通常用于“确认候选词”，不要当成保存
                    if (ev.isComposing) return;
                    // 非 IME：第一次输入可打印字符时也覆盖旧内容
                    if (replaceAllPending && ev.key && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
                        replaceAllNowIfNeeded();
                    }
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        doCommit();
                    } else if (ev.key === 'Escape') {
                        ev.preventDefault();
                        doCancel();
                    }
                });

                // 失焦默认取消（更安全：用户明确按 Enter/✓ 才保存）
                input.addEventListener('blur', () => {
                    setTimeout(() => {
                        // IME 组合输入期间 blur 行为可能异常（候选框/焦点切换），此时不自动取消
                        if (isComposing) return;
                        if (actionTaken) return;
                        if (document.body.contains(wrap)) restore();
                    }, 0);
                });

                wrap.appendChild(input);
                wrap.appendChild(ok);
                wrap.appendChild(cancel);
                title.replaceWith(wrap);
                // 延迟到下一帧：避免双击的第二下把光标定位到末尾，导致输入“追加”而非覆盖
                setTimeout(() => {
                    input.focus();
                    // IME 组合输入期间强行 setSelectionRange 可能会导致光标/候选异常
                    if (!isComposing) {
                        try {
                            input.setSelectionRange(0, input.value.length);
                        } catch (err) {
                            input.select();
                        }
                    }
                }, 0);
            });

            // 双击“标题栏空白处”跳转到源文件（避免单击误触；双击文字用于重命名）
            header.addEventListener('dblclick', (e) => {
                // 如果双击发生在标题文字上，会被上面的 stopPropagation 拦截并进入重命名
                if (!arrowMode) {
                    vscode.postMessage({
                        command: 'openFile',
                        path: blockData.path,
                        startLine: blockData.start_line,
                        endLine: blockData.end_line
                    });
                }
            });

            header.appendChild(title);

            const content = document.createElement('div');
            content.className = 'code-block-content';
            content.innerHTML = '<div class="code-line"><span class="code-line-number"></span><span class="code-line-content">加载中...</span></div>';

            block.appendChild(header);
            block.appendChild(content);
            canvas.appendChild(block);

            codeBlocks[name] = {
                element: block,
                data: blockData,
                header: header,
                content: content,
                title: title
            };

            // 加载代码内容
            vscode.postMessage({
                command: 'getCode',
                id: name,
                path: blockData.path,
                startLine: blockData.start_line,
                endLine: blockData.end_line
            });

            // 拖动功能
            header.addEventListener('mousedown', (e) => {
                if (arrowMode) return;
                isDragging = true;
                dragTarget = block;
                const rect = block.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                dragOffset.x = e.clientX - rect.left;
                dragOffset.y = e.clientY - rect.top;
                e.preventDefault();
            });

            // 添加连接点
            addConnectionPoints(block, name, blockData);
        }

        // 添加连接点
        function addConnectionPoints(block, blockName, blockData) {
            const content = block.querySelector('.code-block-content');
            const lineCount = blockData.end_line - blockData.start_line + 1;

            for (let i = 0; i < lineCount; i++) {
                const lineNum = blockData.start_line + i;
                const point = document.createElement('div');
                point.className = 'connection-point';
                point.dataset.blockName = blockName;
                point.dataset.line = lineNum;
                point.style.left = '0px';
                point.style.top = (40 + i * LINE_HEIGHT + LINE_HEIGHT / 2) + 'px';

                point.addEventListener('mousedown', (e) => {
                    if (!arrowMode) return;
                    e.stopPropagation();
                    arrowStart = {
                        block: blockName,
                        line: lineNum,
                        element: point,
                        blockElement: block
                    };
                    startArrowDrawing(e);
                });

                block.appendChild(point);
            }
        }

        // 开始绘制箭头
        function startArrowDrawing(e) {
            if (!arrowStart) return;

            const startRect = arrowStart.element.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const startX = startRect.left + startRect.width / 2 - canvasRect.left + canvas.scrollLeft;
            const startY = startRect.top + startRect.height / 2 - canvasRect.top + canvas.scrollTop;

            currentArrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            currentArrow.setAttribute('x1', startX);
            currentArrow.setAttribute('y1', startY);
            currentArrow.setAttribute('x2', startX);
            currentArrow.setAttribute('y2', startY);
            currentArrow.setAttribute('stroke', 'var(--vscode-textLink-foreground)');
            currentArrow.setAttribute('stroke-width', '2');
            currentArrow.setAttribute('marker-end', 'url(#arrowhead)');

            arrowLayer.appendChild(currentArrow);

            canvas.addEventListener('mousemove', updateArrow);
            canvas.addEventListener('mouseup', finishArrow);
        }

        // 更新箭头
        function updateArrow(e) {
            if (!currentArrow || !arrowStart) return;

            const canvasRect = canvas.getBoundingClientRect();
            const x = e.clientX - canvasRect.left + canvas.scrollLeft;
            const y = e.clientY - canvasRect.top + canvas.scrollTop;

            currentArrow.setAttribute('x2', x);
            currentArrow.setAttribute('y2', y);
        }

        // 完成箭头
        function finishArrow(e) {
            if (!currentArrow || !arrowStart) return;

            const target = e.target.closest('.connection-point');
            if (target && target !== arrowStart.element && target.dataset.blockName !== arrowStart.block) {
                const arrow = {
                    from: {
                        block: arrowStart.block,
                        line: arrowStart.line
                    },
                    to: {
                        block: target.dataset.blockName,
                        line: parseInt(target.dataset.line)
                    }
                };
                arrows.push(arrow);
                updateArrows();
                recordAndSave();
            } else {
                currentArrow.remove();
            }

            currentArrow = null;
            arrowStart = null;
            canvas.removeEventListener('mousemove', updateArrow);
            canvas.removeEventListener('mouseup', finishArrow);
        }

        // 更新所有箭头
        function updateArrows() {
            // 清空现有箭头（除了正在绘制的）
            arrowLayer.querySelectorAll('line').forEach(line => {
                if (line !== currentArrow) line.remove();
            });

            // 绘制箭头
            arrows.forEach(arrow => {
                const fromBlock = codeBlocks[arrow.from.block];
                const toBlock = codeBlocks[arrow.to.block];

                if (fromBlock && toBlock) {
                    const fromRect = fromBlock.element.getBoundingClientRect();
                    const toRect = toBlock.element.getBoundingClientRect();
                    const canvasRect = canvas.getBoundingClientRect();

                    const fromLineIndex = arrow.from.line - fromBlock.data.start_line;
                    const toLineIndex = arrow.to.line - toBlock.data.start_line;

                    const fromX = fromRect.left - canvasRect.left + canvas.scrollLeft;
                    const fromY = fromRect.top - canvasRect.top + canvas.scrollTop + 40 + fromLineIndex * LINE_HEIGHT + LINE_HEIGHT / 2;
                    const toX = toRect.left - canvasRect.left + canvas.scrollLeft;
                    const toY = toRect.top - canvasRect.top + canvas.scrollTop + 40 + toLineIndex * LINE_HEIGHT + LINE_HEIGHT / 2;

                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', fromX);
                    line.setAttribute('y1', fromY);
                    line.setAttribute('x2', toX);
                    line.setAttribute('y2', toY);
                    line.setAttribute('stroke', 'var(--vscode-textLink-foreground)');
                    line.setAttribute('stroke-width', '2');
                    line.setAttribute('marker-end', 'url(#arrowhead)');
                    arrowLayer.appendChild(line);
                }
            });
        }

        // 重命名代码块
        function renameBlock(oldName, newName) {
            if (codeMapData.codeMap[newName]) {
                vscode.postMessage({
                    command: 'showError',
                    message: '代码块名称已存在'
                });
                return;
            }

            codeMapData.codeMap[newName] = codeMapData.codeMap[oldName];
            delete codeMapData.codeMap[oldName];

            const block = codeBlocks[oldName];
            block.element.dataset.blockName = newName;
            block.title.dataset.blockName = newName;
            block.title.textContent = \`\${block.data.path}@\${block.data.start_line}:\${block.data.end_line}@\${newName}\`;

            codeBlocks[newName] = block;
            delete codeBlocks[oldName];

            // 更新连接点
            block.element.querySelectorAll('.connection-point').forEach(point => {
                point.dataset.blockName = newName;
            });

            // 更新箭头中的引用
            arrows.forEach(arrow => {
                if (arrow.from.block === oldName) {
                    arrow.from.block = newName;
                }
                if (arrow.to.block === oldName) {
                    arrow.to.block = newName;
                }
            });

            recordAndSave();
            updateArrows();
        }

        // 保存数据
        function saveData() {
            // 更新代码块位置和大小
            for (const [name, block] of Object.entries(codeBlocks)) {
                const rect = block.element.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                codeMapData.codeMap[name].x = rect.left - canvasRect.left + canvas.scrollLeft;
                codeMapData.codeMap[name].y = rect.top - canvasRect.top + canvas.scrollTop;
                codeMapData.codeMap[name].w = rect.width;
                codeMapData.codeMap[name].h = rect.height;
            }

            codeMapData.arrows = arrows;
            vscode.postMessage({
                command: 'save',
                data: codeMapData
            });
        }

        // 鼠标移动和释放
        document.addEventListener('mousemove', (e) => {
            if (isDragging && dragTarget) {
                const canvasRect = canvas.getBoundingClientRect();
                const x = e.clientX - canvasRect.left + canvas.scrollLeft - dragOffset.x;
                const y = e.clientY - canvasRect.top + canvas.scrollTop - dragOffset.y;
                dragTarget.style.left = Math.max(0, x) + 'px';
                dragTarget.style.top = Math.max(0, y) + 'px';
                updateArrows();
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                if (dragTarget) {
                    recordAndSave();
                }
                dragTarget = null;
            }
        });

        // 处理来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'update':
                    codeMapData = message.data;
                    arrows = message.data.arrows || [];
                    loadCodeBlocks();
                    // 外部新增/更新也纳入历史（并清空 redo）
                    recordSnapshot();
                    break;
                case 'codeContent':
                    if (codeBlocks[message.id]) {
                        // 缓存原始代码，供“复制整个代码块内容”使用
                        codeBlocks[message.id].rawCode = message.code || '';
                        const code = message.code;
                        const lines = code.split('\\n');
                        const codeHtml = lines.map((line, i) => {
                            const lineNum = codeBlocks[message.id].data.start_line + i;
                            return \`<div class="code-line"><span class="code-line-number">\${lineNum}</span><span class="code-line-content">\${escapeHtml(line || ' ')}</span></div>\`;
                        }).join('');
                        codeBlocks[message.id].content.innerHTML = codeHtml;
                    }
                    break;
            }
        });

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // 初始化
        loadCodeBlocks();
        // 初始状态入栈，作为第 1 个快照
        recordSnapshot();
    </script>
</body>
</html>`;
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function deactivate() {}
