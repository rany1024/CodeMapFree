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
        from: { block: string; line: number; col?: number };
        to: { block: string; line: number; col?: number };
        color?: string; // 箭头颜色，默认为主题色
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

        /* Resize handles */
        .resize-handle {
            position: absolute;
            width: 10px;
            height: 10px;
            background: var(--vscode-textLink-foreground);
            border-radius: 50%;
            opacity: 0;
            transition: opacity 0.15s;
            z-index: 11;
        }

        .code-block:hover .resize-handle {
            opacity: 0.75;
        }

        .resize-handle:hover {
            opacity: 1;
        }

        .resize-handle.n { top: -5px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
        .resize-handle.s { bottom: -5px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
        .resize-handle.e { right: -5px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
        .resize-handle.w { left: -5px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
        .resize-handle.nw { left: -5px; top: -5px; cursor: nwse-resize; }
        .resize-handle.ne { right: -5px; top: -5px; cursor: nesw-resize; }
        .resize-handle.sw { left: -5px; bottom: -5px; cursor: nesw-resize; }
        .resize-handle.se { right: -5px; bottom: -5px; cursor: nwse-resize; }

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


        .arrow-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1000;
        }

        .arrow-color-picker {
            display: none;
            position: fixed;
            flex-direction: row;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            border-radius: 8px;
            box-shadow: 0 6px 18px rgba(0,0,0,0.35);
            z-index: 10000;
        }

        .arrow-color-picker.active {
            display: flex;
        }

        .arrow-color-label {
            font-size: 11px;
            color: var(--vscode-menu-foreground);
            white-space: nowrap;
        }

        .arrow-color-input {
            width: 32px;
            height: 24px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            cursor: pointer;
            background: var(--vscode-input-background);
            flex-shrink: 0;
        }

        .arrow-color-presets {
            display: flex;
            flex-direction: row;
            gap: 6px;
            overflow-x: auto;
            overflow-y: hidden;
            max-width: 300px;
        }

        .arrow-color-presets::-webkit-scrollbar {
            height: 4px;
        }

        .arrow-color-presets::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 2px;
        }

        .arrow-color-preset {
            width: 20px;
            height: 20px;
            border: 1.5px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
            transition: transform 0.15s, border-color 0.15s;
        }

        .arrow-color-preset:hover {
            transform: scale(1.15);
            border-color: var(--vscode-textLink-foreground);
            z-index: 1;
            position: relative;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button class="toolbar-button" id="arrowTool" title="箭头连接工具">→</button>
        <span style="margin-left: auto; padding: 0 10px;" id="pageName" contenteditable="true" style="outline: none; padding: 2px 4px; border-radius: 2px;">${escapeHtml(data.page_name)}</span>
    </div>
    <div class="arrow-color-picker" id="arrowColorPicker">
        <span class="arrow-color-label">箭头颜色</span>
        <input type="color" class="arrow-color-input" id="arrowColorInput" value="#007acc">
        <div class="arrow-color-presets">
            <div class="arrow-color-preset" data-color="#007acc" style="background: #007acc;" title="蓝色"></div>
            <div class="arrow-color-preset" data-color="#ff6b6b" style="background: #ff6b6b;" title="红色"></div>
            <div class="arrow-color-preset" data-color="#51cf66" style="background: #51cf66;" title="绿色"></div>
            <div class="arrow-color-preset" data-color="#ffd43b" style="background: #ffd43b;" title="黄色"></div>
            <div class="arrow-color-preset" data-color="#845ef7" style="background: #845ef7;" title="紫色"></div>
            <div class="arrow-color-preset" data-color="#ff922b" style="background: #ff922b;" title="橙色"></div>
            <div class="arrow-color-preset" data-color="#20c997" style="background: #20c997;" title="青色"></div>
            <div class="arrow-color-preset" data-color="#e83e8c" style="background: #e83e8c;" title="粉色"></div>
            <div class="arrow-color-preset" data-color="#6c757d" style="background: #6c757d;" title="灰色"></div>
            <div class="arrow-color-preset" data-color="#fd7e14" style="background: #fd7e14;" title="深橙"></div>
            <div class="arrow-color-preset" data-color="#0dcaf0" style="background: #0dcaf0;" title="浅蓝"></div>
            <div class="arrow-color-preset" data-color="#198754" style="background: #198754;" title="深绿"></div>
            <div class="arrow-color-preset" data-color="#dc3545" style="background: #dc3545;" title="深红"></div>
            <div class="arrow-color-preset" data-color="#0d6efd" style="background: #0d6efd;" title="深蓝"></div>
            <div class="arrow-color-preset" data-color="#6610f2" style="background: #6610f2;" title="深紫"></div>
            <div class="arrow-color-preset" data-color="#000000" style="background: #000000;" title="黑色"></div>
        </div>
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
        const arrowColorPicker = document.getElementById('arrowColorPicker');
        const arrowColorInput = document.getElementById('arrowColorInput');
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
        let currentArrowColor = '#007acc'; // 默认颜色
        const LINE_HEIGHT = 19.5;
        const CODE_PADDING_X = 10; // .code-block-content padding
        const LINE_NUM_GUTTER_W = 50; // .code-line-number width (CSS)
        const LINE_NUM_GAP_W = 10; // .code-line-number margin-right (CSS)

        // Resize state
        let isResizing = false;
        let resizeTarget = null;
        let resizeDir = null; // 'n'|'s'|'e'|'w'|'nw'|'ne'|'sw'|'se'
        let resizeStart = null;
        const MIN_W = 300;
        const MIN_H = 200;

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
            // 箭头模式下禁用右键菜单
            if (arrowMode) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

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

        // 定位颜色选择器到箭头按钮下方
        function positionColorPicker() {
            if (!arrowMode) return;
            const toolRect = arrowTool.getBoundingClientRect();
            arrowColorPicker.style.left = toolRect.left + 'px';
            arrowColorPicker.style.top = (toolRect.bottom + 4) + 'px';
        }

        // 箭头工具切换
        arrowTool.addEventListener('click', (e) => {
            e.stopPropagation();
            arrowMode = !arrowMode;
            arrowTool.classList.toggle('active', arrowMode);
            if (arrowMode) {
                arrowColorPicker.classList.add('active');
                positionColorPicker();
            } else {
                arrowColorPicker.classList.remove('active');
                // 退出箭头模式时清除起点选择和预览
                if (arrowStart) {
                    if (currentArrow) {
                        currentArrow.remove();
                        currentArrow = null;
                    }
                    canvas.removeEventListener('mousemove', updateArrowPreview);
                    arrowStart = null;
                }
            }
            canvas.style.cursor = arrowMode ? 'crosshair' : 'default';
            updateBlockInteractivity();
        });

        // 点击外部关闭颜色选择器
        document.addEventListener('click', (e) => {
            if (arrowMode && arrowColorPicker.classList.contains('active')) {
                // 如果点击的不是箭头按钮和颜色选择器内部
                if (!arrowTool.contains(e.target) && !arrowColorPicker.contains(e.target)) {
                    arrowMode = false;
                    arrowTool.classList.remove('active');
                    arrowColorPicker.classList.remove('active');
                    canvas.style.cursor = 'default';
                    // 清除起点选择和预览
                    if (arrowStart) {
                        if (currentArrow) {
                            currentArrow.remove();
                            currentArrow = null;
                        }
                        canvas.removeEventListener('mousemove', updateArrowPreview);
                        arrowStart = null;
                    }
                    updateBlockInteractivity();
                }
            }
        });

        // 窗口大小改变时重新定位
        window.addEventListener('resize', () => {
            if (arrowMode && arrowColorPicker.classList.contains('active')) {
                positionColorPicker();
            }
        });

        // 颜色选择器事件
        arrowColorInput.addEventListener('input', (e) => {
            currentArrowColor = e.target.value;
        });

        // 阻止颜色选择器内部点击事件冒泡
        arrowColorPicker.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.querySelectorAll('.arrow-color-preset').forEach(preset => {
            preset.addEventListener('click', (e) => {
                e.stopPropagation();
                const color = preset.dataset.color;
                currentArrowColor = color;
                arrowColorInput.value = color;
            });
        });

        // 更新代码块交互性（箭头模式下禁用）
        function updateBlockInteractivity() {
            Object.values(codeBlocks).forEach(block => {
                if (arrowMode) {
                    block.element.style.pointerEvents = 'none';
                    block.content.style.userSelect = 'none';
                    block.content.style.cursor = 'default';
                } else {
                    block.element.style.pointerEvents = 'auto';
                    block.content.style.userSelect = 'text';
                    block.content.style.cursor = 'text';
                }
                // 箭头模式下允许点击"代码文本"来选择列（J）
                block.element.querySelectorAll('.code-line-content').forEach(el => {
                    el.style.pointerEvents = arrowMode ? 'auto' : 'auto';
                    el.style.cursor = arrowMode ? 'crosshair' : 'text';
                });
            });
        }


        function clamp(n, min, max) {
            return Math.max(min, Math.min(max, n));
        }

        // 估算当前代码字体的单字符宽度（等宽字体下更准）
        function getCharWidth() {
            const probe = document.createElement('span');
            probe.style.position = 'fixed';
            probe.style.left = '-9999px';
            probe.style.top = '-9999px';
            probe.style.whiteSpace = 'pre';
            // 尽量继承代码内容字体
            const sample = document.querySelector('.code-block-content');
            if (sample) {
                const cs = window.getComputedStyle(sample);
                probe.style.fontFamily = cs.fontFamily;
                probe.style.fontSize = cs.fontSize;
                probe.style.fontWeight = cs.fontWeight;
                probe.style.letterSpacing = cs.letterSpacing;
            }
            probe.textContent = 'MMMMMMMMMM'; // 10 个 M 平均
            document.body.appendChild(probe);
            const w = probe.getBoundingClientRect().width / 10;
            probe.remove();
            return w || 8;
        }

        const CHAR_W = getCharWidth();

        function getAnchorPoint(blockName, line, col) {
            const b = codeBlocks[blockName];
            if (!b) return null;
            const canvasRect = canvas.getBoundingClientRect();

            // 通过 data-line 精确找到对应行的“代码文本元素”
            const lineContentEl = b.content ? b.content.querySelector(\`.code-line-content[data-line="\${line}"]\`) : null;
            if (!lineContentEl) return null;

            const lineEl = lineContentEl.closest('.code-line');
            if (!lineEl) return null;

            const lineRect = lineEl.getBoundingClientRect();
            const contentRect = lineContentEl.getBoundingClientRect();

            // Y：用真实行盒子的中心，确保“严格居中”
            const y = (lineRect.top + lineRect.height / 2) - canvasRect.top + canvas.scrollTop;

            // X：第J列的左边位置（从代码文本区域左边算起）
            const safeCol = Math.max(1, (col || 1));
            const x = (contentRect.left - canvasRect.left + canvas.scrollLeft) + (safeCol - 1) * CHAR_W;

            return { x, y };
        }

        function computeColFromClick(lineContentEl, clientX) {
            const rect = lineContentEl.getBoundingClientRect();
            const x = clientX - rect.left;
            // col 从 1 开始；允许落到“行尾 + 1”
            const raw = Math.floor(x / CHAR_W) + 1;
            const text = lineContentEl.textContent || '';
            return clamp(raw, 1, Math.max(1, text.length + 1));
        }

        function getLineInfoFromLineContent(lineContentEl) {
            const lineEl = lineContentEl.closest('.code-line');
            if (!lineEl) return null;
            const numEl = lineEl.querySelector('.code-line-number');
            const n = numEl ? parseInt((numEl.textContent || '').trim(), 10) : NaN;
            if (Number.isNaN(n)) return null;
            return { line: n };
        }

        function getBlockNameFromLineContent(lineContentEl) {
            const blockEl = lineContentEl.closest('.code-block');
            return blockEl ? blockEl.dataset.blockName : null;
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

            updateArrows();
            updateBlockInteractivity();
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
                if (arrowMode) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                vscode.postMessage({
                    command: 'openFile',
                    path: blockData.path,
                    startLine: blockData.start_line,
                    endLine: blockData.end_line
                });
            });

            header.appendChild(title);

            const content = document.createElement('div');
            content.className = 'code-block-content';
            content.innerHTML = '<div class="code-line"><span class="code-line-number"></span><span class="code-line-content">加载中...</span></div>';

            block.appendChild(header);
            block.appendChild(content);

            // 添加缩放手柄（8 个方向）
            addResizeHandles(block, name);

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
                if (arrowMode) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                // 缩放中不允许拖拽移动
                if (isResizing) return;
                isDragging = true;
                dragTarget = block;
                const rect = block.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                dragOffset.x = e.clientX - rect.left;
                dragOffset.y = e.clientY - rect.top;
                e.preventDefault();
            });

        }

        function addResizeHandles(blockEl, blockName) {
            const dirs = ['n','s','e','w','nw','ne','sw','se'];
            dirs.forEach((d) => {
                const h = document.createElement('div');
                h.className = 'resize-handle ' + d;
                h.dataset.blockName = blockName;
                h.dataset.dir = d;
                h.addEventListener('mousedown', (e) => {
                    if (arrowMode) {
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                    e.stopPropagation();
                    e.preventDefault();
                    beginResize(e, blockEl, d);
                });
                blockEl.appendChild(h);
            });
        }

        function beginResize(e, blockEl, dir) {
            isResizing = true;
            resizeTarget = blockEl;
            resizeDir = dir;
            const rect = blockEl.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const left = rect.left - canvasRect.left + canvas.scrollLeft;
            const top = rect.top - canvasRect.top + canvas.scrollTop;
            resizeStart = {
                mouseX: e.clientX,
                mouseY: e.clientY,
                left,
                top,
                width: rect.width,
                height: rect.height
            };
            document.body.style.userSelect = 'none';
        }


        // 处理"代码文本点击"（单击模式：两次点击完成连接，并记录列 col）
        function handleLineContentClick(lineContentEl, clientX) {
            const blockName = getBlockNameFromLineContent(lineContentEl);
            const lineInfo = getLineInfoFromLineContent(lineContentEl);
            if (!blockName || !lineInfo) return;
            const col = computeColFromClick(lineContentEl, clientX);

            if (!arrowStart) {
                // 第一次点击：选择起点，开始实时绘制箭头预览
                arrowStart = {
                    block: blockName,
                    line: lineInfo.line,
                    col,
                    element: null,
                    blockElement: lineContentEl.closest('.code-block')
                };
                startArrowPreview();
                return;
            }

            // 不能选择同一个位置
            if (arrowStart.block === blockName && arrowStart.line === lineInfo.line && (arrowStart.col || 1) === col) {
                return;
            }

            // 第二次点击：完成箭头连接
            const arrow = {
                from: { block: arrowStart.block, line: arrowStart.line, col: arrowStart.col || 1 },
                to: { block: blockName, line: lineInfo.line, col },
                color: currentArrowColor
            };
            arrows.push(arrow);

            // 清除预览箭头
            if (currentArrow) {
                currentArrow.remove();
                currentArrow = null;
            }
            canvas.removeEventListener('mousemove', updateArrowPreview);

            updateArrows();
            recordAndSave();

            // 连接完成后自动退出箭头模式
            arrowMode = false;
            arrowTool.classList.remove('active');
            arrowColorPicker.classList.remove('active');
            canvas.style.cursor = 'default';
            updateBlockInteractivity();

            arrowStart = null;
        }

        // 开始箭头预览（第一次点击后，实时跟随鼠标）
        function startArrowPreview() {
            if (!arrowStart) return;

            const p = getAnchorPoint(arrowStart.block, arrowStart.line, arrowStart.col || 1);
            if (!p) return;
            const fromX = p.x;
            const fromY = p.y;

            // 创建箭头标记
            const markerId = 'arrowhead-' + currentArrowColor.replace('#', '');
            let marker = arrowLayer.querySelector('#' + markerId);
            if (!marker) {
                marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                marker.setAttribute('id', markerId);
                marker.setAttribute('markerWidth', '10');
                marker.setAttribute('markerHeight', '10');
                marker.setAttribute('refX', '9');
                marker.setAttribute('refY', '3');
                marker.setAttribute('orient', 'auto');
                const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                polygon.setAttribute('points', '0 0, 10 3, 0 6');
                polygon.setAttribute('fill', currentArrowColor);
                marker.appendChild(polygon);
                arrowLayer.querySelector('defs').appendChild(marker);
            }

            // 创建预览箭头
            currentArrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            currentArrow.setAttribute('x1', fromX);
            currentArrow.setAttribute('y1', fromY);
            currentArrow.setAttribute('x2', fromX);
            currentArrow.setAttribute('y2', fromY);
            currentArrow.setAttribute('stroke', currentArrowColor);
            currentArrow.setAttribute('stroke-width', '2');
            currentArrow.setAttribute('marker-end', 'url(#' + markerId + ')');
            currentArrow.setAttribute('opacity', '0.6'); // 预览时半透明

            arrowLayer.appendChild(currentArrow);

            canvas.addEventListener('mousemove', updateArrowPreview);
        }

        // 更新箭头预览（跟随鼠标）
        function updateArrowPreview(e) {
            if (!currentArrow || !arrowStart) return;

            const canvasRect = canvas.getBoundingClientRect();
            const x = e.clientX - canvasRect.left + canvas.scrollLeft;
            const y = e.clientY - canvasRect.top + canvas.scrollTop;

            currentArrow.setAttribute('x2', x);
            currentArrow.setAttribute('y2', y);
        }

        // 点击画布空白处取消起点选择
        canvas.addEventListener('click', (e) => {
            if (!arrowMode) return;
            // 优先：若点击了代码文本，作为选点
            const lineContentEl = e.target && e.target.closest ? e.target.closest('.code-line-content') : null;
            if (lineContentEl) {
                e.stopPropagation();
                handleLineContentClick(lineContentEl, e.clientX);
                return;
            }

            // 若点击的不是代码文本，则取消起点和预览
            if (arrowStart) {
                if (currentArrow) {
                    currentArrow.remove();
                    currentArrow = null;
                }
                canvas.removeEventListener('mousemove', updateArrowPreview);
                arrowStart = null;
            }
        });

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
                    const fromCol = (arrow.from.col || 1);
                    const toCol = (arrow.to.col || 1);

                    const p1 = getAnchorPoint(arrow.from.block, arrow.from.line, fromCol);
                    const p2 = getAnchorPoint(arrow.to.block, arrow.to.line, toCol);
                    if (!p1 || !p2) return;
                    const fromX = p1.x;
                    const fromY = p1.y;
                    const toX = p2.x;
                    const toY = p2.y;

                    const arrowColor = arrow.color || '#007acc';
                    const markerId = 'arrowhead-' + arrowColor.replace('#', '');

                    // 确保标记存在
                    let marker = arrowLayer.querySelector('#' + markerId);
                    if (!marker) {
                        marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                        marker.setAttribute('id', markerId);
                        marker.setAttribute('markerWidth', '10');
                        marker.setAttribute('markerHeight', '10');
                        marker.setAttribute('refX', '9');
                        marker.setAttribute('refY', '3');
                        marker.setAttribute('orient', 'auto');
                        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                        polygon.setAttribute('points', '0 0, 10 3, 0 6');
                        polygon.setAttribute('fill', arrowColor);
                        marker.appendChild(polygon);
                        arrowLayer.querySelector('defs').appendChild(marker);
                    }

                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', fromX);
                    line.setAttribute('y1', fromY);
                    line.setAttribute('x2', toX);
                    line.setAttribute('y2', toY);
                    line.setAttribute('stroke', arrowColor);
                    line.setAttribute('stroke-width', '2');
                    line.setAttribute('marker-end', 'url(#' + markerId + ')');
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
            if (isResizing && resizeTarget && resizeStart) {
                const canvasRect = canvas.getBoundingClientRect();
                const dx = e.clientX - resizeStart.mouseX;
                const dy = e.clientY - resizeStart.mouseY;

                let newLeft = resizeStart.left;
                let newTop = resizeStart.top;
                let newW = resizeStart.width;
                let newH = resizeStart.height;

                const hasN = resizeDir.includes('n');
                const hasS = resizeDir.includes('s');
                const hasW = resizeDir.includes('w');
                const hasE = resizeDir.includes('e');

                if (hasE) newW = resizeStart.width + dx;
                if (hasS) newH = resizeStart.height + dy;
                if (hasW) {
                    newW = resizeStart.width - dx;
                    newLeft = resizeStart.left + dx;
                }
                if (hasN) {
                    newH = resizeStart.height - dy;
                    newTop = resizeStart.top + dy;
                }

                // 限制最小尺寸；若从左/上缩小到最小，需要回推 left/top
                if (newW < MIN_W) {
                    if (hasW) newLeft -= (MIN_W - newW);
                    newW = MIN_W;
                }
                if (newH < MIN_H) {
                    if (hasN) newTop -= (MIN_H - newH);
                    newH = MIN_H;
                }

                // 不允许拖到负坐标
                newLeft = Math.max(0, newLeft);
                newTop = Math.max(0, newTop);

                resizeTarget.style.left = newLeft + 'px';
                resizeTarget.style.top = newTop + 'px';
                resizeTarget.style.width = newW + 'px';
                resizeTarget.style.height = newH + 'px';

                // 连接点位置依赖 block 的 top/height，但点本身是绝对定位于 block 内部（不会自动重算 top）
                // 这里保持点在原 line 上即可（缩放不会改变行数/行高），所以只需要更新箭头
                updateArrows();
                return;
            }

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
            if (isResizing) {
                isResizing = false;
                resizeTarget = null;
                resizeDir = null;
                resizeStart = null;
                document.body.style.userSelect = '';
                recordAndSave();
                return;
            }
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
                            // 给 code-line-content 打上 data-line，便于精确定位到“真实行居中”
                            return \`<div class="code-line"><span class="code-line-number">\${lineNum}</span><span class="code-line-content" data-line="\${lineNum}">\${escapeHtml(line || ' ')}</span></div>\`;
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
