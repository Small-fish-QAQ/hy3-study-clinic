# Visual resources

Study Clinic uses pine-green navigation, ivory surroundings and opaque reading surfaces. Decorative textures stay behind content and do not carry learning-state meaning.

| Asset or implementation                                   | Role                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [backgrounds](../apps/web/public/backgrounds)             | Shared reading light, paper fiber and restrained curve motifs.                         |
| [studio.css](../apps/web/src/studio.css)                  | Surface colors, background layering, responsive placement and accessibility fallbacks. |
| [fonts](../apps/web/public/fonts/README.md)               | Bundled font files and license attribution.                                            |
| [Tabler icons](../apps/web/public/icons/tabler/README.md) | Icon source and license attribution.                                                   |

The shipped brand and background artwork includes AI-generated raster assets. The screenshot gallery uses actual product captures; it is not generated concept art.

The environmental motif is used around course cards, home, materials, curriculum and progress. Study, settings and the Knowledge Map use the quieter reading background. Decorative images are disabled for print, forced colors and increased-contrast modes; solid colors remain as fallbacks.

Exploration prompts, discarded candidates and local browser logs are not needed to use these assets. Git history retains the earlier design notes. Current product screenshots and their provenance are in [DEMO.md](DEMO.md).

The current [competition overview](media/competition/competition-overview.svg) uses warm ivory, deep pine and sage. It prioritizes formal StudyEval validation, identifies the 12 product journeys as selected content-audited examples, and places the full 20-course reliability audit in a secondary block. [PNG](media/competition/competition-overview.png), [saved-source and asset hashes](media/competition/manifest.json), and [Matplotlib renderer](media/competition/render-overview.py) are available together. The renderer reads sealed result JSON; it does not score or alter evidence.

To regenerate this presentation with Python 3.12 and Matplotlib 3.11.2, run `python docs/media/competition/render-overview.py` from the repository root. The figure generator checks text bounds and overlaps. The older unreferenced overview was removed; historical numerical evidence and source screenshots remain preserved.
