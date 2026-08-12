let thumbnailCache = new Map();

const ext = {
    name: "Comfy.LoadImageGallery",
    async init() {
        const style = document.createElement('style');
        style.textContent = `
            .comfy-context-menu-filter {
                grid-column: 1 / -1;
            }
            .tabs {
                grid-column: 1 / -1;
                display: flex;
                flex-wrap: wrap;
                width: auto;
            }
            .subtabs {
                flex-basis: 100%;
            }
            .image-entry {
                width: 80px;
                height: 80px;
                background-size: cover;
                background-position: center;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                font-size: 0!important;
                position: relative;
            }
            .delete-button {
                position: absolute;
                top: 2px;
                right: 2px;
                width: 20px;
                height: 20px;
                background-color: rgba(255, 0, 0, 0.7);
                color: white;
                border-radius: 50%;
                display: flex;
                justify-content: center;
                cursor: pointer;
                font-size: 14px !important;
            }
            .tab-button {
                position: absolute;
                top: 2px;
                left: 2px;
                width: 20px;
                height: 20px;
                background-color: rgba(0, 100, 255, 0.7);
                color: white;
                border-radius: 50%;
                display: flex;
                justify-content: center;
                cursor: pointer;
                font-size: 14px !important;
            }
            .tab {
                padding: 5px 10px;
                margin-right: 5px;
                background-color: transparent;
                border: none;
                cursor: pointer;
            }
            .tab:last-child {
                margin-right: 0;
            }
            .tab.active {
                border-bottom: 3px solid #64b5f6;
            }
        `;
        document.head.append(style);

        const LiteGraph = window.LiteGraph || globalThis.LiteGraph;
        if (!LiteGraph || !LiteGraph.ContextMenu) {
            console.warn("[ComfyUI-Load-Image-Gallery] LiteGraph.ContextMenu not found.");
            return;
        }

        const origContextMenu = LiteGraph.ContextMenu;
        let FirstRun = true;

        async function preloadThumbnailsBatch(filenames) {
            if (!window.thumbnailCache) {
                window.thumbnailCache = new Map();
            }
            try {
                const response = await fetch('/get_thumbnails_batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filenames }),
                });
                if (response.ok) {
                    const data = await response.json();
                    for (const [filename, dataUrl] of Object.entries(data)) {
                        window.thumbnailCache.set(filename, dataUrl);
                    }
                }
            } catch (error) {
                console.error("[ComfyUI-Load-Image-Gallery] Error preloading thumbnails batch:", error);
            }
        }

        function CleanDB(values) {
            fetch('/cleanup_thumbnails', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ active_files: values }),
            })
            .then(response => {
                if (response.ok) {
                    console.log("[ComfyUI-Load-Image-Gallery] Cleaned up stale thumbnails");
                }
            })
            .catch(error => {
                console.error("[ComfyUI-Load-Image-Gallery] Error during thumbnails cleanup:", error);
            });
            FirstRun = false;
        }

        async function deleteFile(filename) {
            try {
                const response = await fetch('/delete_file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename }),
                });
                return response.ok;
            } catch (error) {
                console.error('[ComfyUI-Load-Image-Gallery] Error deleting file:', error);
                return false;
            }
        }

        function CustomContextMenu(values, options) {
            let ctx;
            try {
                ctx = new origContextMenu(values, options);
            } catch (e) {
                ctx = origContextMenu.call(this, values, options);
            }

            if (!values || !Array.isArray(values) || values.length === 0 || !ctx || !ctx.root) {
                return ctx;
            }

            const items = Array.from(ctx.root.querySelectorAll(".litemenu-entry, .litecontextmenu-entry"));
            let displayedItems = [...items];

            function UpdatePosition() {
                if (!options?.event?.clientY || !ctx?.root) return;
                let top = options.event.clientY - 10;
                const bodyRect = document.body?.getBoundingClientRect();
                const rootRect = ctx.root.getBoundingClientRect();
                if (bodyRect?.height && top > bodyRect.height - rootRect.height - 10) {
                    top = Math.max(0, bodyRect.height - rootRect.height - 10);
                }
                ctx.root.style.top = top + "px";
            }

            requestAnimationFrame(() => {
                if (!ctx?.root) return;

                const activeApp = window.comfyAPI?.app?.app || window.app;
                const canvas = window.LGraphCanvas?.active_canvas || activeApp?.canvas;
                const currentNode = options?.node || options?.extra?.node || canvas?.current_node || (canvas?.selected_nodes ? Object.values(canvas.selected_nodes)[0] : null);

                let selectedIndex = 0;
                if (currentNode?.widgets) {
                    const clickedComboValue = currentNode.widgets
                        .filter((w) => w?.type === "combo" && w?.options?.values?.length === values.length)
                        .find((w) => w?.options?.values?.every((v, i) => v === values[i] || v === values[i]?.content))?.value;

                    if (clickedComboValue) {
                        const foundIdx = values.findIndex((v) => v === clickedComboValue || v?.content === clickedComboValue);
                        if (foundIdx >= 0) selectedIndex = foundIdx;
                    }
                }

                const selectedItem = displayedItems[selectedIndex] || displayedItems[0];
                let valuesnames = [];
                let rgthreeon = false;

                if (
                    typeof values[values.length - 1]?.rgthree_originalValue === 'string' &&
                    values[values.length - 1].rgthree_originalValue.trim() !== ''
                ) {
                    valuesnames = values.map(item =>
                        typeof item?.rgthree_originalValue === 'string' && item.rgthree_originalValue.trim() !== ''
                            ? item.rgthree_originalValue
                            : 'rgthreefolder'
                    );
                    rgthreeon = true;
                } else {
                    valuesnames = values.map(item => typeof item === 'string' ? item : (item?.content || item?.value || String(item)));
                }

                // Subfolder Tabs for combo dropdowns with subpaths
                if (!rgthreeon && valuesnames.some(value => typeof value === 'string' && (value.includes('\\') || value.includes('/')))) {
                    const hasBackslash = valuesnames.some(value => typeof value === 'string' && value.includes('\\'));
                    const separator = hasBackslash ? '\\' : '/';

                    const structure = { Root: { files: [] } };
                    items.forEach(entry => {
                        const path = entry.getAttribute('data-value') || entry.textContent || "";
                        const parts = path.split(separator);
                        let current = structure;
                        if (parts.length === 1) {
                            structure.Root.files.push(entry);
                        } else {
                            for (let i = 0; i < parts.length - 1; i++) {
                                const folder = parts[i];
                                if (!current[folder]) current[folder] = { files: [] };
                                current = current[folder];
                            }
                            current.files.push(entry);
                        }
                    });

                    function createTabs(container, subStructure) {
                        Object.keys(subStructure).forEach(key => {
                            if (key === 'files') return;
                            const tab = document.createElement('button');
                            tab.textContent = key;
                            tab.className = 'tab';
                            tab.onclick = () => showGroup(container, key, subStructure);
                            if (key === 'Root') {
                                container.prepend(tab);
                            } else {
                                container.appendChild(tab);
                            }
                        });
                    }

                    function showGroup(container, folder, parent) {
                        const subtabs = container.querySelectorAll('.subtabs');
                        subtabs.forEach(subtab => subtab.remove());

                        const current = parent[folder];
                        if (!current) return;
                        const files = current.files || [];
                        const subfolders = Object.keys(current).filter(key => key !== 'files');

                        items.forEach(entry => entry.style.display = 'none');

                        if (folder === 'Root') {
                            items.forEach(item => {
                                const itemPath = item.getAttribute('data-value') || item.textContent || "";
                                if (!itemPath.includes(separator)) {
                                    item.style.display = 'block';
                                }
                            });
                        } else {
                            files.forEach(file => file.style.display = 'block');
                        }

                        if (subfolders.length > 0) {
                            const subtabsContainer = document.createElement('div');
                            subtabsContainer.className = 'subtabs';
                            container.appendChild(subtabsContainer);
                            createTabs(subtabsContainer, current);

                            subfolders.forEach(subfolder => {
                                const subtab = Array.from(subtabsContainer.querySelectorAll('button')).find(t => t.textContent === subfolder);
                                if (subtab) {
                                    subtab.onclick = () => showGroup(subtabsContainer, subfolder, current);
                                }
                            });
                        }

                        container.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                        const tabs = container.querySelectorAll('button');
                        tabs.forEach(tab => {
                            if (tab.textContent === folder) {
                                tab.classList.add('active');
                            }
                        });
                    }

                    const input = ctx.root.querySelector('input');
                    const tabsContainer = document.createElement('div');
                    tabsContainer.className = 'tabs';

                    if (input) {
                        input.insertAdjacentElement('afterend', tabsContainer);
                    } else {
                        ctx.root.prepend(tabsContainer);
                    }

                    createTabs(tabsContainer, structure);

                    const selectedPath = (selectedItem?.getAttribute('data-value') || selectedItem?.textContent || "").split(separator);
                    const selectedFolders = selectedPath.slice(0, -1);

                    if (selectedFolders.length === 0) {
                        showGroup(tabsContainer, 'Root', structure);
                    } else {
                        let currentContainer = tabsContainer;
                        let currentParent = structure;

                        selectedFolders.forEach((folder, index) => {
                            showGroup(currentContainer, folder, currentParent);
                            const subtabs = currentContainer.querySelectorAll('.subtabs');
                            if (subtabs.length > 0) {
                                currentContainer = subtabs[subtabs.length - 1];
                            }
                            if (currentParent && currentParent[folder]) {
                                currentParent = currentParent[folder];
                            }
                        });
                    }

                    UpdatePosition();
                }

                // Image Gallery Grid for LoadImage nodes
                const nodeType = currentNode?.type || currentNode?.comfyClass || "";
                const isLoadImageNode = typeof nodeType === "string" && (nodeType.startsWith("LoadImage") || nodeType.includes("LoadImage"));

                if (valuesnames.length > 0 && isLoadImageNode) {
                    const isChannelList = nodeType === "LoadImageMask" && valuesnames.some(v => ["alpha", "red", "green", "blue"].includes(v));
                    if (!isChannelList) {
                        if (FirstRun) {
                            CleanDB(valuesnames);
                        }
                        if (displayedItems.length > 30) {
                            UpdatePosition();
                        }
                        options.scroll_speed = 0.5;
                        ctx.root.style.display = 'grid';
                        ctx.root.style.gridTemplateColumns = 'repeat(auto-fit, minmax(88px, 1fr))';
                        ctx.root.style.maxWidth = "880px";

                        const tabsContainer = ctx.root.querySelector('.tabs');
                        if (tabsContainer) {
                            const tabsWidth = Array.from(tabsContainer.children).reduce((width, tab) => width + tab.offsetWidth, 0);
                            const cellWidth = 88;
                            const minCells = 4;
                            const maxCells = 10;
                            const requiredCells = Math.ceil(tabsWidth / cellWidth);
                            const finalCells = Math.max(minCells, Math.min(requiredCells, maxCells));
                            ctx.root.style.gridTemplateColumns = `repeat(${finalCells}, ${cellWidth}px)`;
                        }

                        items.forEach((entry, index) => {
                            const filename = valuesnames[index];
                            if (filename !== "rgthreefolder") {
                                entry.classList.add('image-entry');
                                entry.setAttribute('title', filename);
                            }
                        });

                        preloadThumbnailsBatch(valuesnames).then(() => {
                            items.forEach((entry, index) => {
                                if (!document.body.contains(entry)) return;
                                const filename = valuesnames[index];
                                if (filename !== "rgthreefolder") {
                                    let thumbnailUrl = window.thumbnailCache?.get(filename);
                                    if (!thumbnailUrl) {
                                        thumbnailUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAYAAACOEfKtAAAACXBIWXMAAAsTAAALEwEAmpwYAAAE7mlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgOS4xLWMwMDIgNzkuZjM1NGVmYywgMjAyMy8xMS8wOS0xMjo0MDoyNyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnBob3Rvc2hvcD0iaHR0cDovL25zLmFkb2JlLmNvbS9waG90b3Nob3AvMS4wLyIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDI1LjUgKFdpbmRvd3MpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAyNS0wNS0yMVQxODoyMjozNyswMzowMCIgeG1wOk1vZGlmeURhdGU9IjIwMjUtMDUtMjFUMTg6MjI6NTkrMDM6MDAiIHhtcDpNZXRhZGF0YURhdGU9IjIwMjUtMDUtMjFUMTg6MjI6NTkrMDM6MDAiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjkyNmFjZTg2LTM0ZDUtMWM0OS05ZTkyLTg3NDQ1ZGQ3ZWQ5NSIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDo5MjZhY2U4Ni0zNGQ1LTFjNDktOWU5Mi04NzQ0NWRkN2VkOTUiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDo5MjZhY2U4Ni0zNGQ1LTFjNDktOWU5Mi04NzQ0NWRkN2VkOTUiPiA8eG1wTU06SGlzdG9yeT4gPHJkZjpTZXE+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjcmVhdGVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjkyNmFjZTg2LTM0ZDUtMWM0OS05ZTkyLTg3NDQ1ZGQ3ZWQ5NSIgc3RFdnQ6d2hlbj0iMjAyNS0wNS0yMVQxODoyMjozNyswMzowMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIDI1LjUgKFdpbmRvd3MpIi8+IDwvcmRmOlNlcT4gPC94bXBNTTpIaXN0b3J5PiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Pjdh6DQAAAPZSURBVHic7dtNaBx1GMfx3zM7LwtCtVAUteJJUJBQBaFgLahQ0EjcF/FkpQFbRMSbFnopyUUQQREKNuCp6GXd+cewoQq+1RfwpBehCDkILSISEHyJyU47Py+JLHVtsvPM7D+Lz+e2szt/Hr6ZmZ3dJEISprjA9wCTzgIqWUAlC6hkAZUsoJIFVLKAShZQyQIqWUAlC6hkAZUsoJIFVLKAShZQyQIqWUAlC6hkAZUsoJIFVArLXvBKqzVN4CxEbi97baXLkucnQufOl7lo6UcgRd7ehfEAYD+D4GzZi1ZxCu+vYM2y3FH2gnYNVLKAShZQqfR34VGQ7AP4bvPhfSIS+5ynCH9HILlC8kDi3MHEuYMkD4Bc8TZPQd4CShAcry8uXtx6XF9cvChBcNzXPEV5CUhgI1xd/era7WEQfEly3cdMRXkJKECCvXtv/NcTWXYTRBIPIxXm7RTuB8HLw7YJID7mKcrbu7AAJ/ut1s0i8i4AMM+fAXDM1zxFeb2NATBLchYAIBN14P3DbqSVLKDSRAcksEbyZ5K5rxkmNeD3Qh6Ja7U9iXO3xll2C4DTmx8Nx8r3m8jISH4Wh+GMdDp/bG2TXm8VwHzWbn+R5/kHIrJnXPNM1BFI4HwchtOD8QZF3e7nAB4m8Mu4ZhprQAK/k5yDyOG8Vrs7B5oELuxsZ3bjWq0hnc5f13tZ4ty3BA4B+LGEkbclZf+zYdZuD1+QXMnD8Il6p/PDtU/1m82XCLwhIsN/oOS5KAxnpdO5utM5/pyZuS0Kw48A3Du4Pep2S73hHMsRSOCbCHhwWDwAiJ17i8BTQ79IIBeiqaljo8QDgBuWln6KNjYOk/y64Ng7Mo6A78e12iPi3HWvS3XnXABMk/xtaxuBM5Fzz8vcXKHbFFle/jXOsiMESv1V5qBKA5J8NUrTp7e7bm2JnPuU5LOb+84nafqiAKprjPR6a/G+fU+CfE+zzn+pJCDJjMBziXOnRgmw1mrdGYi8DuBk4tzpsuaRhYUsmpo6WtZ6gyoJGIg8nopT0/z+vL3uV+35vR00x2s0i/l+n4xZz6x8tV2005u3r8';
                                    }
                                    entry.style.backgroundImage = `url('${thumbnailUrl}')`;

                                    if (!entry.querySelector('.delete-button')) {
                                        const deleteButton = document.createElement('div');
                                        deleteButton.classList.add('delete-button');
                                        deleteButton.textContent = '×';
                                        deleteButton.setAttribute('title', 'Delete');
                                        deleteButton.addEventListener('click', async (e) => {
                                            e.stopPropagation();
                                            if (await deleteFile(filename)) {
                                                // 1. Remove element from open DOM menu
                                                entry.remove();

                                                // 2. Remove from local valuesnames array
                                                const idx = valuesnames.indexOf(filename);
                                                if (idx !== -1) valuesnames.splice(idx, 1);

                                                // 3. Remove from context menu values array
                                                const vIdx = values.findIndex(v => v === filename || v?.content === filename || v?.rgthree_originalValue === filename);
                                                if (vIdx !== -1) values.splice(vIdx, 1);

                                                // 4. Remove from thumbnail cache
                                                if (window.thumbnailCache) {
                                                    window.thumbnailCache.delete(filename);
                                                }

                                                // 5. Update widget.options.values across all nodes on graph
                                                const activeApp = window.comfyAPI?.app?.app || window.app;
                                                const currentCanvas = window.LGraphCanvas?.active_canvas || activeApp?.canvas;
                                                const graphNodes = activeApp?.graph?._nodes || currentCanvas?.graph?._nodes || [];
                                                for (const node of graphNodes) {
                                                    if (!node.widgets) continue;
                                                    for (const w of node.widgets) {
                                                        if (w.type === "combo" && Array.isArray(w.options?.values)) {
                                                            const idxInWidget = w.options.values.findIndex(v => v === filename || v?.content === filename || v?.rgthree_originalValue === filename);
                                                            if (idxInWidget !== -1) {
                                                                w.options.values.splice(idxInWidget, 1);
                                                                if (w.value === filename || w.value?.content === filename) {
                                                                    w.value = w.options.values[0] || "";
                                                                    if (typeof w.callback === "function") {
                                                                        w.callback(w.value);
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        });
                                        entry.appendChild(deleteButton);
                                    }
                                }
                            });
                        });
                    }
                }
            });

            return ctx;
        }

        CustomContextMenu.prototype = origContextMenu.prototype;
        LiteGraph.ContextMenu = CustomContextMenu;
    },
};

// Register extension cleanly without importing deprecated legacy script shims
function register() {
    const appInstance = window.comfyAPI?.app?.app || window.app;
    if (appInstance?.registerExtension) {
        appInstance.registerExtension(ext);
    } else {
        setTimeout(register, 20);
    }
}

register();
