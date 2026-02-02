import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface CodeBlock {
    name?: string; // 代码块显示名称，默认值等于id（codeMap中的key）
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
        // 使用 x/y 表示“相对代码块内容区域左上角”的偏移（不再使用行号/列号）
        from: { block: string; x: number; y: number };
        to: { block: string; x: number; y: number };
        color?: string; // 箭头颜色，默认为主题色
        alpha?: number; // 箭头透明度，0~1，默认 1
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

        // 自动命名：查找"所有代码块中、标题为纯数字"的最大值 + 1
        // 用户手动改名后大概率不是纯数字，因此不纳入计算
        const numericOnly = /^\d+$/;
        let maxNum = 0;
        for (const [title, block] of Object.entries(data.codeMap)) {
            if (!numericOnly.test(title)) continue;
            const n = parseInt(title, 10);
            if (!Number.isNaN(n) && n > maxNum) maxNum = n;
        }

        // 生成新的id
        let nextNum = maxNum + 1;
        let blockName = String(nextNum);
        while (data.codeMap[blockName]) {
            nextNum += 1;
            blockName = String(nextNum);
        }

        // 添加新代码块
        const newBlock: CodeBlock = {
            name: blockName, // 默认name等于id
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
                data: data,
                newBlockName: blockName // 标记新添加的代码块名称
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; connect-src 'none';">
    <title>CodeMapFree</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css" id="hljs-theme">
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

        .canvas-container > .canvas-content {
            position: relative;
            min-width: 100%;
            min-height: 100%;
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

        .code-block.selected {
            border-color: var(--vscode-textLink-foreground);
            box-shadow: 0 0 0 2px rgba(0,0,0,0.05), 0 6px 18px rgba(0,0,0,0.25);
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
            padding: 0px 8px;
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
            height: calc(100% - 30px);
            overflow: auto;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            line-height: 19.5px;
            user-select: text;
            cursor: default; /* 不显示 I 字形光标，保持指针样式 */
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

        .code-line-content span {
            white-space: pre;
        }

        /* highlight.js 样式覆盖，确保在代码块中正确显示 */
        .code-block-content .hljs {
            background: transparent;
            padding: 0;
            display: inline;
        }

        .code-block-content .hljs-keyword,
        .code-block-content .hljs-selector-tag,
        .code-block-content .hljs-literal,
        .code-block-content .hljs-title,
        .code-block-content .hljs-section,
        .code-block-content .hljs-doctag,
        .code-block-content .hljs-type,
        .code-block-content .hljs-name,
        .code-block-content .hljs-strong {
            font-weight: normal;
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

        /* 允许点击箭头线/端点（不阻挡其它区域交互） */
        .arrow-layer line {
            pointer-events: stroke;
            cursor: pointer;
        }
        /* 预览箭头不接收鼠标事件 */
        .arrow-layer line[data-is-preview="true"] {
            pointer-events: none;
            cursor: default;
        }
        .arrow-layer circle {
            pointer-events: all;
            cursor: pointer;
        }
        /* 箭头控件中的元素 */
        .arrow-layer g[data-arrow-widget="true"] line {
            pointer-events: stroke;
            cursor: pointer;
        }
        .arrow-layer g[data-arrow-widget="true"] polygon {
            pointer-events: all;
            cursor: pointer;
        }
        .arrow-layer g[data-arrow-widget="true"] circle {
            pointer-events: all;
            cursor: pointer;
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

        .arrow-alpha-input {
            width: 80px;
            cursor: pointer;
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
        <input type="range" class="arrow-alpha-input" id="arrowAlphaInput" min="0.45" max="1" step="0.05" value="0.45" title="透明度 (45% - 100%)">
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
        <div class="canvas-content" id="canvasContent">
            <svg class="arrow-layer" id="arrowLayer">
                <defs>
                    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="0" refY="3" orient="auto">
                        <polygon points="0 0, 10 3, 0 6" fill="var(--vscode-textLink-foreground)" />
                    </marker>
                </defs>
            </svg>
        </div>
    </div>
    <div class="cmf-menu" id="cmfMenu"></div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const canvas = document.getElementById('canvas');
        const canvasContent = document.getElementById('canvasContent');
        const arrowLayer = document.getElementById('arrowLayer');
        const arrowTool = document.getElementById('arrowTool');
        const arrowColorPicker = document.getElementById('arrowColorPicker');
        const arrowColorInput = document.getElementById('arrowColorInput');
        const arrowAlphaInput = document.getElementById('arrowAlphaInput');
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
        let currentArrowAlpha = 0.45; // 默认透明度（最低值）
        const LINE_HEIGHT = 19.5;
        const CODE_PADDING_X = 10; // .code-block-content padding
        const LINE_NUM_GUTTER_W = 50; // .code-line-number width (CSS)
        const LINE_NUM_GAP_W = 10; // .code-line-number margin-right (CSS)
        const HEADER_HEIGHT = 30; // .code-block-header height (approximate)
        const BORDER_WIDTH = 2; // .code-block border width
        const CODE_FONT_SIZE = 13; // font-size in .code-block-content

        // 跟踪新添加的代码块（用于自动调整尺寸）
        let pendingAutoSizeBlock = null;

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
            const keyLower = (e.key || '').toLowerCase();

            // Ctrl+Z / Cmd+Z
            if (mod && keyLower === 'z' && !e.shiftKey) {
                e.preventDefault();
                undo();
                return;
            }
            // Ctrl+Y / Cmd+Shift+Z
            if (mod && (keyLower === 'y' || (keyLower === 'z' && e.shiftKey))) {
                e.preventDefault();
                redo();
                return;
            }

            // Delete / Backspace：删除选中箭头或选中代码块
            if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
                // 端点编辑中按 Delete：先退出编辑态（避免状态悬挂）
                if (editingArrowEndpoint) {
                    editingArrowEndpoint = null;
                    stopEndpointPreview();
                    updateBlockInteractivity();
                }
                if (selectedArrowIndex !== -1) {
                    e.preventDefault();
                    deleteSelectedArrow();
                    return;
                }
                if (selectedBlockName) {
                    e.preventDefault();
                    deleteSelectedBlock();
                    return;
                }
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

        // 交换两个代码块的id
        function swapBlockIds(id1, id2) {
            if (!codeMapData.codeMap[id1] || !codeMapData.codeMap[id2] || id1 === id2) return;

            const block1 = codeMapData.codeMap[id1];
            const block2 = codeMapData.codeMap[id2];

            // 交换codeMap中的位置
            codeMapData.codeMap[id1] = block2;
            codeMapData.codeMap[id2] = block1;

            // 更新箭头中的引用
            arrows.forEach(arrow => {
                if (arrow.from.block === id1) {
                    arrow.from.block = id2;
                } else if (arrow.from.block === id2) {
                    arrow.from.block = id1;
                }
                if (arrow.to.block === id1) {
                    arrow.to.block = id2;
                } else if (arrow.to.block === id2) {
                    arrow.to.block = id1;
                }
            });

            loadCodeBlocks();
            recordAndSave();
        }

        // 获取所有数字id
        function getNumericIds() {
            const numericOnly = /^\\d+$/;
            const ids = [];
            Object.keys(codeMapData.codeMap).forEach(id => {
                if (numericOnly.test(id)) {
                    ids.push(parseInt(id, 10));
                }
            });
            return ids.sort((a, b) => a - b);
        }

        // 上移一层：和id比自己大的最小对象交换id
        function moveBlockUp(blockId) {
            const numericOnly = /^\\d+$/;
            if (!numericOnly.test(blockId)) return;
            const currentId = parseInt(blockId, 10);
            const numericIds = getNumericIds();
            const nextId = numericIds.find(id => id > currentId);
            if (nextId !== undefined) {
                swapBlockIds(blockId, String(nextId));
            }
        }

        // 下移一层：和id比自己小的最大对象交换id
        function moveBlockDown(blockId) {
            const numericOnly = /^\\d+$/;
            if (!numericOnly.test(blockId)) return;
            const currentId = parseInt(blockId, 10);
            const numericIds = getNumericIds();
            const prevId = numericIds.filter(id => id < currentId).pop();
            if (prevId !== undefined) {
                swapBlockIds(blockId, String(prevId));
            }
        }

        // 移动到最上层：自己的id变成最大id，比自己大的所有id都-1
        function moveBlockToTop(blockId) {
            const numericOnly = /^\\d+$/;
            if (!numericOnly.test(blockId)) return;
            const currentId = parseInt(blockId, 10);
            const numericIds = getNumericIds();
            const maxId = numericIds[numericIds.length - 1];
            if (currentId >= maxId) return; // 已经在最上层

            // 找到所有比自己大的id，按从小到大排序
            const largerIds = numericIds.filter(id => id > currentId);

            // 先收集所有需要移动的数据（深拷贝，避免引用问题）
            const moves = [];
            // 当前块要移动到maxId
            moves.push({
                from: blockId,
                to: String(maxId),
                data: JSON.parse(JSON.stringify(codeMapData.codeMap[blockId]))
            });
            // 所有比自己大的块都要-1（从currentId开始依次填充）
            largerIds.forEach((id, index) => {
                const fromId = String(id);
                const toId = String(currentId + index);
                moves.push({
                    from: fromId,
                    to: toId,
                    data: JSON.parse(JSON.stringify(codeMapData.codeMap[fromId]))
                });
            });

            // 先更新所有箭头引用（建立映射关系）
            const idMapping = {};
            moves.forEach(move => {
                idMapping[move.from] = move.to;
            });

            arrows.forEach(arrow => {
                if (idMapping[arrow.from.block]) {
                    arrow.from.block = idMapping[arrow.from.block];
                }
                if (idMapping[arrow.to.block]) {
                    arrow.to.block = idMapping[arrow.to.block];
                }
            });

            // 删除所有旧的条目（先删除，避免覆盖）
            moves.forEach(move => {
                delete codeMapData.codeMap[move.from];
            });

            // 创建所有新的条目（一次性创建，避免覆盖）
            moves.forEach(move => {
                codeMapData.codeMap[move.to] = move.data;
            });

            loadCodeBlocks();
            recordAndSave();
        }

        // 移动到最下层：自己的id变成最小id，比自己小的所有id都+1
        function moveBlockToBottom(blockId) {
            const numericOnly = /^\\d+$/;
            if (!numericOnly.test(blockId)) return;
            const currentId = parseInt(blockId, 10);
            const numericIds = getNumericIds();
            const minId = numericIds[0];
            if (currentId <= minId) return; // 已经在最下层

            // 找到所有比自己小的id，按从小到大排序
            const smallerIds = numericIds.filter(id => id < currentId);

            // 先把自己的id改成临时id（使用一个很大的数字，确保不会冲突）
            const tempId = String(minId + 1000);
            const blockData = codeMapData.codeMap[blockId];
            codeMapData.codeMap[tempId] = blockData;
            delete codeMapData.codeMap[blockId];

            // 更新箭头中的引用（先指向临时id）
            arrows.forEach(arrow => {
                if (arrow.from.block === blockId) arrow.from.block = tempId;
                if (arrow.to.block === blockId) arrow.to.block = tempId;
            });

            // 所有比自己小的id都+1
            smallerIds.reverse().forEach(id => {
                const idStr = String(id);
                const data = codeMapData.codeMap[idStr];
                const newIdStr = String(id + 1);
                codeMapData.codeMap[newIdStr] = data;
                delete codeMapData.codeMap[idStr];

                // 更新箭头中的引用
                arrows.forEach(arrow => {
                    if (arrow.from.block === idStr) arrow.from.block = newIdStr;
                    if (arrow.to.block === idStr) arrow.to.block = newIdStr;
                });
            });

            // 把自己的id改成最小id
            const newMinId = String(minId);
            codeMapData.codeMap[newMinId] = codeMapData.codeMap[tempId];
            delete codeMapData.codeMap[tempId];

            // 更新箭头中的引用
            arrows.forEach(arrow => {
                if (arrow.from.block === tempId) arrow.from.block = newMinId;
                if (arrow.to.block === tempId) arrow.to.block = newMinId;
            });

            loadCodeBlocks();
            recordAndSave();
        }

        function getNextNumericNameForPath(filePath) {
            // 查找所有代码块中、标题为纯数字的最大值 + 1（不再限制路径）
            const numericOnly = /^\\d+$/;
            let maxNum = 0;
            Object.entries(codeMapData.codeMap).forEach(([title, block]) => {
                if (!block) return;
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
                name: name, // 默认name等于id
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
            if (e.key === 'Escape') {
                // ESC：退出端点编辑/取消选中箭头，并退出箭头模式
                if (editingArrowEndpoint || selectedArrowIndex !== -1) {
                    clearArrowSelection();
                }
                if (arrowMode) {
                    arrowMode = false;
                    arrowTool.classList.remove('active');
                    arrowColorPicker.classList.remove('active');
                    // 清理新箭头预览
                    if (arrowStart) {
                        if (currentArrow) {
                            currentArrow.remove();
                            currentArrow = null;
                        }
                        canvas.removeEventListener('mousemove', updateArrowPreview);
                        arrowStart = null;
                    }
                    // 清理端点编辑预览
                    editingArrowEndpoint = null;
                    stopEndpointPreview();
                    canvas.style.cursor = 'default';
                    updateBlockInteractivity();
                }
            }
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

            // 生成标题栏菜单项的函数
            function getHeaderMenuItems(blockName, event) {
                return [
                    {
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
                    },
                    {
                        label: '删除此代码块',
                        onClick: async () => deleteBlock(blockName)
                    },
                    {
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
                                createPastedBlockAt(event.clientX, event.clientY, payload);
                            } catch (err) {
                                vscode.postMessage({ command: 'showError', message: '解析剪贴板中的代码块数据失败' });
                            }
                        }
                    },
                    'sep',
                    {
                        label: '上移一层',
                        onClick: async () => moveBlockUp(blockName)
                    },
                    {
                        label: '下移一层',
                        onClick: async () => moveBlockDown(blockName)
                    },
                    {
                        label: '移动到最上层',
                        onClick: async () => moveBlockToTop(blockName)
                    },
                    {
                        label: '移动到最下层',
                        onClick: async () => moveBlockToBottom(blockName)
                    }
                ];
            }

            if (blockName && inHeader) {
                items.push(...getHeaderMenuItems(blockName, e));
            }

            if (blockName && inContent) {
                // 内容区域菜单顺序：复制选择内容 -> 复制整个代码块内容 -> 分割线 -> 继承标题菜单
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
                items.push(...getHeaderMenuItems(blockName, e));
            }

            // 如果不在代码块内，显示"在此粘贴新代码块"
            if (!blockName) {
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
            }

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

        // 点击外部关闭颜色选择器（但不退出箭头模式）
        document.addEventListener('click', (e) => {
            if (arrowMode && arrowColorPicker.classList.contains('active')) {
                // 如果点击的不是箭头按钮和颜色选择器内部
                if (!arrowTool.contains(e.target) && !arrowColorPicker.contains(e.target)) {
                    // 只关闭颜色选择器，不退出箭头模式
                    arrowColorPicker.classList.remove('active');
                }
            }
        });

        // 窗口大小改变时重新定位
        window.addEventListener('resize', () => {
            if (arrowMode && arrowColorPicker.classList.contains('active')) {
                positionColorPicker();
            }
            updateCanvasSize(); // 窗口大小改变时更新画布尺寸
        });

        // 颜色选择器事件
        arrowColorInput.addEventListener('input', (e) => {
            currentArrowColor = e.target.value;
            // 若当前有选中箭头，则实时更新该箭头颜色
            if (selectedArrowIndex !== -1 && arrows[selectedArrowIndex]) {
                arrows[selectedArrowIndex].color = currentArrowColor;
                updateArrows();
                recordAndSave();
            }
        });

        // 透明度滑条事件（20%~100%）
        arrowAlphaInput.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) {
                currentArrowAlpha = v;
                if (selectedArrowIndex !== -1 && arrows[selectedArrowIndex]) {
                    arrows[selectedArrowIndex].alpha = currentArrowAlpha;
                    updateArrows();
                    recordAndSave();
                }
            }
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
                // 预设颜色同时作用于当前选中箭头
                if (selectedArrowIndex !== -1 && arrows[selectedArrowIndex]) {
                    arrows[selectedArrowIndex].color = currentArrowColor;
                    updateArrows();
                    recordAndSave();
                }
            });
        });

        function isArrowLikeModeActive() {
            // arrowMode：创建箭头
            // editingArrowEndpoint：编辑端点（也需要禁用块交互，但允许点代码行选点）
            return !!arrowMode || !!editingArrowEndpoint;
        }

        // 更新代码块交互性（箭头模式/端点编辑模式下禁用）
        function updateBlockInteractivity() {
            Object.values(codeBlocks).forEach(block => {
                const disabled = isArrowLikeModeActive();
                if (disabled) {
                    block.element.style.pointerEvents = 'none';
                    block.content.style.userSelect = 'none';
                    block.content.style.cursor = 'default';
                } else {
                    block.element.style.pointerEvents = 'auto';
                    block.content.style.userSelect = 'text';
                    // 非箭头模式下也保持指针样式，而不是 I 字形
                    block.content.style.cursor = 'default';
                }
                // 箭头模式下允许点击"代码文本"来选择列（J）
                block.element.querySelectorAll('.code-line-content').forEach(el => {
                    // 即便禁用了 block.element，也允许点击代码文本来选点
                    el.style.pointerEvents = 'auto';
                    // 箭头模式下用十字，普通模式用指针，不再出现 I 字形
                    el.style.cursor = disabled ? 'crosshair' : 'default';
                });
            });
        }


        /**
         * 基于"代码块内容区域"的相对偏移计算在 canvas 中的锚点坐标。
         * xOffset / yOffset：相对于 .code-block-content 的内容原点（scrollLeft/scrollTop 为 0 时的左上角）。
         */
        function getAnchorPoint(blockName, xOffset, yOffset) {
            const b = codeBlocks[blockName];
            if (!b || !b.content) return null;

            const canvasRect = canvas.getBoundingClientRect();
            const contentEl = b.content;
            const contentRect = contentEl.getBoundingClientRect();

            // contentRect.left/top 是"当前可视区域左上角"；减去 scroll 才是内容原点
            const originXInCanvas =
                contentRect.left - canvasRect.left + canvas.scrollLeft - contentEl.scrollLeft;
            const originYInCanvas =
                contentRect.top - canvasRect.top + canvas.scrollTop - contentEl.scrollTop;

            const x = originXInCanvas + (xOffset || 0);
            const y = originYInCanvas + (yOffset || 0);
            return { x, y };
        }

        function getBlockNameFromLineContent(lineContentEl) {
            const blockEl = lineContentEl.closest('.code-block');
            return blockEl ? blockEl.dataset.blockName : null;
        }

        /**
         * 根据点击位置计算相对代码块内容区域的 x/y 偏移（不做字符/行对齐，完全跟随鼠标）。
         */
        function getOffsetsFromClick(lineContentEl, clientX, clientY) {
            const blockContent = lineContentEl.closest('.code-block')?.querySelector('.code-block-content');
            if (!blockContent) return null;

            const contentRect = blockContent.getBoundingClientRect();

            // X/Y：点击点相对"内容原点"的偏移 =（点击点相对可视区域的偏移）+ scroll
            const xOffset = (clientX - contentRect.left) + blockContent.scrollLeft;
            const yOffset = (clientY - contentRect.top) + blockContent.scrollTop;

            return { xOffset, yOffset };
        }

        // 更新画布尺寸（根据代码块位置动态扩展）
        function updateCanvasSize() {
            if (!canvasContent) return;

            const blocks = Object.values(codeBlocks);
            if (blocks.length === 0) {
                // 没有代码块时，保持最小尺寸
                canvasContent.style.minWidth = '100%';
                canvasContent.style.minHeight = '100%';
                return;
            }

            // 计算所有代码块的边界（直接使用存储的位置数据）
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            blocks.forEach(block => {
                const data = block.data;
                const x = data.x || 0;
                const y = data.y || 0;
                const right = x + (data.w || 400);
                const bottom = y + (data.h || 300);

                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, right);
                maxY = Math.max(maxY, bottom);
            });

            // 获取当前窗口尺寸
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight - 40; // 减去工具栏高度

            // 设置画布最小尺寸：最右代码块右边 + 窗口宽，最下代码块底边 + 窗口高
            const minWidth = Math.max(100, maxX + windowWidth);
            const minHeight = Math.max(100, maxY + windowHeight);

            canvasContent.style.minWidth = minWidth + 'px';
            canvasContent.style.minHeight = minHeight + 'px';
        }

        // 加载代码块
        function loadCodeBlocks() {
            // 清空现有代码块
            Object.values(codeBlocks).forEach(block => block.element.remove());
            codeBlocks = {};

            // 创建代码块
            for (const [name, blockData] of Object.entries(codeMapData.codeMap)) {
                // 为旧数据设置默认name值（兼容旧数据），并确保name在第一位
                if (!blockData.name) {
                    codeMapData.codeMap[name] = {
                        name: name,
                        ...blockData
                    };
                } else if (Object.keys(blockData)[0] !== 'name') {
                    // 如果name不在第一位，重新构建对象确保name在第一位
                    const { name: blockName, ...rest } = blockData;
                    codeMapData.codeMap[name] = {
                        name: blockName,
                        ...rest
                    };
                }
                createCodeBlock(name, codeMapData.codeMap[name]);
            }

            updateArrows();
            updateBlockInteractivity();
            updateCanvasSize(); // 更新画布尺寸
            // 重建后恢复"代码块选中"样式（如果块仍存在）
            if (selectedBlockName && codeBlocks[selectedBlockName]?.element) {
                codeBlocks[selectedBlockName].element.classList.add('selected');
            } else if (selectedBlockName) {
                selectedBlockName = null;
            }
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
            const displayName = blockData.name || name; // 使用name属性，如果没有则使用id（兼容旧数据）
            title.textContent = \`\${blockData.path}@\${blockData.start_line}:\${blockData.end_line}@\${displayName}\`;
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
                // 使用"当前显示名称"（name属性），如果没有则使用id（兼容旧数据）
                const blockId = title.dataset.blockName || name;
                const currentDisplayName = blockData.name || blockId;
                input.value = currentDisplayName;
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
                    const newDisplayName = input.value.trim();
                    if (!newDisplayName || newDisplayName === currentDisplayName) {
                        restore();
                        return;
                    }
                    renameBlock(blockId, newDisplayName);
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

            canvasContent.appendChild(block);

            codeBlocks[name] = {
                element: block,
                data: blockData,
                header: header,
                content: content,
                title: title
            };

            // 单击选中代码块（用于 Delete 删除）
            block.addEventListener('click', (e) => {
                // 箭头模式/端点编辑模式下：不做代码块选中（避免与选点交互冲突）
                if (isArrowLikeModeActive()) return;
                // 正在重命名时不触发选中
                if (isTextEditingTarget(document.activeElement)) return;
                e.stopPropagation();
                // 隐藏右键菜单
                hideMenu();
                // 选中代码块时取消箭头选中
                if (selectedArrowIndex !== -1) clearArrowSelection();
                setSelectedBlock(name);
            });

            // 初始创建时若当前已选中该块，补上样式
            if (selectedBlockName === name) {
                block.classList.add('selected');
            }

            // 加载代码内容
            vscode.postMessage({
                command: 'getCode',
                id: name,
                path: blockData.path,
                startLine: blockData.start_line,
                endLine: blockData.end_line
            });

            // 拖动功能（只有左键才允许拖动）
            header.addEventListener('mousedown', (e) => {
                if (arrowMode) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                // 只有左键（button === 0）才允许拖动
                if (e.button !== 0) return;
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


        // 处理"代码文本点击"（两次点击完成连接，记录相对内容区域的 x/y 偏移）
        function handleLineContentClick(lineContentEl, clientX, clientY) {
            const blockName = getBlockNameFromLineContent(lineContentEl);
            if (!blockName) return;

            const offsets = getOffsetsFromClick(lineContentEl, clientX, clientY);
            if (!offsets) return;
            const { xOffset, yOffset } = offsets;

            if (!arrowStart) {
                // 第一次点击：记录起点偏移，开始实时绘制箭头预览
                arrowStart = {
                    block: blockName,
                    x: xOffset,
                    y: yOffset,
                    blockElement: lineContentEl.closest('.code-block')
                };
                startArrowPreview();
                return;
            }

            // 起点和终点完全相同就忽略
            if (arrowStart.block === blockName &&
                (arrowStart.x || 0) === xOffset &&
                (arrowStart.y || 0) === yOffset) {
                return;
            }

            // 第二次点击：完成箭头连接
            const arrow = {
                from: { block: arrowStart.block, x: arrowStart.x, y: arrowStart.y },
                to: { block: blockName, x: xOffset, y: yOffset },
                color: currentArrowColor,
                alpha: currentArrowAlpha
            };
            arrows.push(arrow);

            // 新创建的箭头默认视为被选中
            const newIndex = arrows.length - 1;
            selectArrow(newIndex);

            // 清除预览箭头
            if (currentArrow) {
                currentArrow.remove();
                currentArrow = null;
            }
            canvas.removeEventListener('mousemove', updateArrowPreview);

            updateArrows();
            recordAndSave();

            // 连接完成后保持在箭头模式，方便连续画多条箭头
            arrowStart = null;
        }

        // 开始箭头预览（第一次点击后，实时跟随鼠标）
        function startArrowPreview() {
            if (!arrowStart) return;

            const p = getAnchorPoint(arrowStart.block, arrowStart.x, arrowStart.y);
            if (!p) return;
            const fromX = p.x;
            const fromY = p.y;

            // 创建箭头标记（包含颜色和透明度信息）
            const markerId = 'arrowhead-' + currentArrowColor.replace('#', '') + '-' + String(currentArrowAlpha).replace('.', '_');
            let marker = arrowLayer.querySelector('#' + markerId);
            if (!marker) {
                marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                marker.setAttribute('id', markerId);
                marker.setAttribute('markerWidth', '10');
                marker.setAttribute('markerHeight', '10');
                marker.setAttribute('refX', '0');
                marker.setAttribute('refY', '3');
                marker.setAttribute('orient', 'auto');
                const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                polygon.setAttribute('points', '0 0, 10 3, 0 6');
                polygon.setAttribute('fill', currentArrowColor);
                polygon.setAttribute('fill-opacity', String(currentArrowAlpha));
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
            currentArrow.setAttribute('stroke-opacity', String(currentArrowAlpha));
            currentArrow.setAttribute('marker-end', 'url(#' + markerId + ')');
            currentArrow.setAttribute('opacity', '0.6'); // 预览时整体半透明
            // 预览箭头不接收鼠标事件，避免干扰代码块的点击
            currentArrow.style.pointerEvents = 'none';
            currentArrow.dataset.isPreview = 'true'; // 标识为预览箭头

            arrowLayer.appendChild(currentArrow);

            canvas.addEventListener('mousemove', updateArrowPreview);
        }

        // 更新箭头预览（跟随鼠标）
        function updateArrowPreview(e) {
            if (!currentArrow || !arrowStart) return;

            const canvasRect = canvas.getBoundingClientRect();
            const toX = e.clientX - canvasRect.left + canvas.scrollLeft;
            const toY = e.clientY - canvasRect.top + canvas.scrollTop;

            // 获取起点位置
            const p = getAnchorPoint(arrowStart.block, arrowStart.x, arrowStart.y);
            if (!p) return;
            const fromX = p.x;
            const fromY = p.y;

            // 计算箭头方向向量和长度
            const dx = toX - fromX;
            const dy = toY - fromY;
            const length = Math.sqrt(dx * dx + dy * dy);
            const TRIANGLE_LENGTH = 16; // 三角形长度（与 createArrowWidget 保持一致）

            // 调整线条终点：真实绘制长度 = 现在的长度 - 三角形的长度
            let adjustedToX = toX;
            let adjustedToY = toY;
            if (length > TRIANGLE_LENGTH) {
                const unitX = dx / length;
                const unitY = dy / length;
                adjustedToX = toX - unitX * TRIANGLE_LENGTH;
                adjustedToY = toY - unitY * TRIANGLE_LENGTH;
            }

            currentArrow.setAttribute('x2', adjustedToX);
            currentArrow.setAttribute('y2', adjustedToY);
        }

        // 点击画布空白处取消起点选择
        canvas.addEventListener('click', (e) => {
            const lineContentEl = e.target && e.target.closest ? e.target.closest('.code-line-content') : null;

            // 端点编辑模式：点击代码文本来改端点
            if (editingArrowEndpoint) {
                if (lineContentEl) {
                    e.stopPropagation();
                    const blockName = getBlockNameFromLineContent(lineContentEl);
                    if (!blockName) return;
                    const offsets = getOffsetsFromClick(lineContentEl, e.clientX, e.clientY);
                    if (!offsets) return;
                    const { xOffset, yOffset } = offsets;
                    const { index, endpoint } = editingArrowEndpoint;
                    // 先退出编辑态再写盘
                    editingArrowEndpoint = null;
                    stopEndpointPreview();
                    canvas.style.cursor = 'default';
                    updateBlockInteractivity();
                    updateArrowEndpointTo(index, endpoint, blockName, xOffset, yOffset);
                } else {
                    // 点击空白：退出端点编辑，但保留"选中箭头"
                    editingArrowEndpoint = null;
                    stopEndpointPreview();
                    canvas.style.cursor = 'default';
                    updateBlockInteractivity();
                    scheduleUpdateArrows();
                }
                return;
            }

            // 非 arrowMode：点击空白取消选中箭头
            if (!arrowMode) {
                if (selectedArrowIndex !== -1) {
                    clearArrowSelection();
                }
                if (selectedBlockName) {
                    clearBlockSelection();
                }
                return;
            }

            // arrowMode：优先若点击了代码文本，作为选点
            if (lineContentEl) {
                e.stopPropagation();
                handleLineContentClick(lineContentEl, e.clientX, e.clientY);
                return;
            }

            // arrowMode下，如果已经选择了起点，点击空白区域时忽略这次点击（不取消起点）
            // 让用户可以继续点击直到找到正确的终点
            if (arrowStart) {
                // 忽略这次点击，保持起点和预览状态
                return;
            }
        });

        // 创建箭头控件（封装在一个group中）
        function createArrowWidget(idx, fromX, fromY, toX, toY, arrowColor, arrowAlpha, isSelected) {
            // 增大三角形尺寸，使其更明显
            const TRIANGLE_LENGTH = 16; // 三角形长度
            const TRIANGLE_HEIGHT = 12; // 三角形高度
            const TRIANGLE_CENTER_Y = TRIANGLE_HEIGHT / 2; // 三角形中心Y坐标（6）

            // 计算箭头方向向量和长度
            const dx = toX - fromX;
            const dy = toY - fromY;
            const length = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;

            // 计算单位向量
            const unitX = length > 0 ? dx / length : 0;
            const unitY = length > 0 ? dy / length : 0;

            // 调整线条终点：真实绘制长度 = 现在的长度 - 三角形的长度
            // 这样箭头尖端才能指向正确的 toX, toY 位置
            const adjustedToX = length > TRIANGLE_LENGTH ? toX - unitX * TRIANGLE_LENGTH : toX;
            const adjustedToY = length > TRIANGLE_LENGTH ? toY - unitY * TRIANGLE_LENGTH : toY;

            // 创建主容器 group
            const arrowGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            arrowGroup.dataset.arrowIndex = String(idx);
            arrowGroup.dataset.arrowWidget = 'true';

            // 创建线条
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(fromX));
            line.setAttribute('y1', String(fromY));
            line.setAttribute('x2', String(adjustedToX));
            line.setAttribute('y2', String(adjustedToY));
            line.setAttribute('stroke', arrowColor);
            line.setAttribute('stroke-width', isSelected ? '3' : '2');
            line.setAttribute('stroke-opacity', String(arrowAlpha));
            line.style.cursor = 'pointer';
            line.style.pointerEvents = 'stroke';
            arrowGroup.appendChild(line);

            // 创建三角形（箭头头部）
            // 三角形从 (0, 0) 开始，向右延伸到 (TRIANGLE_LENGTH, TRIANGLE_CENTER_Y)，底部在 (0, TRIANGLE_HEIGHT)
            // 旋转中心在 (0, TRIANGLE_CENTER_Y)，这样旋转后尖端会指向正确方向
            const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            const trianglePoints = [
                [0, 0],                              // 顶部
                [TRIANGLE_LENGTH, TRIANGLE_CENTER_Y], // 右侧尖点
                [0, TRIANGLE_HEIGHT]                // 底部
            ];
            const pointsStr = trianglePoints.map(p => p.join(',')).join(' ');
            triangle.setAttribute('points', pointsStr);
            triangle.setAttribute('fill', arrowColor);
            triangle.setAttribute('fill-opacity', String(arrowAlpha));
            triangle.setAttribute('stroke', 'none');
            // 先平移到调整后的终点（三角形底部中心），然后围绕底部中心旋转
            // 这样三角形会从 adjustedToX, adjustedToY 开始，向右延伸，尖端在 toX, toY
            triangle.setAttribute('transform', \`translate(\${adjustedToX}, \${adjustedToY - TRIANGLE_CENTER_Y}) rotate(\${angle}, 0, \${TRIANGLE_CENTER_Y})\`);
            triangle.style.cursor = 'pointer';
            triangle.style.pointerEvents = 'all';
            arrowGroup.appendChild(triangle);

            // 统一的事件处理
            const handleClick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                selectArrow(idx);
            };
            line.addEventListener('click', handleClick);
            triangle.addEventListener('click', handleClick);

            // 若选中该箭头：绘制端点圆点
            if (isSelected) {
                const r = 5;
                const mkCircle = (cx, cy, endpoint) => {
                    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    c.setAttribute('cx', String(cx));
                    c.setAttribute('cy', String(cy));
                    c.setAttribute('r', String(r));
                    c.setAttribute('fill', arrowColor);
                    c.setAttribute('fill-opacity', String(arrowAlpha));
                    c.setAttribute('stroke', 'rgba(0,0,0,0.25)');
                    c.setAttribute('stroke-width', '1');
                    c.dataset.endpoint = endpoint;
                    c.style.cursor = 'pointer';
                    c.style.pointerEvents = 'all';
                    c.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        beginEditArrowEndpoint(idx, endpoint);
                    });
                    return c;
                };
                // 起点圆点
                arrowGroup.appendChild(mkCircle(fromX, fromY, 'from'));
                // 终点圆点画在三角形尖端（toX, toY）
                arrowGroup.appendChild(mkCircle(toX, toY, 'to'));
            }

            return arrowGroup;
        }

        // 更新所有箭头
        function updateArrows() {
            // 清空现有箭头控件（除了正在绘制的）
            arrowLayer.querySelectorAll('g[data-arrow-widget="true"]').forEach(el => {
                el.remove();
            });

            // 绘制箭头
            arrows.forEach((arrow, idx) => {
                const fromBlock = codeBlocks[arrow.from.block];
                const toBlock = codeBlocks[arrow.to.block];

                if (fromBlock && toBlock) {
                    const p1 = getAnchorPoint(arrow.from.block, arrow.from.x, arrow.from.y);
                    const p2 = getAnchorPoint(arrow.to.block, arrow.to.x, arrow.to.y);
                    if (!p1 || !p2) return;

                    const arrowColor = arrow.color || '#007acc';
                    const arrowAlpha = (typeof arrow.alpha === 'number') ? arrow.alpha : 1;
                    const isSelected = selectedArrowIndex === idx;

                    // 创建箭头控件
                    const arrowWidget = createArrowWidget(idx, p1.x, p1.y, p2.x, p2.y, arrowColor, arrowAlpha, isSelected);
                    arrowLayer.appendChild(arrowWidget);
                }
            });
        }

        // 箭头重绘调度：避免在 codeContent 批量到达时频繁重算，同时保证“异步加载代码内容后”一定重绘
        let arrowsRedrawScheduled = false;
        function scheduleUpdateArrows() {
            if (arrowsRedrawScheduled) return;
            arrowsRedrawScheduled = true;
            requestAnimationFrame(() => {
                arrowsRedrawScheduled = false;
                updateArrows();
            });
        }

        // =========================
        // Arrow select & edit endpoints
        // =========================
        let selectedArrowIndex = -1; // -1 表示未选中
        // { index: number, endpoint: 'from'|'to' } | null
        let editingArrowEndpoint = null;
        // 端点编辑的实时预览线（从固定端到鼠标）
        let endpointPreviewLine = null;
        // 代码块选中（单击选中，Delete 删除）
        let selectedBlockName = null; // string | null

        function stopEndpointPreview() {
            if (endpointPreviewLine) {
                try { endpointPreviewLine.remove(); } catch (e) { /* ignore */ }
                endpointPreviewLine = null;
            }
            document.removeEventListener('mousemove', updateEndpointPreview);
        }

        function startEndpointPreview() {
            if (!editingArrowEndpoint) return;
            stopEndpointPreview();
            const { index } = editingArrowEndpoint;
            const a = arrows[index];
            const arrowColor = (a && a.color) ? a.color : '#007acc';
            endpointPreviewLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            // 预览线用同色，方便辨识；虚线表示“正在编辑”
            endpointPreviewLine.setAttribute('stroke', arrowColor);
            endpointPreviewLine.setAttribute('stroke-width', '2');
            endpointPreviewLine.setAttribute('opacity', '0.8');
            endpointPreviewLine.setAttribute('stroke-dasharray', '4 4');
            endpointPreviewLine.style.pointerEvents = 'none';
            arrowLayer.appendChild(endpointPreviewLine);
            // 立即初始化一次（先从固定端到固定端），保证“刚点圆点就能看到线”
            try {
                updateEndpointPreview({ clientX: 0, clientY: 0 });
            } catch (e) {
                // ignore
            }
            document.addEventListener('mousemove', updateEndpointPreview);
        }

        function updateEndpointPreview(e) {
            if (!endpointPreviewLine || !editingArrowEndpoint) return;
            const { index, endpoint } = editingArrowEndpoint;
            const a = arrows[index];
            if (!a) return;

            // 固定端：编辑 from 时固定 to；编辑 to 时固定 from
            const fixed = endpoint === 'from'
                ? getAnchorPoint(a.to.block, a.to.x, a.to.y)
                : getAnchorPoint(a.from.block, a.from.x, a.from.y);
            if (!fixed) return;

            const canvasRect = canvas.getBoundingClientRect();
            // 若是"初始化调用"（clientX/Y=0），则先画成固定端到当前端，避免出现 0,0 飞线
            let toX = e.clientX - canvasRect.left + canvas.scrollLeft;
            let toY = e.clientY - canvasRect.top + canvas.scrollTop;
            if (!e.clientX && !e.clientY) {
                const cur = endpoint === 'from'
                    ? getAnchorPoint(a.from.block, a.from.x, a.from.y)
                    : getAnchorPoint(a.to.block, a.to.x, a.to.y);
                if (cur) {
                    toX = cur.x;
                    toY = cur.y;
                } else {
                    toX = fixed.x;
                    toY = fixed.y;
                }
            }

            // 计算箭头方向向量和长度
            const dx = toX - fixed.x;
            const dy = toY - fixed.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            const TRIANGLE_LENGTH = 16; // 三角形长度（与 createArrowWidget 保持一致）

            // 调整线条终点：真实绘制长度 = 现在的长度 - 三角形的长度
            // 但只在编辑 'to' 端点时需要调整（因为三角形在 'to' 端）
            let adjustedToX = toX;
            let adjustedToY = toY;
            if (endpoint === 'to' && length > TRIANGLE_LENGTH) {
                const unitX = dx / length;
                const unitY = dy / length;
                adjustedToX = toX - unitX * TRIANGLE_LENGTH;
                adjustedToY = toY - unitY * TRIANGLE_LENGTH;
            }

            endpointPreviewLine.setAttribute('x1', String(fixed.x));
            endpointPreviewLine.setAttribute('y1', String(fixed.y));
            endpointPreviewLine.setAttribute('x2', String(adjustedToX));
            endpointPreviewLine.setAttribute('y2', String(adjustedToY));
        }

        function clearArrowSelection() {
            selectedArrowIndex = -1;
            editingArrowEndpoint = null;
            stopEndpointPreview();
            canvas.style.cursor = arrowMode ? 'crosshair' : 'default';
            updateBlockInteractivity();
            scheduleUpdateArrows();
        }

        function setSelectedBlock(name) {
            selectedBlockName = name || null;
            Object.values(codeBlocks).forEach((b) => {
                const bn = b && b.element && b.element.dataset ? b.element.dataset.blockName : null;
                if (!bn) return;
                b.element.classList.toggle('selected', selectedBlockName === bn);
            });
        }

        function clearBlockSelection() {
            setSelectedBlock(null);
        }

        function deleteSelectedArrow() {
            if (selectedArrowIndex < 0 || selectedArrowIndex >= (arrows || []).length) return;
            arrows.splice(selectedArrowIndex, 1);
            clearArrowSelection();
            updateArrows();
            recordAndSave();
        }

        function deleteSelectedBlock() {
            if (!selectedBlockName) return;
            const bn = selectedBlockName;
            clearBlockSelection();
            deleteBlock(bn);
        }

        function selectArrow(index) {
            if (index < 0 || index >= (arrows || []).length) return;
            selectedArrowIndex = index;
            editingArrowEndpoint = null;

            // 选中箭头时，同步颜色/透明度到面板；若无 alpha 则默认为 1
            const a = arrows[index];
            if (a) {
                if (a.color) {
                    currentArrowColor = a.color;
                    if (arrowColorInput) {
                        arrowColorInput.value = a.color;
                    }
                } else {
                    // 没有存颜色时，保持当前面板颜色
                    a.color = currentArrowColor;
                }
                const alpha = (typeof a.alpha === 'number') ? a.alpha : 1;
                currentArrowAlpha = alpha;
                if (arrowAlphaInput) {
                    arrowAlphaInput.value = String(alpha);
                }
            }

            scheduleUpdateArrows();
        }

        function beginEditArrowEndpoint(index, endpoint) {
            if (index < 0 || index >= (arrows || []).length) return;
            selectedArrowIndex = index;
            editingArrowEndpoint = { index, endpoint };
            scheduleUpdateArrows();
            startEndpointPreview();
            canvas.style.cursor = 'crosshair';
            updateBlockInteractivity();
        }

        function updateArrowEndpointTo(index, endpoint, block, xOffset, yOffset) {
            if (index < 0 || index >= (arrows || []).length) return;
            const a = arrows[index];
            if (!a) return;
            if (endpoint === 'from') {
                a.from = { block, x: xOffset, y: yOffset };
            } else {
                a.to = { block, x: xOffset, y: yOffset };
            }
            updateArrows();
            recordAndSave();
        }

        // 重命名代码块（只修改name属性，不修改codeMap的key）
        function renameBlock(blockId, newDisplayName) {
            const block = codeBlocks[blockId];
            if (!block) return;

            // 只修改name属性，不修改codeMap的key（blockId保持不变），并确保name在第一位
            const oldBlockData = codeMapData.codeMap[blockId];
            const { name: _, ...rest } = oldBlockData;
            codeMapData.codeMap[blockId] = {
                name: newDisplayName,
                ...rest
            };
            block.data.name = newDisplayName;

            // 更新标题显示
            const displayName = newDisplayName;
            block.title.textContent = \`\${block.data.path}@\${block.data.start_line}:\${block.data.end_line}@\${displayName}\`;

            recordAndSave();
        }

        // 保存数据
        function saveData() {
            // 更新代码块位置和大小
            for (const [name, block] of Object.entries(codeBlocks)) {
                const rect = block.element.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();
                const x = rect.left - canvasRect.left + canvas.scrollLeft;
                const y = rect.top - canvasRect.top + canvas.scrollTop;
                const w = rect.width;
                const h = rect.height;

                codeMapData.codeMap[name].x = x;
                codeMapData.codeMap[name].y = y;
                codeMapData.codeMap[name].w = w;
                codeMapData.codeMap[name].h = h;

                // 同步更新 block.data，供 updateCanvasSize 使用
                block.data.x = x;
                block.data.y = y;
                block.data.w = w;
                block.data.h = h;
            }

            codeMapData.arrows = arrows;
            vscode.postMessage({
                command: 'save',
                data: codeMapData
            });

            // 保存后更新画布尺寸
            updateCanvasSize();
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
                updateCanvasSize(); // 缩放时更新画布尺寸
                return;
            }

            if (isDragging && dragTarget) {
                const canvasRect = canvas.getBoundingClientRect();
                const x = e.clientX - canvasRect.left + canvas.scrollLeft - dragOffset.x;
                const y = e.clientY - canvasRect.top + canvas.scrollTop - dragOffset.y;
                dragTarget.style.left = Math.max(0, x) + 'px';
                dragTarget.style.top = Math.max(0, y) + 'px';
                updateArrows();
                updateCanvasSize(); // 拖动时更新画布尺寸
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

                    // 如果有新代码块，标记为待自动调整尺寸
                    if (message.newBlockName && codeBlocks[message.newBlockName]) {
                        pendingAutoSizeBlock = message.newBlockName;
                        // 尺寸将在codeContent消息中计算并应用
                    }

                    // 外部新增/更新也纳入历史（并清空 redo）
                    recordSnapshot();
                    break;
                case 'codeContent':
                    if (codeBlocks[message.id]) {
                        // 缓存原始代码，供"复制整个代码块内容"使用
                        codeBlocks[message.id].rawCode = message.code || '';
                        const code = message.code;
                        const blockData = codeBlocks[message.id].data;
                        const language = detectLanguage(blockData.path);
                        const codeHtml = highlightCode(code, language, blockData.start_line);
                        codeBlocks[message.id].content.innerHTML = codeHtml;

                        // 如果是新代码块，计算并应用最佳尺寸
                        if (pendingAutoSizeBlock === message.id) {
                            const block = codeBlocks[message.id];

                            // 等待DOM完全渲染后再计算尺寸（使用requestAnimationFrame确保渲染完成）
                            requestAnimationFrame(() => {
                                const optimalSize = calculateOptimalBlockSize(code, block.element, block.content);

                                // 更新代码块尺寸
                                block.element.style.width = optimalSize.width + 'px';
                                block.element.style.height = optimalSize.height + 'px';
                                block.data.w = optimalSize.width;
                                block.data.h = optimalSize.height;

                                // 计算画布中心位置（考虑滚动）
                                const canvasRect = canvas.getBoundingClientRect();
                                const centerX = canvas.scrollLeft + canvasRect.width / 2;
                                const centerY = canvas.scrollTop + canvasRect.height / 2;

                                // 计算代码块左上角位置（居中）
                                const blockX = Math.max(0, centerX - optimalSize.width / 2);
                                const blockY = Math.max(0, centerY - optimalSize.height / 2);

                                // 更新代码块位置
                                block.element.style.left = blockX + 'px';
                                block.element.style.top = blockY + 'px';
                                block.data.x = blockX;
                                block.data.y = blockY;

                                // 选中新代码块（清除箭头选中状态）
                                if (selectedArrowIndex !== -1) {
                                    clearArrowSelection();
                                }
                                setSelectedBlock(message.id);

                                // 清除待处理标记
                                pendingAutoSizeBlock = null;

                                // 更新画布尺寸和箭头
                                updateCanvasSize();
                                updateArrows();

                                // 保存位置和尺寸变更
                                saveData();
                            });
                        }

                        // 关键：undo/redo 会先重建块，再异步返回 codeContent；
                        // 若不在这里重绘，箭头会因为"锚点行 DOM 尚未存在"而消失，直到下一次交互触发 updateArrows
                        scheduleUpdateArrows();
                    }
                    break;
            }
        });

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // 根据文件路径确定语言类型
        function detectLanguage(filePath) {
            if (!filePath) return null;
            const ext = filePath.split('.').pop()?.toLowerCase();
            const langMap = {
                'js': 'javascript',
                'jsx': 'javascript',
                'ts': 'typescript',
                'tsx': 'typescript',
                'py': 'python',
                'java': 'java',
                'c': 'c',
                'cpp': 'cpp',
                'cc': 'cpp',
                'cxx': 'cpp',
                'h': 'c',
                'hpp': 'cpp',
                'cs': 'csharp',
                'php': 'php',
                'rb': 'ruby',
                'go': 'go',
                'rs': 'rust',
                'swift': 'swift',
                'kt': 'kotlin',
                'scala': 'scala',
                'sh': 'bash',
                'bash': 'bash',
                'zsh': 'bash',
                'ps1': 'powershell',
                'sql': 'sql',
                'html': 'html',
                'htm': 'html',
                'xml': 'xml',
                'css': 'css',
                'scss': 'scss',
                'sass': 'sass',
                'less': 'less',
                'json': 'json',
                'yaml': 'yaml',
                'yml': 'yaml',
                'md': 'markdown',
                'markdown': 'markdown',
                'vue': 'xml',
                'jsx': 'javascript',
                'tsx': 'typescript'
            };
            return langMap[ext] || null;
        }

        // 使用 highlight.js 高亮代码并保持行号
        function highlightCode(code, language, startLine) {
            if (!code || !code.trim()) {
                return '<div class="code-line"><span class="code-line-number"></span><span class="code-line-content" data-line="' + startLine + '"> </span></div>';
            }

            let highlightedCode = '';
            // 检查 highlight.js 是否已加载
            if (language && typeof window !== 'undefined' && window.hljs && typeof window.hljs.highlight === 'function') {
                try {
                    // 检查语言是否支持
                    if (window.hljs.getLanguage(language)) {
                        const result = window.hljs.highlight(code, { language: language });
                        highlightedCode = result.value;
                    } else {
                        // 语言不支持，尝试自动检测
                        const result = window.hljs.highlightAuto(code);
                        highlightedCode = result.value;
                    }
                } catch (e) {
                    // 高亮失败，使用转义的纯文本
                    highlightedCode = escapeHtml(code);
                }
            } else {
                // highlight.js 未加载，使用转义的纯文本
                highlightedCode = escapeHtml(code);
            }

            const lines = highlightedCode.split('\\n');
            return lines.map((line, i) => {
                const lineNum = startLine + i;
                return \`<div class="code-line"><span class="code-line-number">\${lineNum}</span><span class="code-line-content" data-line="\${lineNum}">\${line || ' '}</span></div>\`;
            }).join('');
        }

        // 计算代码块的最佳尺寸（根据内容自动适配）
        function calculateOptimalBlockSize(code, blockElement, contentElement) {
            if (!code || !blockElement || !contentElement) {
                return { width: 400, height: 300 };
            }

            const lines = code.split('\\n');
            const lineCount = lines.length;

            // 使用实际渲染后的DOM元素来测量宽度（更准确）
            // contentElement已经包含了渲染后的代码行
            let maxLineWidth = 0;
            const lineContentElements = contentElement.querySelectorAll('.code-line-content');

            if (lineContentElements.length > 0) {
                // 使用实际渲染后的元素测量
                lineContentElements.forEach(lineEl => {
                    // 临时设置为不换行，测量实际宽度
                    const originalWhiteSpace = lineEl.style.whiteSpace;
                    lineEl.style.whiteSpace = 'pre';
                    const width = lineEl.scrollWidth;
                    lineEl.style.whiteSpace = originalWhiteSpace;
                    if (width > maxLineWidth) {
                        maxLineWidth = width;
                    }
                });
            } else {
                // 如果DOM还未渲染，使用文本测量
                const measureEl = document.createElement('span');
                measureEl.style.position = 'absolute';
                measureEl.style.visibility = 'hidden';
                measureEl.style.whiteSpace = 'pre';
                measureEl.style.fontFamily = 'Consolas, Monaco, monospace';
                measureEl.style.fontSize = CODE_FONT_SIZE + 'px';
                measureEl.style.padding = '0';
                measureEl.style.margin = '0';
                document.body.appendChild(measureEl);

                lines.forEach(line => {
                    // 移除HTML标签，获取纯文本
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = line || ' ';
                    const textContent = tempDiv.textContent || tempDiv.innerText || '';
                    measureEl.textContent = textContent || ' ';
                    const width = measureEl.offsetWidth;
                    if (width > maxLineWidth) {
                        maxLineWidth = width;
                    }
                });

                document.body.removeChild(measureEl);
            }

            // 计算内容区域宽度
            // 宽度 = 行号宽度 + 行号间距 + 内容宽度 + 左右padding
            const contentWidth = maxLineWidth;
            const totalContentWidth = LINE_NUM_GUTTER_W + LINE_NUM_GAP_W + contentWidth + CODE_PADDING_X * 2;

            // 计算总宽度（包括边框）
            let blockWidth = totalContentWidth + BORDER_WIDTH * 2;

            // 限制最大宽度为窗口的1/2
            const maxWidth = window.innerWidth / 2;
            if (blockWidth > maxWidth) {
                blockWidth = maxWidth;
            }

            // 确保不小于最小宽度
            const minWidth = MIN_W;
            if (blockWidth < minWidth) {
                blockWidth = minWidth;
            }

            // 计算高度
            // 高度 = 标题栏 + 内容高度 + 上下padding + 边框
            const contentHeight = lineCount * LINE_HEIGHT;
            const totalContentHeight = contentHeight + CODE_PADDING_X * 2;
            const blockHeight = HEADER_HEIGHT + totalContentHeight + BORDER_WIDTH * 2;

            // 确保不小于最小高度
            const minHeight = MIN_H;
            const finalHeight = Math.max(blockHeight, minHeight);

            return { width: Math.ceil(blockWidth), height: Math.ceil(finalHeight) };
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
