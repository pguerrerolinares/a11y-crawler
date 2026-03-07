# Web Page Representation for LLM Agents: Research Survey

> Context: Choosing how to represent a web page when sending it to an LLM for navigation/discovery.
> Relevant for our a11y crawler: what to send to the LLM so it identifies interactive navigation elements.

---

## The 3 Modalities

### 1. Raw HTML / DOM

Send the page's HTML (or a pruned version) as text.

**Pros:**
- Contains ALL elements, including hidden ones
- Preserves structure, attributes, ARIA roles
- Cheapest in terms of infrastructure (no rendering needed)

**Cons:**
- Huge token count - a real page can have thousands of elements
- Noisy: scripts, styles, ads, tracking pixels
- LLMs struggle with deeply nested, verbose HTML

**Pruning strategies:**
- Strip `<script>`, `<style>`, SVGs, comments
- Keep only elements with interactive roles (`<a>`, `<button>`, `[role="menuitem"]`, etc.)
- Limit depth or element count

**Used by:** Early web agents, Mind2Web (pruned HTML)

### 2. Accessibility Tree

The browser's accessibility tree - a simplified structural view used by screen readers. Playwright exposes it via `page.accessibility.snapshot()`.

**Pros:**
- Much smaller than full HTML (10-50x reduction)
- Focuses on interactive/meaningful elements
- Includes computed roles, names, states
- Already structured for navigation purposes

**Cons:**
- May be incomplete on sites with poor accessibility (ironic for our use case - we're testing sites that likely HAVE a11y issues)
- Doesn't capture visual layout
- Some frameworks generate poor accessibility trees

**Used by:** WorkArena, BrowserGym, many production browser agents

**Example output:**
```
- navigation "Main Menu"
  - link "Home"
  - button "Services" expanded=false
  - link "About Us"
  - link "Contact"
```

### 3. Screenshot (Vision)

Take a screenshot, optionally annotate it with bounding boxes (Set-of-Mark), send to a vision-capable LLM.

**Pros:**
- Captures visual layout exactly as users see it
- Works regardless of HTML quality
- Can identify elements by appearance even without proper HTML roles
- Set-of-Mark (SoM) annotation adds numbered labels to clickable elements

**Cons:**
- Requires vision-capable model (more expensive)
- Struggles with small elements and precise positioning
- Doesn't work with canvas-based UIs (Google Sheets, Figma)
- Higher latency

**Used by:** WebVoyager, OmniParser

---

## Key Papers

### Mind2Web (NeurIPS 2023 Spotlight)
- **Source:** https://osu-nlp-group.github.io/Mind2Web/
- **Paper:** https://proceedings.neurips.cc/paper_files/paper/2023/file/5950bf290a1570ea401bf98882128160-Paper-Datasets_and_Benchmarks.pdf
- **Key insight:** Full HTML is too large for LLM context. They prune HTML to relevant elements using a candidate generation step (small model ranks elements, then LLM reasons over top candidates).
- **Dataset:** 2,350 tasks across 137 websites, 31 domains.
- **Relevance for us:** Demonstrates that HTML pruning is essential. Their two-stage approach (filter then reason) could inspire our design.

### WebVoyager (arXiv 2401.13919, Jan 2024)
- **Source:** https://arxiv.org/abs/2401.13919
- **Key insight:** Uses Set-of-Mark (SoM) - overlays numbered bounding boxes on interactive elements in screenshots, then sends annotated screenshot to GPT-4V.
- **Result:** 59.1% task success rate on real websites.
- **Relevance for us:** Screenshot + SoM is powerful but expensive. Good fallback for pages where HTML/a11y tree is insufficient.

### OmniParser (Microsoft, arXiv 2408.00203, Aug 2024)
- **Source:** https://arxiv.org/abs/2408.00203
- **GitHub:** https://github.com/microsoft/OmniParser
- **Key insight:** Parses screenshots into structured GUI elements (buttons, images, inputs with their roles) using fine-tuned detection + caption models. Then feeds structured data to LLM.
- **Result:** Screenshot-only input outperforms GPT-4V baselines that use additional information beyond screenshots on Mind2Web and AITW benchmarks.
- **Relevance for us:** Shows that pure vision can work, but requires specialized models (not just sending a raw screenshot to an LLM).

### AWM - Agent Workflow Memory (arXiv 2409.07429, Sep 2024)
- **Source:** https://arxiv.org/pdf/2409.07429
- **Key insight:** Compares DOM-based (SteP) vs vision-based (AWM) approaches. Vision-based is more resilient when HTML is not passed at every step. AWM achieves higher efficiency with longer prompts but fewer API calls.
- **Relevance for us:** Supports the hybrid approach - use DOM/a11y tree as primary, vision as fallback.

### MultiUI (ICLR 2025)
- **Source:** https://openreview.net/pdf/8a47ca1cdd16087d5699dc56b4a192cf621bea9e.pdf
- **Key insight:** Uses screenshots + enhanced accessibility trees together. Notes that converting screenshots to simplified HTML "imposes rigid formats that limit generalization across domains."
- **Relevance for us:** Strongest evidence for combining modalities.

### Building Browser Agents: Architecture, Security, and Practical Solutions (Nov 2025)
- **Source:** https://arxiv.org/html/2511.19477v1
- **Key insight:** Hybrid context management combining accessibility tree snapshots with selective vision achieved ~85% success rate on WebGames benchmark. Recommends accessibility tree as PRIMARY context, vision as SELECTIVE supplement.
- **Relevance for us:** Most practical, production-oriented guidance.

### Automated LLM-Based Accessibility Remediation (Univ. de Malaga, Feb 2026)
- **Source:** https://arxiv.org/abs/2602.17887
- **Authors:** Carla Fernandez-Navarro, Francisco Chicano (Universidad de Malaga)
- **What it does:** Not solo discovery - it **detects AND fixes** a11y violations automatically. Pipeline de 4 fases:
  1. **Detection:** Selenium renderiza la pagina + inyecta axe-core para detectar violaciones
  2. **Visual Analysis:** Screenshots en 3 viewports (mobile, tablet, desktop) + genera descripciones de imagenes
  3. **Prompt Construction:** Construye prompts con fragmentos HTML de la violacion + screenshots + metadata de axe-core
  4. **Remediation:** LLM genera HTML corregido, se aplica al DOM (sitios estaticos) o al source code (Angular SPAs)
- **Representacion para el LLM:** Multimodal - fragmentos HTML de la violacion (NO pagina completa) + screenshots por viewport + datos de axe-core. No hace pruning explicito; extrae solo los nodos con violaciones.
- **LLM:** OpenAI GPT-4o (vision para screenshots, text para remediacion). 9 prompts especializados (contraste, ARIA, semantica, etc.)
- **Handling SPAs (Angular):** Parsea `angular.json`, trabaja con triplets de componentes (template HTML + TypeScript + CSS). Usa AST para inyectar fixes en source code. Valida con `ng build --configuration production`.
- **NO hace crawling/discovery** - el usuario proporciona las URLs. Este es el gap que nosotros llenamos.
- **Resultados:**
  - Sitios estaticos: **80.35%** tasa de remediacion (8/12 sitios al 100%)
  - Angular SPAs: **86.04%** (100% build integrity - nunca rompe el build)
  - Tiempo: ~15-17 min por sitio
- **WCAG coverage:** Level A completo + 5 criterios AA (Reflow, Multiple Ways, Device Independence, Language of Parts, Consistent Navigation)
- **Limitaciones:** Legacy HTML con tablas anidadas (~24% remediacion), widgets de terceros complejos, bindings dinamicos en SPAs
- **Relevance for us:**
  - Confirma que fragmentos HTML + screenshots es mejor que HTML completo
  - Su fase de deteccion (Selenium + axe-core) es casi identica a lo que planeamos
  - **Oportunidad:** Nuestro crawler llena su gap (no tiene discovery) y su remediador llena el nuestro (no tenemos fix). Podrian ser complementarios o fusionarse.
  - El enfoque de prompts especializados por tipo de violacion es mas efectivo que un prompt generico

---

## Consensus (2024-2026)

The research converges on a **tiered/hybrid approach**:

1. **Primary: Accessibility Tree** - lightweight, structured, good enough for 80%+ of cases
2. **Secondary: Pruned HTML** - when a11y tree is insufficient (poor accessibility, complex structures)
3. **Fallback: Screenshot + Vision** - for visually complex or canvas-based UIs

No single modality wins. The best agents combine them.

---

## Recommendation for Our Crawler

Given our specific use case (discovering navigation on arbitrary sites for accessibility testing):

### Proposed Strategy: Tiered Representation

```
Step 1: Get accessibility tree (cheap, fast)
  |
  v
Step 2: If tree has navigation elements -> send to LLM for analysis
  |     If tree is sparse/empty -> fall back to pruned HTML
  v
Step 3: LLM returns selectors to click
  |
  v
Step 4: Click, discover new URLs, repeat
```

### Why this works for us:

- **A11y tree first** is ironic but pragmatic - if the site has good accessibility, the tree gives us clean navigation structure cheaply
- **Pruned HTML fallback** catches sites with poor a11y tree (which are exactly the sites we're auditing)
- **No vision needed for v1** - navigation elements are virtually always in the DOM, just might need interaction to reveal sub-items
- **Cost-efficient** - a11y tree is ~100-500 tokens vs 5,000-50,000 for full HTML vs ~1,000+ tokens for vision

### Token budget estimate (per page):
| Modality | Tokens | Cost (Moonshot) |
|----------|--------|-----------------|
| A11y tree | 100-500 | Minimal |
| Pruned HTML | 1,000-5,000 | Low |
| Screenshot | 1,000-2,000 | Medium (needs vision model) |
| Full HTML | 10,000-50,000 | High |
