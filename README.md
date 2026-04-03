# Graph Scaler

An Obsidian plugin that removes hard-coded limits from across the app. 12 independently togglable features — enable only what you want.

## Features

All features are off by default except Node Sizing.

| Feature | Default Limit | Uncapped To |
|---|---|---|
| **Node Sizing** | 30px cap on graph nodes | No cap — more links = bigger nodes |
| **Text Label Visibility** | Fade threshold -3 to 3 | -10 to 10, or always/never |
| **Graph Animation** | Stops after 60 idle frames | Unlimited or custom threshold |
| **Link Distance** | Slider max 500 | Up to 5000 |
| **Graph Forces** | Repel max 20, Center max 1 | Up to 200 / 20 |
| **Embed Depth** | 5 nested `![[embeds]]` | Up to 50 |
| **Sidebar Width** | Minimum 200px | Down to 50px |
| **App Zoom** | -2.5 to 3.0 | -10 to 10 |
| **Tab Size** | 2 to 8 | 1 to 32 |
| **Canvas Zoom Breakpoint** | Fixed threshold | Adjustable offset |
| **Search Results** | 20-100 results | Up to 2000 |
| **Font Size** | 10 to 30 | 6 to 96 |

## How it works

The plugin monkey-patches Obsidian's internal methods at runtime. All patches are saved and restored cleanly on plugin unload — no permanent modifications.

For example, the built-in graph node sizing formula is:

```
fNodeSizeMult * Math.max(8, Math.min(3 * Math.sqrt(weight + 1), 30))
```

The `Math.min(..., 30)` is a hard cap — nodes with 100+ links look the same as nodes with 10 links. This plugin replaces `getSize()` with an uncapped version that reads the node's `weight` (link count) live.

## Node Sizing Modes

- **Square root** (default): `baseSize + sizePerLink * sqrt(weight)` — fast initial growth, moderates but never caps
- **Linear**: `baseSize + weight * sizePerLink` — steady growth, can get dramatic for hub nodes

## Installation

### Manual

1. Download the latest release (`main.js`, `manifest.json`)
2. Create `<vault>/.obsidian/plugins/graph-scaler/`
3. Copy both files into that directory
4. Enable "Graph Scaler" in Settings > Community Plugins

### From source

```bash
git clone https://github.com/Blakethefn/obsidian-graph-scaler.git
cd obsidian-graph-scaler
npm install
npm run build
```

Then copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/graph-scaler/` directory.

## Settings

All settings are accessible in Settings > Graph Scaler. Each feature section has an enable toggle — disabled features have zero runtime cost.

## License

MIT
