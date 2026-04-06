import { Plugin, WorkspaceLeaf, PluginSettingTab, App, Setting } from "obsidian";

interface UncapperSettings {
    // Node sizing
    nodeSizeEnabled: boolean;
    baseSize: number;
    sizePerLink: number;
    minSize: number;
    scalingMode: "linear" | "sqrt";

    // Link distance
    linkDistanceEnabled: boolean;
    linkDistanceMax: number;

    // Text fade
    textFadeEnabled: boolean;
    textFadeMode: "always" | "never" | "custom";
    textFadeCustom: number;

    // Graph forces
    forcesEnabled: boolean;
    repelStrengthMax: number;
    centerStrengthMax: number;

    // Graph idle frames
    idleFramesEnabled: boolean;
    idleFramesMode: "custom" | "unlimited";
    idleFramesMax: number;

    // Search results
    searchLimitEnabled: boolean;
    searchLimit: number;

    // Font size
    fontSizeEnabled: boolean;
    fontSizeMin: number;
    fontSizeMax: number;

    // Embed depth
    embedDepthEnabled: boolean;
    embedDepthMax: number;

    // Sidebar width
    sidebarWidthEnabled: boolean;
    sidebarWidthMin: number;

    // App zoom
    appZoomEnabled: boolean;
    appZoomMin: number;
    appZoomMax: number;

    // Tab size
    tabSizeEnabled: boolean;
    tabSizeMin: number;
    tabSizeMax: number;

    // Canvas zoom breakpoint
    canvasZoomEnabled: boolean;
    canvasZoomBreakpoint: number;

    // Adaptive link distance (node-size-aware)
    adaptiveLinkDistanceEnabled: boolean;
    adaptiveLinkDistancePadding: number;
}

const DEFAULT_SETTINGS: UncapperSettings = {
    nodeSizeEnabled: true,
    baseSize: 8,
    sizePerLink: 1.5,
    minSize: 4,
    scalingMode: "sqrt",

    linkDistanceEnabled: false,
    linkDistanceMax: 2000,

    textFadeEnabled: false,
    textFadeMode: "custom",
    textFadeCustom: -5,

    forcesEnabled: false,
    repelStrengthMax: 100,
    centerStrengthMax: 5,

    idleFramesEnabled: false,
    idleFramesMode: "unlimited",
    idleFramesMax: 300,

    searchLimitEnabled: false,
    searchLimit: 500,

    fontSizeEnabled: false,
    fontSizeMin: 6,
    fontSizeMax: 72,

    embedDepthEnabled: false,
    embedDepthMax: 20,

    sidebarWidthEnabled: false,
    sidebarWidthMin: 100,

    appZoomEnabled: false,
    appZoomMin: -5,
    appZoomMax: 6,

    tabSizeEnabled: false,
    tabSizeMin: 1,
    tabSizeMax: 16,

    canvasZoomEnabled: false,
    canvasZoomBreakpoint: 0,

    adaptiveLinkDistanceEnabled: false,
    adaptiveLinkDistancePadding: 10,
};

export default class UncapperPlugin extends Plugin {
    settings: UncapperSettings = DEFAULT_SETTINGS;
    private searchPatched = false;
    private idleKickInterval: number | null = null;
    private adaptiveLinkInterval: number | null = null;
    private _adaptiveLinkDebounceTimer: number | null = null;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new UncapperSettingTab(this.app, this));

        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                this.patchAllGraphViews();
            })
        );

        this.app.workspace.onLayoutReady(() => {
            setTimeout(() => {
                this.patchAllGraphViews();
                this.patchFontSizeLimits();
                this.patchSearchModals();
                this.patchEmbedDepth();
                this.patchSidebarWidth();
                this.patchAppZoom();
                this.patchTabSize();
                this.patchCanvasZoom();
                this.startIdleKick();
                this.startAdaptiveLinkInterval();
            }, 500);
        });
    }

    onunload() {
        this.stopIdleKick();
        this.stopAdaptiveLinkInterval();
        this.restoreAllGraphViews();
        this.restoreFontSizeLimits();
        this.restoreEmbedDepth();
        this.restoreSidebarWidth();
        this.restoreAppZoom();
        this.restoreTabSize();
        this.restoreCanvasZoom();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.patchAllGraphViews();
        this.patchFontSizeLimits();
        this.patchSearchModals();
        this.patchEmbedDepth();
        this.patchSidebarWidth();
        this.patchAppZoom();
        this.patchTabSize();
        this.patchCanvasZoom();
        this.startIdleKick();
        this.startAdaptiveLinkInterval();
    }

    // ── Idle Frame Kick ───────────────────────────────────────
    // The graph render loop stops when idleFrames > 60 and never
    // restarts on its own. We use a low-frequency interval that
    // resets idleFrames and calls renderer.changed() to restart
    // the loop. This avoids wrapping renderCallback entirely.

    private startIdleKick() {
        this.stopIdleKick();
        if (!this.settings.idleFramesEnabled) return;

        // Every 500ms, call changed() on all graph renderers.
        // changed() sets idleFrames=0 and calls queueRender().
        // queueRender() is a no-op if a frame is already pending,
        // so this is safe — it just prevents the idle timeout.
        this.idleKickInterval = window.setInterval(() => {
            if (!this.settings.idleFramesEnabled) return;

            const unlimited = this.settings.idleFramesMode === "unlimited";
            const leaves = [
                ...this.app.workspace.getLeavesOfType("graph"),
                ...this.app.workspace.getLeavesOfType("localgraph"),
            ];

            for (const leaf of leaves) {
                const renderer = (leaf.view as any)?.renderer;
                if (!renderer || typeof renderer.changed !== "function") continue;

                if (unlimited) {
                    // Always keep it alive
                    renderer.changed();
                } else {
                    // Custom mode: only kick if under our threshold
                    // changed() resets idleFrames to 0, so we track
                    // total elapsed kicks instead
                    if (!renderer._uncapperKickCount) renderer._uncapperKickCount = 0;
                    const maxKicks = Math.floor(this.settings.idleFramesMax / 60);
                    if (renderer._uncapperKickCount < maxKicks) {
                        renderer.changed();
                        renderer._uncapperKickCount++;
                    }
                }
            }
        }, 500);
        this.registerInterval(this.idleKickInterval);
    }

    private stopIdleKick() {
        if (this.idleKickInterval !== null) {
            window.clearInterval(this.idleKickInterval);
            this.idleKickInterval = null;
        }
    }

    // ── Node Size ──────────────────────────────────────────────

    calcSize(weight: number): number {
        const { baseSize, sizePerLink, minSize, scalingMode } = this.settings;
        let size: number;
        if (scalingMode === "linear") {
            size = baseSize + weight * sizePerLink;
        } else {
            size = baseSize + sizePerLink * Math.sqrt(weight);
        }
        return Math.max(size, minSize);
    }

    // ── Graph Patching ─────────────────────────────────────────

    private patchAllGraphViews() {
        const leaves = [
            ...this.app.workspace.getLeavesOfType("graph"),
            ...this.app.workspace.getLeavesOfType("localgraph"),
        ];
        for (const leaf of leaves) {
            this.patchGraphLeaf(leaf);
        }
    }

    private restoreAllGraphViews() {
        const leaves = [
            ...this.app.workspace.getLeavesOfType("graph"),
            ...this.app.workspace.getLeavesOfType("localgraph"),
        ];
        for (const leaf of leaves) {
            const view = leaf.view as any;
            const renderer = view?.renderer;
            if (!renderer?.nodes) continue;

            for (const node of renderer.nodes) {
                if (node?._uncapperOriginalGetSize) {
                    node.getSize = node._uncapperOriginalGetSize;
                    delete node._uncapperPatched;
                    delete node._uncapperOriginalGetSize;
                }
            }

            if (renderer._uncapperOriginalSetScale) {
                renderer.setScale = renderer._uncapperOriginalSetScale;
                delete renderer._uncapperOriginalSetScale;
            }

            this.restoreAdaptiveLinkDistance(renderer);

            renderer.changed();
        }
    }

    private patchGraphLeaf(leaf: WorkspaceLeaf) {
        const view = leaf.view as any;
        if (!view) return;

        const renderer = view.renderer;
        if (!renderer) return;

        let dirty = false;

        // ── Patch node sizes ──
        if (this.settings.nodeSizeEnabled && renderer.nodes) {
            for (const node of renderer.nodes) {
                if (!node || typeof node.getSize !== "function") continue;
                if (node._uncapperPatched) continue;

                node._uncapperOriginalGetSize = node.getSize.bind(node);
                node._uncapperPatched = true;
                dirty = true;

                const plugin = this;
                node.getSize = function (this: any) {
                    const w = this.weight || 0;
                    const mult = this.renderer?.fNodeSizeMult ?? 1;
                    return mult * plugin.calcSize(w);
                };
            }
        }

        // ── Patch setScale (text fade + adaptive link distance zoom) ──
        const needsScalePatch = this.settings.textFadeEnabled
            || (this.settings.adaptiveLinkDistanceEnabled && this.settings.nodeSizeEnabled);
        if (needsScalePatch && typeof renderer.setScale === "function") {
            if (!renderer._uncapperOriginalSetScale) {
                renderer._uncapperOriginalSetScale = renderer.setScale.bind(renderer);
                dirty = true;
            }

            const plugin = this;
            const original = renderer._uncapperOriginalSetScale;
            renderer.setScale = function (this: any, e: number) {
                original.call(this, e);

                // Text fade
                if (plugin.settings.textFadeEnabled) {
                    if (plugin.settings.textFadeMode === "always") {
                        this.textAlpha = 1;
                    } else if (plugin.settings.textFadeMode === "never") {
                        this.textAlpha = 0;
                    } else {
                        const n = Math.log(e) / Math.log(2);
                        this.textAlpha = Math.clamp(
                            n + 1 - plugin.settings.textFadeCustom,
                            0,
                            1
                        );
                    }
                }

                // Adaptive link distance: recalculate on zoom change
                if (plugin.settings.adaptiveLinkDistanceEnabled && plugin.settings.nodeSizeEnabled) {
                    plugin.debouncedAdaptiveLinkUpdate(this);
                }
            };
        }

        // Idle frames are handled by the kick interval, not per-leaf patching.

        // ── Patch slider limits ──
        if (this.settings.linkDistanceEnabled || this.settings.forcesEnabled) {
            this.patchGraphOptions(view);
        }

        // ── Adaptive link distance (node-size-aware) ──
        if (this.settings.adaptiveLinkDistanceEnabled && this.settings.nodeSizeEnabled) {
            this.patchAdaptiveLinkDistance(renderer);
        } else {
            this.restoreAdaptiveLinkDistance(renderer);
        }

        if (dirty) {
            renderer.changed();
        }
    }

    private patchGraphOptions(view: any) {
        if (!view.dataEngine) return;
        const controlsEl = view.controlsEl as HTMLElement | undefined;
        if (!controlsEl) return;

        const settings = controlsEl.querySelectorAll(".setting-item");
        for (const settingEl of Array.from(settings)) {
            const nameEl = settingEl.querySelector(".setting-item-name");
            const slider = settingEl.querySelector(
                'input[type="range"]'
            ) as HTMLInputElement | null;
            if (!nameEl || !slider) continue;

            const name = nameEl.textContent?.toLowerCase() || "";

            if (this.settings.linkDistanceEnabled && name.includes("distance")) {
                if (parseFloat(slider.max) < this.settings.linkDistanceMax) {
                    slider.max = String(this.settings.linkDistanceMax);
                }
            }

            if (this.settings.forcesEnabled) {
                if (name.includes("repel")) {
                    if (parseFloat(slider.max) < this.settings.repelStrengthMax) {
                        slider.max = String(this.settings.repelStrengthMax);
                    }
                }
                if (name.includes("center")) {
                    if (parseFloat(slider.max) < this.settings.centerStrengthMax) {
                        slider.max = String(this.settings.centerStrengthMax);
                    }
                }
            }
        }
    }

    // ── Adaptive Link Distance ──────────────────────────────────
    // The graph simulation runs in a Web Worker and accepts a single
    // global linkDistance via renderer.setForces({linkDistance: n}).
    // We wrap setForces to enforce a minimum distance derived from
    // the largest node sizes, and use a periodic interval to
    // re-evaluate as node data changes over time.

    private computeMinLinkDistance(renderer: any): number {
        const nodes = renderer.nodes;
        if (!nodes || nodes.length === 0) return 0;

        let maxSize = 0;
        for (const node of nodes) {
            if (!node || typeof node.getSize !== "function") continue;
            const size = node.getSize();
            if (size > maxSize) maxSize = size;
        }

        // Obsidian renders nodes with nodeScale = √(1/scale), so
        // visual node radius grows relative to distances as you
        // zoom out.  To prevent overlap the simulation link distance
        // must compensate by the same factor: 1/√(scale).
        const scale = renderer.scale ?? 1;
        const zoomFactor = scale > 0.01 ? 1 / Math.sqrt(scale) : 10;

        return (2 * maxSize + this.settings.adaptiveLinkDistancePadding) * zoomFactor;
    }

    private debouncedAdaptiveLinkUpdate(renderer: any) {
        if (this._adaptiveLinkDebounceTimer !== null) {
            window.clearTimeout(this._adaptiveLinkDebounceTimer);
        }
        this._adaptiveLinkDebounceTimer = window.setTimeout(() => {
            this._adaptiveLinkDebounceTimer = null;
            if (!renderer._uncapperAdaptiveLinkPatched) return;

            const minDist = this.computeMinLinkDistance(renderer);
            const lastApplied = renderer._uncapperLastAppliedAdaptiveDist ?? 0;
            const requested = renderer._uncapperLastRequestedLinkDistance ?? 250;
            const effective = Math.max(requested, minDist);

            // Only update if distance changed meaningfully
            if (Math.abs(effective - lastApplied) > Math.max(5, lastApplied * 0.05)) {
                renderer._uncapperOriginalSetForces({ linkDistance: effective });
                renderer._uncapperLastAppliedAdaptiveDist = effective;
            }
        }, 300);
    }

    private patchAdaptiveLinkDistance(renderer: any) {
        if (renderer._uncapperAdaptiveLinkPatched) return;
        if (!renderer.setForces || typeof renderer.setForces !== "function") return;

        renderer._uncapperOriginalSetForces = renderer.setForces.bind(renderer);
        renderer._uncapperLastRequestedLinkDistance = 250;
        renderer._uncapperLastAppliedAdaptiveDist = 0;

        const plugin = this;
        renderer.setForces = function (forces: any) {
            // Track the user/system requested link distance
            if (forces?.linkDistance !== undefined) {
                renderer._uncapperLastRequestedLinkDistance = forces.linkDistance;
            }

            if (plugin.settings.adaptiveLinkDistanceEnabled && plugin.settings.nodeSizeEnabled) {
                const minDist = plugin.computeMinLinkDistance(renderer);
                const requested = forces?.linkDistance ?? renderer._uncapperLastRequestedLinkDistance ?? 250;
                const effective = Math.max(requested, minDist);
                if (effective !== requested) {
                    forces = Object.assign({}, forces, { linkDistance: effective });
                }
                renderer._uncapperLastAppliedAdaptiveDist = forces.linkDistance ?? effective;
            }

            return renderer._uncapperOriginalSetForces(forces);
        };

        renderer._uncapperAdaptiveLinkPatched = true;

        // Apply immediately with current node sizes
        const minDist = this.computeMinLinkDistance(renderer);
        const current = renderer._uncapperLastRequestedLinkDistance;
        if (current < minDist) {
            renderer._uncapperOriginalSetForces({ linkDistance: minDist });
            renderer._uncapperLastAppliedAdaptiveDist = minDist;
        }
    }

    private restoreAdaptiveLinkDistance(renderer: any) {
        if (!renderer._uncapperAdaptiveLinkPatched) return;

        if (renderer._uncapperOriginalSetForces) {
            // Restore original distance before unwrapping
            const orig = renderer._uncapperLastRequestedLinkDistance ?? 250;
            renderer._uncapperOriginalSetForces({ linkDistance: orig });
            renderer.setForces = renderer._uncapperOriginalSetForces;
        }
        delete renderer._uncapperAdaptiveLinkPatched;
        delete renderer._uncapperOriginalSetForces;
        delete renderer._uncapperLastRequestedLinkDistance;
        delete renderer._uncapperLastAppliedAdaptiveDist;
    }

    private startAdaptiveLinkInterval() {
        this.stopAdaptiveLinkInterval();
        if (!this.settings.adaptiveLinkDistanceEnabled || !this.settings.nodeSizeEnabled) return;

        // Periodically re-evaluate min distance as node data changes
        this.adaptiveLinkInterval = window.setInterval(() => {
            if (!this.settings.adaptiveLinkDistanceEnabled || !this.settings.nodeSizeEnabled) return;

            const leaves = [
                ...this.app.workspace.getLeavesOfType("graph"),
                ...this.app.workspace.getLeavesOfType("localgraph"),
            ];

            for (const leaf of leaves) {
                const renderer = (leaf.view as any)?.renderer;
                if (!renderer?._uncapperAdaptiveLinkPatched) continue;

                const minDist = this.computeMinLinkDistance(renderer);
                const lastApplied = renderer._uncapperLastAppliedAdaptiveDist ?? 0;
                const requested = renderer._uncapperLastRequestedLinkDistance ?? 250;
                const effective = Math.max(requested, minDist);

                // Only push an update if the distance actually changed
                if (Math.abs(effective - lastApplied) > 1) {
                    renderer._uncapperOriginalSetForces({ linkDistance: effective });
                    renderer._uncapperLastAppliedAdaptiveDist = effective;
                }
            }
        }, 3000);
        this.registerInterval(this.adaptiveLinkInterval);
    }

    private stopAdaptiveLinkInterval() {
        if (this.adaptiveLinkInterval !== null) {
            window.clearInterval(this.adaptiveLinkInterval);
            this.adaptiveLinkInterval = null;
        }
    }

    // ── Search Results Limit ───────────────────────────────────

    private patchSearchModals() {
        if (!this.settings.searchLimitEnabled) return;
        if (this.searchPatched) return;

        const switcher = (this.app as any).internalPlugins?.getPluginById?.(
            "switcher"
        );
        if (switcher?.instance?.QuickSwitcherModal) {
            const proto = switcher.instance.QuickSwitcherModal.prototype;
            if (proto && typeof proto.limit === "number") {
                proto.limit = this.settings.searchLimit;
            }
        }

        const plugin = this;
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (!(node instanceof HTMLElement)) continue;
                    if (
                        node.classList.contains("modal-container") ||
                        node.classList.contains("prompt")
                    ) {
                        plugin.bumpModalLimits();
                        return;
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true });
        this.register(() => observer.disconnect());
        this.searchPatched = true;
    }

    private bumpModalLimits() {
        if (!this.settings.searchLimitEnabled) return;
        const limit = this.settings.searchLimit;

        document.querySelectorAll("body > .modal-container .prompt").forEach((el) => {
            const keys = Object.getOwnPropertyNames(el);
            for (const key of keys) {
                try {
                    const val = (el as any)[key];
                    if (val && typeof val === "object" && typeof val.limit === "number" && val.limit < limit) {
                        val.limit = limit;
                    }
                } catch {
                    // skip
                }
            }
        });
    }

    // ── Font Size Limits ───────────────────────────────────────

    private patchFontSizeLimits() {
        if (!this.settings.fontSizeEnabled) return;

        const vault = this.app.vault as any;
        if (!vault._uncapperOriginalSetConfig) {
            vault._uncapperOriginalSetConfig = vault.setConfig.bind(vault);
        }

        const plugin = this;
        vault.setConfig = function (key: string, value: any) {
            if (key === "baseFontSize" && typeof value === "number") {
                value = Math.clamp(value, plugin.settings.fontSizeMin, plugin.settings.fontSizeMax);
            }
            return vault._uncapperOriginalSetConfig(key, value);
        };
    }

    private restoreFontSizeLimits() {
        const vault = this.app.vault as any;
        if (vault._uncapperOriginalSetConfig) {
            vault.setConfig = vault._uncapperOriginalSetConfig;
            delete vault._uncapperOriginalSetConfig;
        }
    }

    // ── Embed Depth ────────────────────────────────────────────

    private patchEmbedDepth() {
        if (!this.settings.embedDepthEnabled) return;

        // Obsidian has two depth checks:
        //   1. `this.embedDepth < 5` in the markdown renderer
        //   2. `e.depth <= 5` in the embed creator
        //
        // We patch the embed creator wrapper to allow higher depth values
        // through the `depth <= 5` check while preserving the actual depth
        // count for our own limit enforcement.
        const app = this.app as any;
        const registry = app.embedRegistry;
        if (!registry || registry._uncapperOriginalGetEmbedCreator) return;

        registry._uncapperOriginalGetEmbedCreator = registry.getEmbedCreator.bind(registry);
        const plugin = this;

        registry.getEmbedCreator = function (file: any) {
            const creator = registry._uncapperOriginalGetEmbedCreator(file);
            if (!creator) return creator;

            return function (ctx: any, file: any, subpath: string) {
                if (ctx && typeof ctx.depth === "number") {
                    const realDepth = ctx.depth;
                    // Only bypass the check if we're under OUR limit
                    if (realDepth > 5 && realDepth <= plugin.settings.embedDepthMax) {
                        // Temporarily set depth to pass the `<= 5` check,
                        // then restore the real value after creator runs
                        ctx.depth = 4;
                        const result = creator(ctx, file, subpath);
                        ctx.depth = realDepth;
                        return result;
                    }
                }
                return creator(ctx, file, subpath);
            };
        };

        // Also patch the `embedDepth < 5` check on markdown renderers
        // by intercepting the property on renderer prototypes
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                this.patchEmbedDepthOnViews();
            })
        );
        this.patchEmbedDepthOnViews();
    }

    private patchEmbedDepthOnViews() {
        if (!this.settings.embedDepthEnabled) return;
        const maxDepth = this.settings.embedDepthMax;

        this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
            const view = leaf.view as any;
            if (!view?.previewMode?.renderer) return;

            const renderer = view.previewMode.renderer;
            if (renderer._uncapperEmbedPatched) return;

            // Replace the embedDepth property with a getter/setter that
            // tracks the real depth but reports a value that passes
            // Obsidian's `< 5` check — as long as real depth < our max.
            const currentVal = renderer.embedDepth || 0;
            let realDepth = currentVal;

            Object.defineProperty(renderer, "embedDepth", {
                get() {
                    // The getter must return the REAL value for child
                    // assignment: `child.embedDepth = parent.embedDepth + 1`
                    // The `< 5` check is separate from the assignment.
                    return realDepth;
                },
                set(val: number) {
                    realDepth = val;
                },
                configurable: true,
            });

            renderer._uncapperEmbedPatched = true;
        });

        // The actual bypass: we need to intercept the `embedDepth < 5` check.
        // Since we can't distinguish reads for assignment vs comparison,
        // we instead rely on the getEmbedCreator wrapper above for the
        // `depth <= 5` check, and for the `embedDepth < 5` check in the
        // rendering path, we use a CSS-based approach: the rendering path
        // simply won't call the embed creator if embedDepth >= 5, so we
        // don't need to patch the renderer's check — the creator wrapper
        // handles it by temporarily lowering depth.
    }

    private restoreEmbedDepth() {
        const app = this.app as any;
        const registry = app.embedRegistry;
        if (registry?._uncapperOriginalGetEmbedCreator) {
            registry.getEmbedCreator = registry._uncapperOriginalGetEmbedCreator;
            delete registry._uncapperOriginalGetEmbedCreator;
        }
    }

    // ── Sidebar Width ──────────────────────────────────────────

    private patchSidebarWidth() {
        if (!this.settings.sidebarWidthEnabled) return;

        // The sidebar resize handler clamps width to Math.clamp(i, 200, max).
        // We inject a CSS override for the minimum width and patch the
        // resize logic via the workspace split.
        const style = document.createElement("style");
        style.id = "uncapper-sidebar-width";
        style.textContent = `
            .workspace-split.mod-left-split,
            .workspace-split.mod-right-split {
                min-width: ${this.settings.sidebarWidthMin}px !important;
            }
        `;
        // Remove old style if exists
        document.getElementById("uncapper-sidebar-width")?.remove();
        document.head.appendChild(style);
        this.register(() => document.getElementById("uncapper-sidebar-width")?.remove());

        // Patch the workspace split's setSize to allow narrower widths
        const workspace = this.app.workspace as any;
        const leftSplit = workspace.leftSplit;
        const rightSplit = workspace.rightSplit;

        for (const split of [leftSplit, rightSplit]) {
            if (!split || split._uncapperSidebarPatched) continue;

            if (typeof split.setSize === "function") {
                split._uncapperOriginalSetSize = split.setSize.bind(split);
                const plugin = this;

                split.setSize = function (size: number) {
                    // Original clamps to min 200. We allow our configured min.
                    const minW = plugin.settings.sidebarWidthMin;
                    const containerWidth = plugin.app.workspace.containerEl?.clientWidth || 1200;
                    size = Math.clamp(size, minW, Math.max(minW, 0.8 * containerWidth));
                    // Call internal resize directly
                    if (this.containerEl) {
                        this.containerEl.style.width = size + "px";
                    }
                    this.size = size;
                };

                split._uncapperSidebarPatched = true;
            }
        }
    }

    private restoreSidebarWidth() {
        document.getElementById("uncapper-sidebar-width")?.remove();

        const workspace = this.app.workspace as any;
        for (const split of [workspace.leftSplit, workspace.rightSplit]) {
            if (split?._uncapperOriginalSetSize) {
                split.setSize = split._uncapperOriginalSetSize;
                delete split._uncapperOriginalSetSize;
                delete split._uncapperSidebarPatched;
            }
        }
    }

    // ── App Zoom ───────────────────────────────────────────────

    private patchAppZoom() {
        if (!this.settings.appZoomEnabled) return;

        // The zoom slider uses setLimits(-2.5, 3, 0.5).
        // We patch the vault's font size wheel handler clamp
        // and extend the settings slider via DOM patching.
        // The actual zoom is via electron.webFrame.setZoomLevel()
        // which has no inherent limit — only the slider is capped.

        // Patch the wheel handler's clamp for baseFontSize (already handled by fontSizeLimits)
        // For zoom, we need to patch the settings appearance tab's slider
        // This is done by observing the settings modal
        const plugin = this;
        const observer = new MutationObserver(() => {
            const zoomSlider = document.querySelector(
                '.setting-item:has(.setting-item-name) input[type="range"][min="-2.5"]'
            ) as HTMLInputElement | null;
            if (zoomSlider) {
                zoomSlider.min = String(plugin.settings.appZoomMin);
                zoomSlider.max = String(plugin.settings.appZoomMax);
            }
        });
        observer.observe(document.body, { childList: true });
        this.register(() => observer.disconnect());
    }

    private restoreAppZoom() {
        // No persistent state to restore — slider patches are DOM-only
    }

    // ── Tab Size ───────────────────────────────────────────────

    private patchTabSize() {
        if (!this.settings.tabSizeEnabled) return;

        // Tab size slider uses setLimits(2, 8, 1).
        // We patch the vault setConfig to allow wider range.
        const vault = this.app.vault as any;
        const origSetConfig = vault._uncapperOriginalSetConfig || vault.setConfig.bind(vault);

        if (!vault._uncapperOriginalSetConfig) {
            vault._uncapperOriginalSetConfig = origSetConfig;
        }

        const plugin = this;
        vault.setConfig = function (key: string, value: any) {
            if (key === "baseFontSize" && typeof value === "number") {
                value = Math.clamp(value, plugin.settings.fontSizeMin, plugin.settings.fontSizeMax);
            }
            if (key === "tabSize" && typeof value === "number") {
                value = Math.clamp(value, plugin.settings.tabSizeMin, plugin.settings.tabSizeMax);
            }
            return origSetConfig(key, value);
        };

        // Also patch the slider in settings if open
        const tabSlider = document.querySelector(
            'input[type="range"][min="2"][max="8"][step="1"]'
        ) as HTMLInputElement | null;
        if (tabSlider) {
            tabSlider.min = String(this.settings.tabSizeMin);
            tabSlider.max = String(this.settings.tabSizeMax);
        }
    }

    private restoreTabSize() {
        // Font size restore already handles setConfig restoration
    }

    // ── Canvas Zoom Breakpoint ─────────────────────────────────

    private patchCanvasZoom() {
        if (!this.settings.canvasZoomEnabled) return;

        // The canvas zoom breakpoint controls when cards switch
        // from preview to edit mode. Default is derived from
        // `f5 - (options.zoomBreakpoint || 0)`.
        // We patch canvas views to override this.
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                this.patchCanvasViews();
            })
        );
        this.patchCanvasViews();
    }

    private patchCanvasViews() {
        if (!this.settings.canvasZoomEnabled) return;

        const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
        for (const leaf of canvasLeaves) {
            const view = leaf.view as any;
            if (!view?.canvas) continue;
            const canvas = view.canvas;

            if (canvas._uncapperZoomPatched) continue;

            // Override the zoomBreakpoint getter
            const origDesc = Object.getOwnPropertyDescriptor(
                Object.getPrototypeOf(canvas),
                "zoomBreakpoint"
            );

            const plugin = this;
            if (origDesc?.get) {
                canvas._uncapperOriginalZoomBP = origDesc.get;
                Object.defineProperty(canvas, "zoomBreakpoint", {
                    get() {
                        // Original returns `f5 - (options.zoomBreakpoint || 0)`
                        // We apply our offset on top
                        const original = canvas._uncapperOriginalZoomBP.call(this);
                        return original + plugin.settings.canvasZoomBreakpoint;
                    },
                    configurable: true,
                });
            } else {
                // Plain property — adjust directly
                if (typeof canvas.zoomBreakpoint === "number") {
                    canvas._uncapperOriginalZoomBPValue = canvas.zoomBreakpoint;
                    canvas.zoomBreakpoint = canvas.zoomBreakpoint + this.settings.canvasZoomBreakpoint;
                }
            }

            canvas._uncapperZoomPatched = true;
        }
    }

    private restoreCanvasZoom() {
        const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
        for (const leaf of canvasLeaves) {
            const view = leaf.view as any;
            const canvas = view?.canvas;
            if (!canvas?._uncapperZoomPatched) continue;

            if (canvas._uncapperOriginalZoomBP) {
                Object.defineProperty(canvas, "zoomBreakpoint", {
                    get: canvas._uncapperOriginalZoomBP,
                    configurable: true,
                });
                delete canvas._uncapperOriginalZoomBP;
            } else if (canvas._uncapperOriginalZoomBPValue !== undefined) {
                canvas.zoomBreakpoint = canvas._uncapperOriginalZoomBPValue;
                delete canvas._uncapperOriginalZoomBPValue;
            }
            delete canvas._uncapperZoomPatched;
        }
    }
}

// ── Settings Tab ───────────────────────────────────────────────

class UncapperSettingTab extends PluginSettingTab {
    plugin: UncapperPlugin;

    constructor(app: App, plugin: UncapperPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h1", { text: "Graph Scaler" });
        containerEl.createEl("p", {
            text: "Removes hard-coded limits from Obsidian. Enable only the features you want.",
            cls: "setting-item-description",
        });

        // ── Node Sizing ──
        this.renderSection(containerEl, "Node Sizing", "Uncaps the 30px limit on graph node sizes. More links = bigger nodes, always.");

        new Setting(containerEl)
            .setName("Enable node size uncapping")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.nodeSizeEnabled).onChange(async (v) => {
                    this.plugin.settings.nodeSizeEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.nodeSizeEnabled) {
            new Setting(containerEl)
                .setName("Scaling mode")
                .setDesc("Sqrt: fast initial growth, gentler later. Linear: steady growth per link. Both uncapped.")
                .addDropdown((dd) =>
                    dd
                        .addOption("sqrt", "Square root (recommended)")
                        .addOption("linear", "Linear")
                        .setValue(this.plugin.settings.scalingMode)
                        .onChange(async (v) => {
                            this.plugin.settings.scalingMode = v as "linear" | "sqrt";
                            await this.plugin.saveSettings();
                            this.renderPreview(containerEl.querySelector(".graph-scaler-preview")!);
                        })
                );

            new Setting(containerEl)
                .setName("Base size")
                .setDesc("Starting radius for zero-link nodes")
                .addSlider((s) =>
                    s.setLimits(2, 30, 1).setValue(this.plugin.settings.baseSize).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.baseSize = v; await this.plugin.saveSettings(); this.renderPreview(containerEl.querySelector(".graph-scaler-preview")!); })
                );

            new Setting(containerEl)
                .setName("Size per link")
                .setDesc("Growth factor per link")
                .addSlider((s) =>
                    s.setLimits(0.1, 10, 0.1).setValue(this.plugin.settings.sizePerLink).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.sizePerLink = v; await this.plugin.saveSettings(); this.renderPreview(containerEl.querySelector(".graph-scaler-preview")!); })
                );

            new Setting(containerEl)
                .setName("Minimum size")
                .setDesc("Floor radius")
                .addSlider((s) =>
                    s.setLimits(1, 10, 1).setValue(this.plugin.settings.minSize).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.minSize = v; await this.plugin.saveSettings(); this.renderPreview(containerEl.querySelector(".graph-scaler-preview")!); })
                );

            const previewEl = containerEl.createEl("div", { cls: "graph-scaler-preview" });
            this.renderPreview(previewEl);
        }

        // ── Text Fade ──
        this.renderSection(containerEl, "Text Label Visibility", "Controls when node labels appear/disappear on the graph as you zoom.");

        new Setting(containerEl)
            .setName("Enable text fade override")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.textFadeEnabled).onChange(async (v) => {
                    this.plugin.settings.textFadeEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.textFadeEnabled) {
            new Setting(containerEl)
                .setName("Label mode")
                .setDesc("Always: labels always visible. Never: labels always hidden. Custom: extended threshold range.")
                .addDropdown((dd) =>
                    dd.addOption("always", "Always visible").addOption("never", "Always hidden").addOption("custom", "Custom threshold")
                        .setValue(this.plugin.settings.textFadeMode)
                        .onChange(async (v) => { this.plugin.settings.textFadeMode = v as any; await this.plugin.saveSettings(); this.display(); })
                );

            if (this.plugin.settings.textFadeMode === "custom") {
                new Setting(containerEl)
                    .setName("Fade threshold")
                    .setDesc("Lower = labels appear at lower zoom. Default range: -3 to 3. Extended: -10 to 10.")
                    .addSlider((s) =>
                        s.setLimits(-10, 10, 0.1).setValue(this.plugin.settings.textFadeCustom).setDynamicTooltip()
                            .onChange(async (v) => { this.plugin.settings.textFadeCustom = v; await this.plugin.saveSettings(); })
                    );
            }
        }

        // ── Graph Idle Frames ──
        this.renderSection(containerEl, "Graph Animation", "Controls when the graph stops animating. Default: stops after 60 idle frames.");

        new Setting(containerEl)
            .setName("Enable idle frame override")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.idleFramesEnabled).onChange(async (v) => {
                    this.plugin.settings.idleFramesEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.idleFramesEnabled) {
            new Setting(containerEl)
                .setName("Mode")
                .setDesc("Unlimited: graph never stops animating. Custom: set your own frame limit.")
                .addDropdown((dd) =>
                    dd.addOption("unlimited", "Unlimited (never stops)").addOption("custom", "Custom frame limit")
                        .setValue(this.plugin.settings.idleFramesMode)
                        .onChange(async (v) => { this.plugin.settings.idleFramesMode = v as any; await this.plugin.saveSettings(); this.display(); })
                );

            if (this.plugin.settings.idleFramesMode === "custom") {
                new Setting(containerEl)
                    .setName("Max idle frames")
                    .setDesc("Default is 60. Higher = graph animates longer before settling.")
                    .addSlider((s) =>
                        s.setLimits(60, 3000, 10).setValue(this.plugin.settings.idleFramesMax).setDynamicTooltip()
                            .onChange(async (v) => { this.plugin.settings.idleFramesMax = v; await this.plugin.saveSettings(); })
                    );
            }
        }

        // ── Link Distance ──
        this.renderSection(containerEl, "Link Distance", "Extends the link distance slider beyond the default 30-500 cap.");

        new Setting(containerEl)
            .setName("Enable link distance uncapping")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.linkDistanceEnabled).onChange(async (v) => {
                    this.plugin.settings.linkDistanceEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.linkDistanceEnabled) {
            new Setting(containerEl)
                .setName("Max link distance")
                .setDesc("Default cap is 500")
                .addSlider((s) =>
                    s.setLimits(500, 5000, 100).setValue(this.plugin.settings.linkDistanceMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.linkDistanceMax = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Adaptive Link Distance ──
        this.renderSection(containerEl, "Adaptive Link Distance", "Scales each link's distance based on the connected nodes' sizes so large nodes never overlap. Requires Node Sizing to be enabled.");

        new Setting(containerEl)
            .setName("Enable adaptive link distance")
            .setDesc("When enabled, a link's target distance is at least the sum of both node radii plus padding.")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.adaptiveLinkDistanceEnabled).onChange(async (v) => {
                    this.plugin.settings.adaptiveLinkDistanceEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.adaptiveLinkDistanceEnabled) {
            if (!this.plugin.settings.nodeSizeEnabled) {
                const warn = containerEl.createEl("p", {
                    text: "Node Sizing must be enabled for adaptive link distance to work.",
                    cls: "setting-item-description",
                });
                warn.style.color = "var(--text-error)";
            }

            new Setting(containerEl)
                .setName("Padding")
                .setDesc("Extra distance beyond the two node radii (prevents nodes from touching edge-to-edge)")
                .addSlider((s) =>
                    s.setLimits(0, 100, 1).setValue(this.plugin.settings.adaptiveLinkDistancePadding).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.adaptiveLinkDistancePadding = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Graph Forces ──
        this.renderSection(containerEl, "Graph Forces", "Extends repel and center strength sliders for large vaults.");

        new Setting(containerEl)
            .setName("Enable force uncapping")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.forcesEnabled).onChange(async (v) => {
                    this.plugin.settings.forcesEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.forcesEnabled) {
            new Setting(containerEl)
                .setName("Max repel strength")
                .setDesc("Default cap is 20 (cubed internally)")
                .addSlider((s) =>
                    s.setLimits(20, 200, 1).setValue(this.plugin.settings.repelStrengthMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.repelStrengthMax = v; await this.plugin.saveSettings(); })
                );

            new Setting(containerEl)
                .setName("Max center strength")
                .setDesc("Default cap is 1")
                .addSlider((s) =>
                    s.setLimits(1, 20, 0.1).setValue(this.plugin.settings.centerStrengthMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.centerStrengthMax = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Embed Depth ──
        this.renderSection(containerEl, "Embed Depth", "Raises the nested embed limit from 5 levels. Allows deeper ![[transclusions]].");

        new Setting(containerEl)
            .setName("Enable embed depth extension")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.embedDepthEnabled).onChange(async (v) => {
                    this.plugin.settings.embedDepthEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.embedDepthEnabled) {
            new Setting(containerEl)
                .setName("Max embed depth")
                .setDesc("Default is 5. Be careful with high values — circular embeds can cause issues.")
                .addSlider((s) =>
                    s.setLimits(5, 50, 1).setValue(this.plugin.settings.embedDepthMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.embedDepthMax = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Sidebar Width ──
        this.renderSection(containerEl, "Sidebar Width", "Allows narrower sidebars. Default minimum is 200px.");

        new Setting(containerEl)
            .setName("Enable sidebar width override")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.sidebarWidthEnabled).onChange(async (v) => {
                    this.plugin.settings.sidebarWidthEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.sidebarWidthEnabled) {
            new Setting(containerEl)
                .setName("Minimum sidebar width (px)")
                .setDesc("Default is 200")
                .addSlider((s) =>
                    s.setLimits(50, 200, 10).setValue(this.plugin.settings.sidebarWidthMin).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.sidebarWidthMin = v; await this.plugin.saveSettings(); })
                );
        }

        // ── App Zoom ──
        this.renderSection(containerEl, "App Zoom Range", "Extends the zoom level slider beyond -2.5 to 3.");

        new Setting(containerEl)
            .setName("Enable zoom range extension")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.appZoomEnabled).onChange(async (v) => {
                    this.plugin.settings.appZoomEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.appZoomEnabled) {
            new Setting(containerEl)
                .setName("Minimum zoom level")
                .setDesc("Default is -2.5")
                .addSlider((s) =>
                    s.setLimits(-10, -2.5, 0.5).setValue(this.plugin.settings.appZoomMin).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.appZoomMin = v; await this.plugin.saveSettings(); })
                );

            new Setting(containerEl)
                .setName("Maximum zoom level")
                .setDesc("Default is 3")
                .addSlider((s) =>
                    s.setLimits(3, 10, 0.5).setValue(this.plugin.settings.appZoomMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.appZoomMax = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Tab Size ──
        this.renderSection(containerEl, "Tab Size Range", "Extends the tab size slider beyond 2-8.");

        new Setting(containerEl)
            .setName("Enable tab size range extension")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.tabSizeEnabled).onChange(async (v) => {
                    this.plugin.settings.tabSizeEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.tabSizeEnabled) {
            new Setting(containerEl)
                .setName("Minimum tab size")
                .setDesc("Default is 2")
                .addSlider((s) =>
                    s.setLimits(1, 2, 1).setValue(this.plugin.settings.tabSizeMin).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.tabSizeMin = v; await this.plugin.saveSettings(); })
                );

            new Setting(containerEl)
                .setName("Maximum tab size")
                .setDesc("Default is 8")
                .addSlider((s) =>
                    s.setLimits(8, 32, 1).setValue(this.plugin.settings.tabSizeMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.tabSizeMax = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Search Results ──
        this.renderSection(containerEl, "Search Results", "Raises the suggestion/search result cap from the default 20-100.");

        new Setting(containerEl)
            .setName("Enable search limit increase")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.searchLimitEnabled).onChange(async (v) => {
                    this.plugin.settings.searchLimitEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.searchLimitEnabled) {
            new Setting(containerEl)
                .setName("Max search results")
                .setDesc("Quick switcher and suggest modal result count")
                .addSlider((s) =>
                    s.setLimits(100, 2000, 50).setValue(this.plugin.settings.searchLimit).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.searchLimit = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Font Size ──
        this.renderSection(containerEl, "Font Size Range", "Extends the base font size beyond 10-30.");

        new Setting(containerEl)
            .setName("Enable font size range extension")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.fontSizeEnabled).onChange(async (v) => {
                    this.plugin.settings.fontSizeEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.fontSizeEnabled) {
            new Setting(containerEl)
                .setName("Minimum font size")
                .setDesc("Default is 10")
                .addSlider((s) =>
                    s.setLimits(4, 10, 1).setValue(this.plugin.settings.fontSizeMin).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.fontSizeMin = v; await this.plugin.saveSettings(); })
                );

            new Setting(containerEl)
                .setName("Maximum font size")
                .setDesc("Default is 30")
                .addSlider((s) =>
                    s.setLimits(30, 96, 1).setValue(this.plugin.settings.fontSizeMax).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.fontSizeMax = v; await this.plugin.saveSettings(); })
                );
        }

        // ── Canvas Zoom ──
        this.renderSection(containerEl, "Canvas Zoom Breakpoint", "Adjusts when canvas cards switch from preview to edit mode.");

        new Setting(containerEl)
            .setName("Enable canvas zoom breakpoint override")
            .addToggle((t) =>
                t.setValue(this.plugin.settings.canvasZoomEnabled).onChange(async (v) => {
                    this.plugin.settings.canvasZoomEnabled = v;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        if (this.plugin.settings.canvasZoomEnabled) {
            new Setting(containerEl)
                .setName("Breakpoint offset")
                .setDesc("Positive = need to zoom in more to edit. Negative = can edit at lower zoom.")
                .addSlider((s) =>
                    s.setLimits(-3, 3, 0.1).setValue(this.plugin.settings.canvasZoomBreakpoint).setDynamicTooltip()
                        .onChange(async (v) => { this.plugin.settings.canvasZoomBreakpoint = v; await this.plugin.saveSettings(); })
                );
        }
    }

    private renderSection(container: HTMLElement, title: string, desc: string) {
        const section = container.createEl("div", { cls: "graph-scaler-section" });
        section.style.marginTop = "24px";
        section.style.marginBottom = "8px";
        section.style.borderTop = "1px solid var(--background-modifier-border)";
        section.style.paddingTop = "16px";
        const h = section.createEl("h3", { text: title });
        h.style.margin = "0 0 4px 0";
        section.createEl("p", { text: desc, cls: "setting-item-description" });
    }

    private renderPreview(el: HTMLElement) {
        el.empty();
        const s = this.plugin.settings;
        const examples = [0, 1, 3, 5, 10, 25, 50, 100];

        const table = el.createEl("table", { cls: "graph-scaler-table" });
        table.style.width = "100%";
        table.style.borderCollapse = "collapse";
        table.style.marginTop = "8px";

        const header = table.createEl("tr");
        for (const h of ["Links", "Original", "Uncapped", ""]) {
            const th = header.createEl("th", { text: h });
            th.style.textAlign = "left";
            th.style.padding = "4px 8px";
            th.style.borderBottom = "1px solid var(--background-modifier-border)";
        }

        for (const w of examples) {
            const original = Math.max(8, Math.min(3 * Math.sqrt(w + 1), 30));
            const ours = this.plugin.calcSize(w);

            const row = table.createEl("tr");
            row.createEl("td", { text: String(w) }).style.padding = "4px 8px";
            row.createEl("td", { text: original.toFixed(1) }).style.padding = "4px 8px";
            row.createEl("td", { text: ours.toFixed(1) }).style.padding = "4px 8px";

            const vizCell = row.createEl("td");
            vizCell.style.padding = "4px 8px";

            const wrapper = vizCell.createEl("div");
            wrapper.style.display = "flex";
            wrapper.style.alignItems = "center";
            wrapper.style.gap = "8px";

            const origCircle = wrapper.createEl("div");
            const origD = Math.min(original, 40);
            origCircle.style.width = `${origD}px`;
            origCircle.style.height = `${origD}px`;
            origCircle.style.borderRadius = "50%";
            origCircle.style.backgroundColor = "var(--text-muted)";
            origCircle.style.opacity = "0.4";
            origCircle.style.flexShrink = "0";

            const ourCircle = wrapper.createEl("div");
            const ourD = Math.min(ours, 60);
            ourCircle.style.width = `${ourD}px`;
            ourCircle.style.height = `${ourD}px`;
            ourCircle.style.borderRadius = "50%";
            ourCircle.style.backgroundColor = "var(--interactive-accent)";
            ourCircle.style.opacity = "0.7";
            ourCircle.style.flexShrink = "0";
        }
    }
}
