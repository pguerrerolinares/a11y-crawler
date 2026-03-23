#import "theme.typ": *

#let data = json(sys.inputs.datafile)

#section-heading("Executive Summary")

// Score
#let score-color = if data.score.value > 80 { pass-color } else if data.score.value > 50 { moderate-color } else { fail-color }

#align(center)[
  #text(size: 48pt, weight: "bold", fill: score-color)[#str(data.score.value)]
  #text(size: 14pt, fill: gray-500)[#" / 100 WCAG Score"]
]

#v(16pt)

// Stats grid
#grid(
  columns: (1fr, 1fr, 1fr, 1fr, 1fr, 1fr),
  gutter: 8pt,
  ..({
    let stats = (
      (str(data.score.totalPages), "Pages"),
      (str(data.score.totalIssues), "Total Issues"),
      (str(data.score.issuesByImpact.critical), "Critical"),
      (str(data.score.issuesByImpact.serious), "Serious"),
      (str(data.score.issuesByImpact.moderate), "Moderate"),
      (str(data.score.issuesByImpact.minor), "Minor"),
    )
    stats.map(((val, label)) => box(
      fill: gray-100,
      radius: 4pt,
      inset: 10pt,
      width: 100%,
      align(center)[
        #text(size: 20pt, weight: "bold")[#val]
        #linebreak()
        #text(size: 9pt, fill: gray-500)[#label]
      ]
    ))
  })
)

#v(16pt)

#section-heading("Methodology")

The accessibility analysis was performed using a combination of automated tools and custom interactive tests:

- *axe-core* — industry-standard automated WCAG testing engine
- *Playwright* — headless browser for interactive tests (keyboard navigation, focus visibility, contrast under CVD)
- *Custom WCAG tests* — hover/focus persistence, status messages, meaningful sequence, semantic structure

Scope: WCAG 2.2 Level AA. Analysis covers #str(data.score.totalPages) pages.

#v(12pt)

#section-heading("Normative References")

- WCAG 2.2 — W3C Recommendation (October 2023)
- Ley 11/2023 — Spanish accessibility law
- RD 193/2023 — Technical requirements for public sector digital services

#v(12pt)

#section-heading("Compliance Table")

#table(
  columns: (auto, 1fr, auto, auto, auto),
  fill: (_, y) => if calc.odd(y) { gray-100 } else { white },
  table.header(
    [*WCAG*], [*Control*], [*Level*], [*Status*], [*Issues*]
  ),
  ..data.complianceTable.map(row => (
    row.criterion,
    row.name,
    row.level,
    status-badge(row.status),
    str(row.issueCount),
  )).flatten()
)
