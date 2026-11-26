# Embodied Carbon Viewer

A browser viewer that colors a Revit model by its embodied-carbon results from Tally (C.Scale), so you can spot hotspots at a glance.

- **Green** means the element stores more carbon (net biogenic storage) than it emits: CLT, glulam, hempcrete.
- **Red** means net emissions: concrete, steel, aluminum, glazing.
- **Deeper color** means a stronger value. The scale is centered at zero.
- **Hover** over any element to see a card with its type, carbon, intensity and quantities, plus a material breakdown of what drives the result. Click an element to pin its card.
- **Elements:** results are grouped into Structure, Enclosure, Interiors and Other, the way Tally reports group results, each with a subtotal. Click a system or a type to isolate it and ghost the rest of the model. **Highlight unmatched elements**, at the foot of the list, isolates elements with no results in gray. Hover one to see why it didn't match.
- **Settings** (button over the 3D view) holds the color mode, life-cycle stages, scale options and the matching and column-mapping tools.
- **Section cut:** slice the model by height to see interior elements such as cores, partitions and beams.

It opens on a demo building with synthetic data. To see your own project, load your IFC and Tally export, or drag both files onto the window.

## Run it

The app is a static site with no build step. ES modules need a server, so opening `index.html` from disk won't work. Run one of these:

```bash
python3 -m http.server 8080      # then open http://localhost:8080
# or
npx serve -l 8080 .
```

You can also host the folder on GitHub Pages. The libraries (three.js, web-ifc, SheetJS) load from jsdelivr, so the browser needs internet access.

## Getting your data out

### 1. The model: IFC from Revit

Use **File → Export → IFC**. The default settings work. Two of them matter:

- Revit writes each element's `ObjectType` as `Family:Type` and its `Tag` as the Revit **Element ID**. The viewer reads both, so leave those defaults alone.
- Export only what Tally analyzed. Filter to the 3D view you used for Tally, and turn off rooms and spaces.

Each IFC class maps to the matching Revit category (`IfcWall` → Walls, `IfcSlab` → Floors, `IfcColumn` → Structural Columns, and so on).

### 2. The results: Tally / C.Scale export

Export the type-level results as CSV or XLSX. Tally 2.0's exact column layout isn't publicly documented, so the viewer **detects columns by name**:

| Field | Recognized headers (examples) |
| --- | --- |
| Category | `Revit Category`, `Category` |
| Family | `Revit Family`, `Family` |
| Type | `Revit Type`, `Type`, `Type Name` |
| Family and Type (combined) | `Family and Type` (split on the first `:`) |
| Element ID (optional, per-element exports) | `Element ID`, `Revit ID` |
| Material (optional, layer breakdown) | `Material`, `Material Name`, `Tally Entry` |
| GWP by stage, wide layout | `GWP A1-A3 …`, `Global Warming … A4`, `… Module D`, `… End of Life` |
| GWP by stage, long layout | a `Life Cycle Stage` column plus one GWP value column |
| Biogenic carbon (optional) | anything containing `biogenic` |
| Building system (optional) | `Building System`, `System`, `Building Element` |

The parser ignores title rows above the header. For a workbook, it picks the sheet that looks most like a results table. If detection gets something wrong, open **Settings › Matching & columns** and re-map the columns by hand.

`sample/sample-tally.csv` shows the expected shape.

### C.Scale project-data exports

The viewer also reads the workbook C.Scale exports (Project Summary, Category by Stage, Time Series, Takeoffs). These group results by C.Scale building subsection, such as "Enclosure > Exterior Walls", not by Revit type, so matching works differently:

- Each element is matched to a subsection by its Revit category and type name. Footings go to Foundations, floors to Slabs/Decks (or Slabs-on-Grade if the type name says grade), columns and beams to Slabs/Decks, exterior walls to Exterior Walls, and so on.
- If a subsection holds more than one assembly (say a rainscreen wall and a brick wall under Exterior Walls), each element goes to the assembly whose name and materials share the most keywords with its Revit type name. Common synonyms are recognized, such as GWB/gypsum, CMU/masonry, IGU/glazing and CLT/cross-laminated timber. Elements with no keyword match take whichever assemblies no element claimed.
- Rows with no assembly name (typical for structure) are split by material instead, with rebar kept alongside its concrete. An element goes to the material its type name mentions (a "Concrete Slab 4\"" floor takes the concrete). If the name doesn't help, the category decides: floors take slab materials (CLT, concrete, plywood), and columns and beams take framing materials (GLT, structural steel).
- A type name that names a material only matches that material. In a scenario with no concrete in Slabs/Decks, a "Concrete Slab 6\"" floor stays unmatched, and its card says why. It never borrows plywood or CLT just because those are slab materials too. Material families checked: concrete, steel, wood, masonry, aluminum, glass. This applies to bare materials only. For multi-layer assemblies, type names often mention context, as in "Rainscreen (for Concrete Core Walls)".
- Otherwise every element in a subsection gets the same intensity.
- Subsections that C.Scale quantifies per ft² or m² (walls, roofs, ceilings, flooring, glazing) are split across elements by face area. The rest are split by volume.
- Takeoffs give one whole-life total per material. The viewer splits it across life-cycle stages using that category's proportions in Category by Stage.
- Stored carbon is reported once per scenario, with no breakdown by material. The viewer shows it in Summary as "Biogenic storage · not itemized" and doesn't assign it to any element, so the model shows emissions only.
- Operational energy is left out. Construction activities, demolition, refrigerants and services show under unmatched results.
- A scenario with no takeoffs is matched by category only (Structure, Enclosure, Interiors).

## Scenarios

If the export has more than one scenario (a C.Scale workbook, or any export with a `Scenario` or `Design Option` column), a Scenario selector appears above the summary. Switching scenarios recolors the model and updates every total.

## Building systems

If the export has a building-system column, the viewer uses it. Otherwise it assigns each type from its Revit category:

- **Structure:** structural foundations, columns, framing and rebar; floors; walls whose type name says core, shear, structural or retaining.
- **Enclosure:** roofs, curtain walls, curtain panels, mullions and windows; walls and doors whose type name says ext, exterior, facade, cladding or veneer.
- **Interiors:** all other walls and doors, plus ceilings, stairs, railings, casework and furniture.
- **Other:** anything else, such as generic models.

## How results are joined to elements

1. **Element ID**: used when the export has per-element rows.
2. **Category + Family + Type**: the normal case. Each Revit wall type, such as `Basic Wall: Ext - CLT 120 + Wood Fiber 160`, stays distinct.
3. **Family + Type**: used if the category doesn't line up, but only when that pair is unique.
4. **Type name alone**: the last resort, also only when the name is unique.

Names are compared case-insensitively, with whitespace and dash variants normalized. The hover card says when an element matched on a weaker rule.

**Settings › Matching & columns** also lists model types with no results and result types with no model elements. Renamed types and elements left out of the Tally run turn up there.

## What the colors mean

| Mode | Value per element |
| --- | --- |
| **Total** | Type result × (element volume ÷ total volume of that type's elements). Big elements read hotter. |
| **per m²** | Type result ÷ total face area of the type's elements. Compares walls, floors and roofs fairly. |
| **per m³** | Type result ÷ total volume of the type's elements. Suits columns, beams and foundations. |

The viewer measures volume and face area from the mesh. Face area is the largest set of parallel faces, which is exact for walls and slabs and rough for anything else.

- **Life-cycle stages:** toggle which modules count. Module D is off by default, as EN 15978 reports it separately.
- **Biogenic storage:** included by default. Turn it off if your export already nets biogenic carbon into GWP, or to see fossil emissions only.
- **Outlier clipping:** off by default, so the legend runs to the true maximum. In Settings you can cap each side of the scale at a percentile, so one huge slab doesn't wash out everything else. Elements past the cap show at full color.
- **Same scale:** by default, green and red scale independently, so storage stays visible next to large emissions. Tick this to put both on one scale for a like-for-like comparison.

## Versioning

The git tag is the version. The subtitle under the title shows it, read from `src/version.js`. That file is written by the release script, so it always matches the tag on the same commit. Commit and tag with:

```bash
node tools/release.mjs patch "What changed"   # v0.1.0 -> v0.1.1
node tools/release.mjs minor "What changed"   # v0.1.3 -> v0.2.0
node tools/release.mjs major "What changed"   # v0.4.2 -> v1.0.0
git push --follow-tags
```

Commits made without the script show the previous release's version until the next release.

## Files

```
index.html               page + import map
src/main.js              scene, matching, coloring, hover card, sidebar
src/data.js              CSV/XLSX reading, column detection, per-type aggregation
src/model.js             IFC → meshes (web-ifc), demo model, volume/area measurement
src/color.js             diverging green–red scale
src/demo-building.js     the procedural demo building + its material build-ups
tools/make-samples.mjs   regenerates sample/sample-tally.csv and sample/demo-building.ifc
sample/                  synthetic sample export + matching IFC (not real LCA data)
```

Run `node tools/make-samples.mjs` to regenerate the samples after editing the demo building.

## Next steps

- **Test against a real Tally 2.0 export.** The column detection is a best guess. One real file will confirm it or show what to add.
- **Write kgCO₂e onto elements in Revit:** a Dynamo or pyRevit script sets a shared parameter before IFC export. Results then travel with the model and need no name matching.
- **Pull results live** from C.Scale's API instead of a file, once its details are available.
- **Bigger models:** merge meshes per type and use instancing above roughly 10k elements.
